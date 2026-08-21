import { describe, expect, it } from "vitest";
import { createThreeXhaustSemanticSession, type SemanticRequest } from "../src/index.ts";

const validIntent = {
	protocolVersion: 2,
	kind: "intent",
	payload: {
		kind: "inspect",
		objective: "Inspect quoted src/index.ts and `npm test` as inert text.",
		target: { kind: "documents", documentIds: ["doc_selected"], hint: "/tmp/example" },
		evidenceGoals: ["Observe current behavior"],
		constraints: [],
		doneWhen: "An observation supports the answer",
	},
} as const;

describe("3xhaustpi semantic session protocol v2", () => {
	it("sends a versioned semantic turn and accepts only the strict envelope", async () => {
		const requests: SemanticRequest[] = [];
		const session = createThreeXhaustSemanticSession({
			complete: async (request) => {
				requests.push(request);
				return JSON.stringify(validIntent);
			},
		});

		await expect(session.prompt("Inspect safely")).resolves.toEqual(validIntent);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			mode: "prompt",
			semanticTurn: {
				protocolVersion: 2,
				mode: "prompt",
				objective: "Inspect safely",
				disclosed: { selectionIds: [], documentIds: [], observationIds: [] },
			},
			tools: [],
		});
	});

	it("repairs legacy or actuator-shaped output once with protocol v2", async () => {
		const requests: SemanticRequest[] = [];
		const session = createThreeXhaustSemanticSession({
			complete: async (request) => {
				requests.push(request);
				return requests.length === 1
					? JSON.stringify({ kind: "intent", payload: { intent: "inspect", path: "/tmp/private" } })
					: JSON.stringify(validIntent);
			},
		});

		await expect(session.prompt("Inspect")).resolves.toEqual(validIntent);
		expect(requests).toHaveLength(2);
		expect(requests[1]?.repairOf).toContain("/tmp/private");
		expect(requests[1]?.prompt).toContain("protocolVersion");
	});

	it("keeps path- and command-looking declared text inert", async () => {
		let calls = 0;
		const session = createThreeXhaustSemanticSession({
			complete: async () => {
				calls += 1;
				return JSON.stringify(validIntent);
			},
		});

		await expect(session.prompt("Read /tmp/example; do not execute `rm -rf`")).resolves.toEqual(validIntent);
		expect(calls).toBe(1);
	});

	it("rejects nested actuator fields after one bounded repair", async () => {
		let calls = 0;
		const invalid = {
			...validIntent,
			payload: { ...validIntent.payload, target: { ...validIntent.payload.target, timeout: 10 } },
		};
		const session = createThreeXhaustSemanticSession({
			complete: async () => {
				calls += 1;
				return JSON.stringify(invalid);
			},
		});

		await expect(session.prompt("Inspect")).rejects.toThrow("remained invalid after one repair");
		expect(calls).toBe(2);
	});
});
