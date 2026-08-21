import type {
	ArtifactId,
	DocumentId,
	ObservationId,
	PatchProposal,
	ProjectId,
	SemanticOutput,
} from "@3xhaust/semantic-contract";

export type CapabilityId = "searchText" | "searchSymbol" | "readRanges" | "applyPatch" | "getDiagnostics";
export type CapabilityEffect = "read" | "write";
export type CacheDirective = "revision" | "none";

export interface CapabilityManifest {
	readonly id: CapabilityId;
	readonly version: string;
	readonly effect: CapabilityEffect;
	readonly cache: CacheDirective;
	readonly timeoutMs: number;
	readonly maxAttempts: number;
}

export interface CapabilityCatalog {
	readonly version: string;
	readonly capabilities: readonly CapabilityManifest[];
}

export type PolicyDecision =
	| { readonly decision: "allow"; readonly policyVersion: string }
	| { readonly decision: "approval-required"; readonly policyVersion: string }
	| { readonly decision: "deny"; readonly policyVersion: string; readonly reason: string };

export interface PolicyProfile {
	readonly writeMode: "deny" | "approval";
}

export interface CompileContext {
	readonly projectId: ProjectId;
	readonly turnId: string;
	readonly projectRevision: string;
	readonly observationDigests: readonly string[];
	readonly catalogVersion?: string;
	readonly policyVersion?: string;
}

export interface CapabilityInvocation {
	readonly invocationId: string;
	readonly logicalCallId: string;
	readonly capability: CapabilityId;
	readonly capabilityVersion: string;
	readonly effect: CapabilityEffect;
	readonly cache: CacheDirective;
	readonly timeoutMs: number;
	readonly maxAttempts: number;
	readonly idempotencyKey: string;
	readonly input: Readonly<Record<string, unknown>>;
	readonly basedOn: {
		readonly projectRevision: string;
		readonly observationDigests: readonly string[];
	};
	readonly policy: PolicyDecision;
}

export type RecipeDecision =
	| {
			readonly kind: "readPlan";
			readonly recipeKind: "inspect" | "modify" | "review" | "verify";
			readonly phase: "evidence" | "verification";
			readonly invocations: readonly CapabilityInvocation[];
	  }
	| {
			readonly kind: "mutationProposal";
			readonly proposal: PatchProposal & { readonly proposalDigest: string };
			readonly policy: PolicyDecision;
	  }
	| { readonly kind: "clarify"; readonly question: string; readonly reason: string }
	| {
			readonly kind: "completionSuggestion";
			readonly summary: string;
			readonly claims: readonly { readonly observationRef: ObservationId; readonly claim: string }[];
	  }
	| { readonly kind: "blocked"; readonly reason: "unsupported-target" };

export interface ObservationOutcome {
	readonly status: "succeeded" | "failed" | "blocked" | "timed-out" | "cancelled";
	readonly summary: string;
	readonly facts: Readonly<Record<string, unknown>>;
	readonly artifactRefs: readonly string[];
}

export interface Observation {
	readonly observationId: ObservationId;
	readonly invocationId: string;
	readonly status: ObservationOutcome["status"];
	readonly summary: string;
	readonly facts: Readonly<Record<string, unknown>>;
	readonly artifactRefs: readonly ArtifactId[];
	readonly projectRevision: string;
}

export type { DocumentId, ProjectId, SemanticOutput };
