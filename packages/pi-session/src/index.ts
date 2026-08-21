import {
	AgentHarness,
	type AgentHarnessEvent,
	type AgentHarnessTool,
	InMemorySessionStorage,
	Session,
} from "@earendil-works/pi-agent-core";
import type { CacheRetention, ImageContent, Model, Models } from "@earendil-works/pi-ai";
import { type ThreeXhaustSessionMetrics, ThreeXhaustSessionMetricsCollector } from "./metrics.ts";

export {
	summarizeThreeXhaustBenchmark,
	type ThreeXhaustBenchmarkInput,
	type ThreeXhaustBenchmarkReport,
	type ThreeXhaustBenchmarkScenario,
} from "./benchmark.ts";
export type { ThreeXhaustSessionMetrics } from "./metrics.ts";

export {
	type CreateThreeXhaustSemanticSessionInput,
	createThreeXhaustSemanticSession,
	parseSemanticEnvelope,
	type SemanticEnvelope,
	type SemanticRequest,
	ThreeXhaustSemanticSession,
} from "./semantic.ts";

export const X3HAUST_SESSION_BRIDGE_VERSION = 1 as const;

const BROKERED_TOOL_NAME = /^(workspace|patch|command|git|browser|computer)\.[a-z][a-z0-9-]*$/;
const AMBIENT_TOOL_NAMES = new Set(["bash", "edit", "read", "write", "grep", "find", "ls"]);

export interface ThreeXhaustToolContext {
	readonly projectId: string;
	readonly connectionBindingId: string;
	readonly turnId: string;
}

export type ThreeXhaustBrokeredTool = AgentHarnessTool<ThreeXhaustToolContext>;

export interface CreateThreeXhaustSessionInput {
	readonly bridgeVersion: typeof X3HAUST_SESSION_BRIDGE_VERSION;
	readonly models: Models;
	readonly model: Model<any>;
	readonly systemPrompt: string;
	readonly tools: readonly ThreeXhaustBrokeredTool[];
	readonly allowedToolNames: readonly string[];
	readonly toolContext: () => ThreeXhaustToolContext;
	readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	readonly cacheRetention?: CacheRetention;
}

export function validateBrokeredTools(
	tools: readonly ThreeXhaustBrokeredTool[],
	allowedToolNames: readonly string[],
): string[] {
	const allowed = new Set(allowedToolNames);
	if (allowed.size !== allowedToolNames.length) throw new Error("Allowed tool names must be unique");

	const names = tools.map((tool) => tool.name);
	if (new Set(names).size !== names.length) throw new Error("Brokered tool names must be unique");
	if (names.length !== allowed.size) throw new Error("Every allowed tool must have exactly one implementation");

	for (const name of names) {
		if (AMBIENT_TOOL_NAMES.has(name) || !BROKERED_TOOL_NAME.test(name)) {
			throw new Error(`Tool is not brokered by 3xhaustPi: ${name}`);
		}
		if (!allowed.has(name)) throw new Error(`Tool is outside the explicit allowlist: ${name}`);
	}

	return [...names].sort((left, right) => left.localeCompare(right));
}

export class ThreeXhaustPiSession {
	readonly bridgeVersion = X3HAUST_SESSION_BRIDGE_VERSION;
	readonly activeToolNames: readonly string[];
	readonly #harness: AgentHarness<ThreeXhaustToolContext>;
	readonly #storage: InMemorySessionStorage;
	readonly #metrics = new ThreeXhaustSessionMetricsCollector();

	constructor(input: CreateThreeXhaustSessionInput) {
		if (input.bridgeVersion !== X3HAUST_SESSION_BRIDGE_VERSION)
			throw new Error("Unsupported 3xhaustPi session bridge version");
		if (!input.systemPrompt.trim()) throw new Error("3xhaustPi system prompt must not be empty");

		const activeToolNames = validateBrokeredTools(input.tools, input.allowedToolNames);
		this.#storage = new InMemorySessionStorage();
		const session = new Session(this.#storage);
		this.#harness = new AgentHarness<ThreeXhaustToolContext>({
			session,
			models: input.models,
			model: input.model,
			systemPrompt: input.systemPrompt,
			tools: [...input.tools],
			activeToolNames,
			resources: { promptTemplates: [], skills: [] },
			toolContext: input.toolContext,
			thinkingLevel: input.thinkingLevel ?? "off",
			steeringMode: "one-at-a-time",
			followUpMode: "one-at-a-time",
			streamOptions: {
				cacheRetention: input.cacheRetention ?? "long",
			},
		});
		this.#harness.on("before_provider_request", () => {
			this.#metrics.recordProviderRequest();
			return undefined;
		});
		this.#harness.subscribe((event) => {
			this.#metrics.record(event);
		});
		this.activeToolNames = Object.freeze([...activeToolNames]);
	}
	async getSessionId(): Promise<string> {
		return (await this.#storage.getMetadata()).id;
	}

	prompt(text: string, options?: { images?: ImageContent[] }) {
		return this.#harness.prompt(text, options);
	}

	steer(text: string, options?: { images?: ImageContent[] }) {
		return this.#harness.steer(text, options);
	}

	followUp(text: string, options?: { images?: ImageContent[] }) {
		return this.#harness.followUp(text, options);
	}

	abort() {
		return this.#harness.abort();
	}

	subscribe(listener: (event: AgentHarnessEvent) => Promise<void> | void) {
		return this.#harness.subscribe(listener);
	}

	getMetrics(): ThreeXhaustSessionMetrics {
		return this.#metrics.snapshot();
	}
}

export function createThreeXhaustSession(input: CreateThreeXhaustSessionInput): ThreeXhaustPiSession {
	return new ThreeXhaustPiSession(input);
}
