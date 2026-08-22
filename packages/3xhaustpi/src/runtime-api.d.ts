export interface CodingTaskUsage {
	readonly input: number | null;
	readonly output: number | null;
	readonly cacheRead: number | null;
	readonly cacheWrite?: number | null;
}

export interface CodingTaskPatchProposal {
	readonly patchId: string;
	readonly targetRevision: string;
	readonly diff: string;
	readonly files: readonly string[];
}

export type CodingTaskEvent =
	| {
			readonly type: "session.started";
			readonly sessionId: string;
			readonly provider: string;
			readonly model: string;
			readonly objective: string;
	  }
	| {
			readonly type: "model.completed";
			readonly responseId: string;
			readonly usage: CodingTaskUsage;
			readonly durationMs: number;
	  }
	| {
			readonly type: "capability.started";
			readonly capability: "searchText" | "searchSymbol" | "readRanges" | "applyPatch" | "getDiagnostics";
	  }
	| {
			readonly type: "capability.completed";
			readonly capability: "searchText" | "searchSymbol" | "readRanges" | "applyPatch" | "getDiagnostics";
			readonly success: boolean;
			readonly durationMs: number;
			readonly summary: string;
	  }
	| ({ readonly type: "patch.proposed" } & CodingTaskPatchProposal)
	| {
			readonly type: "patch.decision";
			readonly patchId: string;
			readonly approved: boolean;
	  }
	| {
			readonly type: "diagnostics.completed";
			readonly success: boolean;
			readonly command: string;
			readonly output: string;
			readonly durationMs: number;
	  }
	| {
			readonly type: "assistant.message";
			readonly text: string;
	  }
	| {
			readonly type: "session.completed";
			readonly sessionId: string;
			readonly outcome: "completed" | "rejected";
			readonly decision: string;
			readonly usage: CodingTaskUsage;
	  }
	| {
			readonly type: "session.failed";
			readonly sessionId: string;
			readonly message: string;
	  };

export interface CodingTaskResourceOptions {
	readonly enabled: boolean;
	readonly allowProjectHooks?: boolean;
	readonly userRoot?: string;
	readonly builtinRoot?: string;
}

export interface CodingTaskInput {
	readonly projectRoot: string;
	readonly objective: string;
	readonly images?: readonly CodingTaskImage[];
	readonly approve: boolean;
	readonly statePath?: string;
	readonly provider?: string;
	readonly model?: string;
	readonly credential?: string;
	readonly sessionId?: string;
	/** Use only non-executing diagnostics and never run validation scripts from the project. */
	readonly strict?: boolean;
	readonly preserveProviderSession?: boolean;
	readonly signal?: AbortSignal;
	readonly onEvent?: (event: CodingTaskEvent) => void;
	readonly requestApproval?: (proposal: CodingTaskPatchProposal) => Promise<boolean>;
	readonly resources?: CodingTaskResourceOptions;
}

export interface CodingTaskImage {
	readonly data: string;
	readonly mimeType: "image/jpeg" | "image/png" | "image/webp";
}

export interface ResumeCodingTaskInput {
	readonly approve: boolean;
	readonly statePath?: string;
	readonly sessionId?: string;
	readonly projectRoot?: string;
	readonly credential?: string;
	/** Use only non-executing diagnostics and never run validation scripts from the project. */
	readonly strict?: boolean;
	readonly preserveProviderSession?: boolean;
	readonly signal?: AbortSignal;
	readonly onEvent?: (event: CodingTaskEvent) => void;
	readonly requestApproval?: (proposal: CodingTaskPatchProposal) => Promise<boolean>;
	readonly resources?: CodingTaskResourceOptions;
}

export interface CodingTaskResult {
	readonly sessionId: string;
	readonly outcome: "completed" | "rejected";
	readonly decision: string;
	readonly usage: CodingTaskUsage;
	readonly patchId?: string;
	readonly diagnostics?: {
		readonly success: boolean;
		readonly command: string;
		readonly output: string;
	};
}

export interface ConversationInput {
	readonly provider?: string;
	readonly model?: string;
	readonly credential?: string;
	readonly system: string;
	readonly prompt: string;
	readonly images?: readonly CodingTaskImage[];
	readonly sessionId?: string;
	readonly signal?: AbortSignal;
}

export interface ConversationResult {
	readonly text: string;
	readonly inputTokens: number;
	readonly outputTokens: number;
}

export function runCodingTask(input: CodingTaskInput): Promise<CodingTaskResult>;
export function runConversation(input: ConversationInput): Promise<ConversationResult>;
export function resumeCodingTask(input: ResumeCodingTaskInput): Promise<CodingTaskResult | undefined>;
