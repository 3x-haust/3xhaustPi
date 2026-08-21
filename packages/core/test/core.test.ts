import { parseProjectId, parseSemanticOutput } from "@3xhaust/semantic-contract";
import { describe, expect, it } from "vitest";
import {
	CAPABILITY_CATALOG_VERSION,
	compileSemanticOutput,
	evaluateCapabilityPolicy,
	getCapabilityCatalog,
	normalizeObservation,
	POLICY_VERSION,
} from "../src/index.ts";

const context = {
	projectId: parseProjectId("prj_demo"),
	turnId: "turn_demo",
	projectRevision: "rev_demo",
	observationDigests: [],
} as const;

function intent(kind: "inspect" | "modify" | "review" | "verify", target: Readonly<Record<string, unknown>>) {
	return parseSemanticOutput({
		protocolVersion: 2,
		kind: "intent",
		payload: {
			kind,
			objective: `${kind} safely`,
			target,
			evidenceGoals: ["Observe evidence"],
			constraints: [],
			doneWhen: "Evidence supports the result",
		},
	});
}

describe("3xhaustpi deterministic core", () => {
	it("ships exactly five versioned v1 capability manifests", () => {
		const catalog = getCapabilityCatalog();
		expect(catalog.version).toBe(CAPABILITY_CATALOG_VERSION);
		expect(catalog.capabilities.map(({ id }) => id)).toEqual([
			"searchText",
			"searchSymbol",
			"readRanges",
			"applyPatch",
			"getDiagnostics",
		]);
		expect(catalog.capabilities.find(({ id }) => id === "applyPatch")).toMatchObject({
			effect: "write",
			cache: "none",
			maxAttempts: 1,
		});
	});

	it("compiles semantic targets into code-owned read invocations", async () => {
		const recipe = await compileSemanticOutput(
			intent("inspect", { kind: "symbol", hint: "parse /path-looking text" }),
			context,
		);
		expect(recipe).toMatchObject({
			kind: "readPlan",
			recipeKind: "inspect",
			invocations: [{ capability: "searchSymbol", policy: { decision: "allow" } }],
		});
		if (recipe.kind !== "readPlan") throw new Error("expected read plan");
		expect(recipe.invocations[0]?.input).toEqual({
			projectId: "prj_demo",
			query: "parse /path-looking text",
		});
		expect(recipe.invocations[0]?.idempotencyKey).toMatch(/^sha256:[a-f0-9]{64}$/);
	});

	it("keeps modify intents in evidence collection instead of creating writes", async () => {
		const recipe = await compileSemanticOutput(
			intent("modify", { kind: "documents", documentIds: ["doc_alpha"] }),
			context,
		);
		expect(recipe).toMatchObject({
			kind: "readPlan",
			recipeKind: "modify",
			phase: "evidence",
			invocations: [{ capability: "readRanges" }],
		});
		if (recipe.kind !== "readPlan") throw new Error("expected read plan");
		expect(recipe.invocations.some(({ capability }) => capability === "applyPatch")).toBe(false);
	});

	it("compiles patch output into an approval-bound mutation proposal, never an invocation", async () => {
		const output = parseSemanticOutput({
			protocolVersion: 2,
			kind: "patchProposal",
			payload: {
				edits: [{ documentId: "doc_alpha", oldText: "before", newText: "after" }],
				assumptions: [],
				verificationGoals: ["Diagnostics pass"],
			},
		});
		const recipe = await compileSemanticOutput(output, context);
		if (output.kind !== "patchProposal") throw new Error("expected patch proposal");
		expect(recipe).toMatchObject({
			kind: "mutationProposal",
			policy: { decision: "approval-required", policyVersion: POLICY_VERSION },
			proposal: { edits: output.payload.edits },
		});
		expect("invocations" in recipe).toBe(false);
		expect(recipe.kind === "mutationProposal" ? recipe.proposal.proposalDigest : "").toMatch(/^sha256:[a-f0-9]{64}$/);
	});

	it("derives verify diagnostics and deterministic identities", async () => {
		const output = intent("verify", { kind: "documents", documentIds: ["doc_alpha", "doc_beta"] });
		const first = await compileSemanticOutput(output, context);
		const second = await compileSemanticOutput(output, context);
		expect(first).toEqual(second);
		expect(first).toMatchObject({
			kind: "readPlan",
			invocations: [{ capability: "getDiagnostics", timeoutMs: 20_000, maxAttempts: 1 }],
		});
	});

	it("keeps clarify, completion suggestions, and unsupported UI targets effect-free", async () => {
		const clarify = parseSemanticOutput({
			protocolVersion: 2,
			kind: "intent",
			payload: { kind: "clarify", question: "Which behavior?", reason: "Scope is ambiguous" },
		});
		const complete = parseSemanticOutput({
			protocolVersion: 2,
			kind: "intent",
			payload: {
				kind: "complete",
				summary: "Suggested completion",
				claims: [{ observationRef: "obs_verified", claim: "Verification passed" }],
			},
		});
		expect(await compileSemanticOutput(clarify, context)).toMatchObject({ kind: "clarify" });
		await expect(compileSemanticOutput(complete, context)).rejects.toThrow("undisclosed observation");
		expect(await compileSemanticOutput(complete, { ...context, observationDigests: ["obs_verified"] })).toMatchObject(
			{ kind: "completionSuggestion" },
		);
		expect(
			await compileSemanticOutput(intent("inspect", { kind: "ui", role: "button", name: "Run" }), context),
		).toMatchObject({ kind: "blocked", reason: "unsupported-target" });
	});

	it("derives write denial and approval from code-owned policy", () => {
		expect(evaluateCapabilityPolicy("applyPatch", { writeMode: "deny" })).toEqual({
			decision: "deny",
			policyVersion: POLICY_VERSION,
			reason: "workspace writes are disabled",
		});
		expect(evaluateCapabilityPolicy("applyPatch", { writeMode: "approval" })).toMatchObject({
			decision: "approval-required",
		});
		expect(evaluateCapabilityPolicy("searchText", { writeMode: "deny" })).toMatchObject({ decision: "allow" });
	});

	it("normalizes executor outcomes into bounded deterministic observations", async () => {
		const recipe = await compileSemanticOutput(
			intent("inspect", { kind: "behavior", description: "Locate the behavior" }),
			context,
		);
		if (recipe.kind !== "readPlan") throw new Error("expected read plan");
		const observation = await normalizeObservation(recipe.invocations[0]!, {
			status: "succeeded",
			summary: "Search completed",
			facts: { matches: 3 },
			artifactRefs: ["art_results"],
		});
		expect(observation).toMatchObject({
			status: "succeeded",
			projectRevision: "rev_demo",
			summary: "Search completed",
			facts: { matches: 3 },
		});
		expect(observation.observationId).toMatch(/^obs_[a-f0-9]{32}$/);
	});
});
