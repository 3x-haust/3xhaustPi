import { describe, expect, it } from "vitest";
import {
	parseArtifactId,
	parseProjectId,
	parseSemanticOutput,
	parseSemanticTurnRequest,
	SemanticContractError,
	safeParseSemanticOutput,
} from "../src/index.ts";

const workIntent = {
	protocolVersion: 2,
	kind: "intent",
	payload: {
		kind: "modify",
		objective: "Explain src/index.ts and quoted `npm test`; neither string is executable.",
		target: {
			kind: "documents",
			documentIds: ["doc_alpha"],
			hint: "The user mentioned /tmp/example and rm -rf as inert text.",
		},
		evidenceGoals: ["Observe the failing behavior"],
		constraints: ["Do not change public behavior"],
		doneWhen: "Observation-backed verification succeeds",
	},
} as const;

const patchProposal = {
	protocolVersion: 2,
	kind: "patchProposal",
	payload: {
		edits: [
			{
				documentId: "doc_alpha",
				oldText: "exec('rm -rf /tmp/demo')",
				newText: "log('see /Users/example/file.ts')",
			},
		],
		assumptions: ["The quoted command is source text"],
		verificationGoals: ["The observed behavior is corrected"],
	},
} as const;

describe("3xhaustpi semantic protocol v2", () => {
	it("parses strict work, clarify, complete, and patch proposal variants", () => {
		expect(parseSemanticOutput(workIntent)).toEqual(workIntent);
		expect(
			parseSemanticOutput({
				protocolVersion: 2,
				kind: "intent",
				payload: { kind: "clarify", question: "Which behavior?", reason: "Two outcomes remain possible." },
			}),
		).toMatchObject({ payload: { kind: "clarify" } });
		expect(
			parseSemanticOutput({
				protocolVersion: 2,
				kind: "intent",
				payload: {
					kind: "complete",
					summary: "Evidence supports completion.",
					claims: [{ observationRef: "obs_verified", claim: "Verification passed." }],
				},
			}),
		).toMatchObject({ payload: { kind: "complete" } });
		expect(parseSemanticOutput(patchProposal)).toEqual(patchProposal);
	});

	it("parses every semantic target without granting actuator authority", () => {
		const targets = [
			{ kind: "selection", selectionId: "sel_range" },
			{ kind: "documents", documentIds: ["doc_one", "doc_two"] },
			{ kind: "symbol", hint: "parse /path-like text" },
			{ kind: "error", fingerprint: "TypeError at src/a.ts" },
			{ kind: "behavior", description: "Run-looking text: npm test" },
			{ kind: "ui", role: "button", name: "Run tests" },
		];
		for (const target of targets) {
			expect(parseSemanticOutput({ ...workIntent, payload: { ...workIntent.payload, target } })).toMatchObject({
				payload: { target },
			});
		}
	});

	it("parses bounded turn requests with disclosed opaque references", () => {
		const request = {
			protocolVersion: 2,
			mode: "followUp",
			objective: "Investigate the selected behavior.",
			disclosed: {
				selectionIds: ["sel_current"],
				documentIds: ["doc_alpha"],
				observationIds: ["obs_previous"],
			},
		};
		expect(parseSemanticTurnRequest(request)).toEqual(request);
		expect(() => parseSemanticTurnRequest({ ...request, mode: "execute" })).toThrow(/mode/i);
		expect(() =>
			parseSemanticTurnRequest({ ...request, disclosed: { ...request.disclosed, path: "src/a.ts" } }),
		).toThrow(/keys/i);
	});

	it("rejects unknown versions and exact-key violations at every depth", () => {
		expect(() => parseSemanticOutput({ ...workIntent, protocolVersion: 3 })).toThrow(/version/i);
		expect(() => parseSemanticOutput({ ...workIntent, extra: true })).toThrow(/keys/i);
		expect(() =>
			parseSemanticOutput({
				...workIntent,
				payload: { ...workIntent.payload, target: { ...workIntent.payload.target, timeout: 10 } },
			}),
		).toThrow(/keys/i);
		expect(() =>
			parseSemanticOutput({
				...patchProposal,
				payload: {
					...patchProposal.payload,
					edits: [{ ...patchProposal.payload.edits[0], approval: "granted" }],
				},
			}),
		).toThrow(/keys/i);
	});

	it("rejects path-shaped opaque identifiers and model-authored operation metadata", () => {
		for (const badId of ["src/file.ts", "../secret", "C:\\temp\\x", ".hidden", "doc_two words"]) {
			expect(() =>
				parseSemanticOutput({
					...patchProposal,
					payload: {
						...patchProposal.payload,
						edits: [{ ...patchProposal.payload.edits[0], documentId: badId }],
					},
				}),
			).toThrow(/identifier/i);
		}
		for (const field of [
			"path",
			"command",
			"capability",
			"tool",
			"mcpName",
			"permission",
			"timeout",
			"retry",
			"accountId",
			"baseRevision",
			"proposalId",
		]) {
			expect(() => parseSemanticOutput({ ...workIntent, payload: { ...workIntent.payload, [field]: "x" } })).toThrow(
				/keys/i,
			);
		}
	});

	it("keeps declared source and hint text inert while enforcing bounds", () => {
		expect(parseSemanticOutput(workIntent)).toEqual(workIntent);
		expect(parseSemanticOutput(patchProposal)).toEqual(patchProposal);
		expect(() =>
			parseSemanticOutput({ ...workIntent, payload: { ...workIntent.payload, objective: "x".repeat(4_097) } }),
		).toThrow(/length/i);
		expect(() =>
			parseSemanticOutput({
				...patchProposal,
				payload: { ...patchProposal.payload, edits: [{ ...patchProposal.payload.edits[0], oldText: "" }] },
			}),
		).toThrow(/empty/i);
	});

	it("exports prefix-checked project and artifact identifier parsers", () => {
		expect(parseProjectId("prj_main")).toBe("prj_main");
		expect(parseArtifactId("art_receipt")).toBe("art_receipt");
		expect(() => parseProjectId("project/main")).toThrow(/identifier/i);
	});

	it("returns serializable errors without retaining raw payloads", () => {
		const secret = "SUPER_SECRET_RAW_PAYLOAD";
		const result = safeParseSemanticOutput({ protocolVersion: 2, kind: "intent", payload: { summary: secret } });
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error).toBeInstanceOf(SemanticContractError);
			expect(JSON.stringify(result.error)).not.toContain(secret);
			expect(Object.keys(result.error)).not.toContain("payload");
		}
	});
});
