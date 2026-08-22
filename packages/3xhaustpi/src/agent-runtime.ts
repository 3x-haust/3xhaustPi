import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import {
	type AgentSessionServices,
	createAgentSessionFromServices,
	createAgentSessionServices,
	getAgentDir,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { CodingTaskEvent, CodingTaskPatchProposal, CodingTaskUsage } from "./coding-runtime.ts";
import { createCredentialStore } from "./provider-runtime.ts";

export interface AgentTaskRequest {
	readonly projectRoot: string;
	readonly objective: string;
	readonly provider?: string;
	readonly model?: string;
	readonly sessionId?: string;
	readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	readonly signal?: AbortSignal;
	readonly onEvent: (event: CodingTaskEvent) => void;
	readonly requestApproval?: (proposal: CodingTaskPatchProposal) => Promise<boolean>;
	readonly onProviderPayload?: (payload: unknown) => void;
}

export interface AgentTaskResult {
	readonly sessionId: string;
	readonly outcome: "completed" | "aborted";
	readonly usage: CodingTaskUsage;
}

export class AgentSessionNotFoundError extends Error {
	readonly sessionId: string;

	constructor(sessionId: string) {
		super(`Agent session not found for this project: ${sessionId}`);
		this.name = "AgentSessionNotFoundError";
		this.sessionId = sessionId;
	}
}

function usageOf(message: {
	usage?: { input?: number | null; output?: number | null; cacheRead?: number | null; cacheWrite?: number | null };
}): CodingTaskUsage {
	const usage = message.usage ?? {};
	return {
		input: usage.input ?? null,
		output: usage.output ?? null,
		cacheRead: usage.cacheRead ?? null,
		cacheWrite: usage.cacheWrite ?? null,
	};
}

export function providerCacheAffinity(projectRoot: string, provider: string, model: string): string {
	const digest = createHash("sha256").update(`${projectRoot}\0${provider}\0${model}`).digest("hex").slice(0, 32);
	return `3xhaustpi_${digest}`;
}

export function cacheRoutingOptions(
	cacheAffinity: string,
	systemPrompt: string | undefined,
): {
	readonly cacheRetention: "short" | "long";
	readonly sessionId: string;
	readonly promptCacheKey: string;
} {
	const isCompaction = systemPrompt?.startsWith("You are a context summarization assistant.") ?? false;
	const key = isCompaction ? `${cacheAffinity}_compaction` : cacheAffinity;
	return {
		cacheRetention: isCompaction ? "short" : "long",
		sessionId: key,
		promptCacheKey: key,
	};
}

export async function openAgentSessionManager(
	projectRoot: string,
	requestedSessionId: string | undefined,
	sessionDir = join(getAgentDir(), "sessions"),
): Promise<SessionManager> {
	if (!requestedSessionId) return SessionManager.create(projectRoot, sessionDir);
	const match = (await SessionManager.list(projectRoot, sessionDir)).find(({ id }) => id === requestedSessionId);
	if (!match) throw new AgentSessionNotFoundError(requestedSessionId);
	return SessionManager.open(match.path, sessionDir, projectRoot);
}

/**
 * Full pi-mono agent runtime behind the TUI's CodingTaskEvent contract.
 * Replaces the narrow semantic two-turn protocol with a real AgentSession:
 * thinking levels, tool loop, session persistence, and compaction all come
 * from the coding-agent backbone.
 */
export async function runAgentTask(request: AgentTaskRequest): Promise<AgentTaskResult> {
	const modelRuntime = await ModelRuntime.create({
		credentials: createCredentialStore(),
	});
	const services: AgentSessionServices = await createAgentSessionServices({
		cwd: request.projectRoot,
		modelRuntime,
	});
	const available = await services.modelRuntime.getAvailable(request.provider);
	if (available.length === 0) throw new Error(`Provider is not authenticated: ${request.provider ?? "default"}`);
	const model =
		available.find((candidate) => candidate.id === request.model) ??
		available.find((candidate) => candidate.provider === request.provider) ??
		available[0]!;
	const sessionManager = await openAgentSessionManager(request.projectRoot, request.sessionId);
	const sessionId = sessionManager.getSessionId();
	const requestedThinking = request.thinkingLevel ?? services.settingsManager.getDefaultThinkingLevel() ?? "medium";
	const { session } = await createAgentSessionFromServices({
		services,
		sessionManager,
		model,
		...(requestedThinking !== "off" ? { thinkingLevel: requestedThinking } : {}),
	});
	const cacheAffinity = providerCacheAffinity(request.projectRoot, model.provider, model.id);
	const baseStream = session.agent.streamFunction;
	session.agent.streamFunction = (requestModel, context, options) => {
		const previousOnPayload = options?.onPayload;
		return baseStream(requestModel, context, {
			...options,
			...cacheRoutingOptions(cacheAffinity, context.systemPrompt),
			...(requestModel.api === "openai-codex-responses" ? { transport: "websocket" as const } : {}),
			onPayload: async (payload, payloadModel) => {
				request.onProviderPayload?.(payload);
				return previousOnPayload?.(payload, payloadModel);
			},
		});
	};

	request.onEvent({
		type: "session.started",
		sessionId,
		provider: model.provider,
		model: model.id,
		objective: request.objective,
	});

	let lastUsage: CodingTaskUsage = { input: null, output: null, cacheRead: null, cacheWrite: null };
	let assistantStartedAt: number | undefined;
	let assistantElapsedMs = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "message_start" && event.message.role === "assistant") {
			assistantStartedAt = performance.now();
			return;
		}
		if (event.type === "message_update" && event.message.role === "assistant") {
			const update = event.assistantMessageEvent;
			if (update.type === "text_delta") {
				request.onEvent({ type: "assistant.delta", text: update.delta });
			}
			return;
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			if (assistantStartedAt !== undefined) {
				assistantElapsedMs += Math.max(0, performance.now() - assistantStartedAt);
			}
			const usage = usageOf(event.message);
			inputTokens += usage.input ?? 0;
			outputTokens += usage.output ?? 0;
			cacheReadTokens += usage.cacheRead ?? 0;
			cacheWriteTokens += usage.cacheWrite ?? 0;
			lastUsage = {
				input: inputTokens,
				output: outputTokens,
				cacheRead: cacheReadTokens,
				cacheWrite: cacheWriteTokens,
			};
			assistantStartedAt = undefined;
			return;
		}
		if (event.type === "tool_execution_start") {
			request.onEvent({ type: "capability.started", capability: event.toolName });
			return;
		}
		if (event.type === "tool_execution_end") {
			request.onEvent({
				type: "capability.completed",
				capability: event.toolName,
				success: !event.isError,
				durationMs: 0,
				summary: `${event.toolName} ${event.isError ? "failed" : "done"}`,
			});
		}
	});
	const onAbort = () => {
		session.abort();
	};
	request.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		await session.prompt(request.objective);
	} finally {
		request.signal?.removeEventListener("abort", onAbort);
		unsubscribe();
		session.dispose();
		cleanupSessionResources(cacheAffinity);
		cleanupSessionResources(`${cacheAffinity}_compaction`);
	}
	const aborted = request.signal?.aborted ?? false;
	if (outputTokens > 0 && assistantElapsedMs > 0) {
		request.onEvent({
			type: "model.completed",
			responseId: `response_${randomUUID()}`,
			usage: lastUsage,
			durationMs: assistantElapsedMs,
		});
	}
	request.onEvent({
		type: "session.completed",
		sessionId,
		outcome: aborted ? "rejected" : "completed",
		decision: aborted ? "aborted" : "completed",
		usage: lastUsage,
	});
	return { sessionId, outcome: aborted ? "aborted" : "completed", usage: lastUsage };
}

export type { ModelRuntime } from "@earendil-works/pi-coding-agent";
