import { parseSemanticOutput, type SemanticTarget } from "@3xhaust/semantic-contract";
import { sha256 } from "./canonical.ts";
import { CAPABILITY_CATALOG_VERSION, getCapabilityManifest } from "./catalog.ts";
import { evaluateCapabilityPolicy, POLICY_VERSION } from "./policy.ts";
import type {
	CapabilityId,
	CapabilityInvocation,
	CompileContext,
	PolicyProfile,
	RecipeDecision,
	SemanticOutput,
} from "./types.ts";

function assertVersions(context: CompileContext): void {
	if (context.catalogVersion !== undefined && context.catalogVersion !== CAPABILITY_CATALOG_VERSION) {
		throw new Error("Capability catalog version mismatch");
	}
	if (context.policyVersion !== undefined && context.policyVersion !== POLICY_VERSION) {
		throw new Error("Policy version mismatch");
	}
}

async function invocation(
	capability: CapabilityId,
	input: Readonly<Record<string, unknown>>,
	context: CompileContext,
	profile: PolicyProfile,
): Promise<CapabilityInvocation> {
	const manifest = getCapabilityManifest(capability);
	const seed = {
		capability,
		capabilityVersion: manifest.version,
		input,
		projectId: context.projectId,
		projectRevision: context.projectRevision,
		turnId: context.turnId,
		observationDigests: context.observationDigests,
		catalogVersion: CAPABILITY_CATALOG_VERSION,
		policyVersion: POLICY_VERSION,
	};
	const digest = await sha256(seed);
	return {
		invocationId: `inv_${digest.slice(0, 32)}`,
		logicalCallId: `call_${digest.slice(32)}`,
		capability,
		capabilityVersion: manifest.version,
		effect: manifest.effect,
		cache: manifest.cache,
		timeoutMs: manifest.timeoutMs,
		maxAttempts: manifest.maxAttempts,
		idempotencyKey: `sha256:${digest}`,
		input,
		basedOn: {
			projectRevision: context.projectRevision,
			observationDigests: [...context.observationDigests],
		},
		policy: evaluateCapabilityPolicy(capability, profile),
	};
}

function targetCapability(
	target: SemanticTarget,
	projectId: string,
	verify: boolean,
): { readonly capability: CapabilityId; readonly input: Readonly<Record<string, unknown>> } | undefined {
	if (target.kind === "selection") {
		return { capability: "readRanges", input: { projectId, selectionId: target.selectionId } };
	}
	if (target.kind === "documents") {
		return {
			capability: verify ? "getDiagnostics" : "readRanges",
			input: { projectId, documentIds: target.documentIds },
		};
	}
	if (target.kind === "symbol") {
		return { capability: "searchSymbol", input: { projectId, query: target.hint } };
	}
	if (target.kind === "error") {
		return { capability: "searchText", input: { projectId, query: target.fingerprint } };
	}
	if (target.kind === "behavior") {
		return { capability: "searchText", input: { projectId, query: target.description } };
	}
	return undefined;
}

export async function compileSemanticOutput(
	candidate: unknown,
	context: CompileContext,
	profile: PolicyProfile = { writeMode: "approval" },
): Promise<RecipeDecision> {
	assertVersions(context);
	const output: SemanticOutput = parseSemanticOutput(candidate);
	if (output.kind === "patchProposal") {
		const proposalDigest = await sha256({
			payload: output.payload,
			projectId: context.projectId,
			projectRevision: context.projectRevision,
			observations: context.observationDigests,
		});
		return {
			kind: "mutationProposal",
			proposal: { ...output.payload, proposalDigest: `sha256:${proposalDigest}` },
			policy: evaluateCapabilityPolicy("applyPatch", profile),
		};
	}
	if (output.payload.kind === "clarify") {
		return { kind: "clarify", question: output.payload.question, reason: output.payload.reason };
	}
	if (output.payload.kind === "complete") {
		const disclosed = new Set(context.observationDigests);
		for (const claim of output.payload.claims) {
			if (!disclosed.has(claim.observationRef)) {
				throw new Error(`Completion claim references undisclosed observation ${claim.observationRef}`);
			}
		}
		return {
			kind: "completionSuggestion",
			summary: output.payload.summary,
			claims: output.payload.claims,
		};
	}
	const selected = targetCapability(output.payload.target, context.projectId, output.payload.kind === "verify");
	if (!selected) return { kind: "blocked", reason: "unsupported-target" };
	return {
		kind: "readPlan",
		recipeKind: output.payload.kind,
		phase: output.payload.kind === "verify" ? "verification" : "evidence",
		invocations: [await invocation(selected.capability, selected.input, context, profile)],
	};
}
