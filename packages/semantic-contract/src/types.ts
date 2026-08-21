declare const opaqueId: unique symbol;

type OpaqueId<Kind extends string> = string & { readonly [opaqueId]: Kind };

export type ProjectId = OpaqueId<"ProjectId">;
export type SelectionId = OpaqueId<"SelectionId">;
export type DocumentId = OpaqueId<"DocumentId">;
export type ObservationId = OpaqueId<"ObservationId">;
export type ArtifactId = OpaqueId<"ArtifactId">;

export type SemanticTurnMode = "prompt" | "steer" | "followUp";

export interface SemanticTurnRequest {
	readonly protocolVersion: 2;
	readonly mode: SemanticTurnMode;
	readonly objective: string;
	readonly disclosed: {
		readonly selectionIds: readonly SelectionId[];
		readonly documentIds: readonly DocumentId[];
		readonly observationIds: readonly ObservationId[];
	};
}

export type SemanticTarget =
	| { readonly kind: "selection"; readonly selectionId: SelectionId }
	| { readonly kind: "documents"; readonly documentIds: readonly DocumentId[]; readonly hint?: string }
	| { readonly kind: "symbol"; readonly hint: string }
	| { readonly kind: "error"; readonly fingerprint: string }
	| { readonly kind: "behavior"; readonly description: string }
	| { readonly kind: "ui"; readonly role: string; readonly name: string };

export interface WorkIntent {
	readonly kind: "inspect" | "modify" | "review" | "verify";
	readonly objective: string;
	readonly target: SemanticTarget;
	readonly evidenceGoals: readonly string[];
	readonly constraints: readonly string[];
	readonly doneWhen: string;
}

export interface ClarifyIntent {
	readonly kind: "clarify";
	readonly question: string;
	readonly reason: string;
}

export interface CompletionClaim {
	readonly observationRef: ObservationId;
	readonly claim: string;
}

export interface CompleteIntent {
	readonly kind: "complete";
	readonly summary: string;
	readonly claims: readonly CompletionClaim[];
}

export type Intent = WorkIntent | ClarifyIntent | CompleteIntent;

export interface ProposedEdit {
	readonly documentId: DocumentId;
	readonly oldText: string;
	readonly newText: string;
}

export interface PatchProposal {
	readonly edits: readonly ProposedEdit[];
	readonly assumptions: readonly string[];
	readonly verificationGoals: readonly string[];
}

export type SemanticOutput =
	| { readonly protocolVersion: 2; readonly kind: "intent"; readonly payload: Intent }
	| { readonly protocolVersion: 2; readonly kind: "patchProposal"; readonly payload: PatchProposal };
