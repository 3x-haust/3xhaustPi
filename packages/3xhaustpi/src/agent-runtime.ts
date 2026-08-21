import { randomUUID } from "node:crypto";
import { join } from "node:path";
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
	readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	readonly signal?: AbortSignal;
	readonly onEvent: (event: CodingTaskEvent) => void;
	readonly requestApproval?: (proposal: CodingTaskPatchProposal) => Promise<boolean>;
}

export interface AgentTaskResult {
	readonly sessionId: string;
	readonly outcome: "completed" | "aborted";
	readonly usage: CodingTaskUsage;
}

function usageOf(message: {
	usage?: { input?: number | null; output?: number | null; cacheRead?: number | null };
}): CodingTaskUsage {
	const usage = message.usage ?? {};
	return {
		input: usage.input ?? null,
		output: usage.output ?? null,
		cacheRead: usage.cacheRead ?? null,
	};
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
	const sessionId = `session_${randomUUID()}`;
	const sessionManager = SessionManager.create(request.projectRoot, join(getAgentDir(), "sessions"));
	const requestedThinking = request.thinkingLevel ?? services.settingsManager.getDefaultThinkingLevel() ?? "medium";
	const { session } = await createAgentSessionFromServices({
		services,
		sessionManager,
		model,
		...(requestedThinking !== "off" ? { thinkingLevel: requestedThinking } : {}),
	});

	request.onEvent({
		type: "session.started",
		sessionId,
		provider: model.provider,
		model: model.id,
		objective: request.objective,
	});

	let lastUsage: CodingTaskUsage = { input: null, output: null, cacheRead: null };
	const startedAt = performance.now();
	const unsubscribe = session.subscribe((event) => {
		if (
			event.type === "message_update" &&
			event.message.role === "assistant" &&
			event.assistantMessageEvent.type === "text_delta"
		) {
			request.onEvent({ type: "assistant.delta", text: event.assistantMessageEvent.delta });
			return;
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			lastUsage = usageOf(event.message);
			request.onEvent({
				type: "model.completed",
				responseId: `response_${randomUUID()}`,
				usage: lastUsage,
				durationMs: performance.now() - startedAt,
			});
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
	}
	const aborted = request.signal?.aborted ?? false;
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
