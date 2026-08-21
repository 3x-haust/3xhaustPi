import type { SemanticOutput, SemanticTurnRequest } from "@3xhaust/semantic-contract";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	ImageContent,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";

export type CacheUsageSupport = "reported" | "unsupported" | "unknown";

export interface PiSemanticConnectionBinding {
	readonly connectionId: string;
	readonly model: Model<Api>;
	/** Stable project/model affinity for provider cache routing; task resources are closed after completion. */
	readonly sessionId: string;
	readonly cacheRetention: CacheRetention;
	readonly cacheUsageSupport: {
		readonly read: CacheUsageSupport;
		readonly write: CacheUsageSupport;
	};
	/** Bounded, relevant, byte-stable project evidence placed before the per-turn delta. */
	readonly stableContext?: string;
	readonly maxTokens?: number;
}

export type PiComplete = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

export type ProviderNumber =
	| { readonly status: "measured"; readonly value: number; readonly source: "provider-usage" }
	| { readonly status: "unsupported"; readonly reason: string }
	| { readonly status: "unmeasured"; readonly reason: string };

export interface SemanticTurnUsage {
	readonly input: ProviderNumber;
	readonly output: ProviderNumber;
	readonly cacheRead: ProviderNumber;
	readonly cacheWrite: ProviderNumber;
}

export interface SemanticTurnResult {
	readonly output: SemanticOutput;
	readonly attempts: 1 | 2;
	readonly normalization: "none" | "trailing-delimiter";
	readonly latencyMs: number;
	readonly provider: string;
	readonly model: string;
	readonly responseId?: string;
	readonly usage: SemanticTurnUsage;
}

export interface PiSemanticModelSession {
	submit(
		turn: SemanticTurnRequest,
		signal: AbortSignal,
		images?: readonly ImageContent[],
	): Promise<SemanticTurnResult>;
	close(): Promise<void>;
}

export interface PiSemanticModelPort {
	readonly stablePrefix: string;
	open(binding: PiSemanticConnectionBinding): PiSemanticModelSession;
}

export interface CreateThreeXhaustPiAdapterInput {
	readonly complete: PiComplete;
	readonly now?: () => number;
}
