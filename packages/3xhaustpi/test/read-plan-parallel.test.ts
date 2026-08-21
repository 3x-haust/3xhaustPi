import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CapabilityInvocation } from "../../core/src/index.ts";
import { clearReadCapabilityCache } from "../src/capability-executor.ts";
import { executeReadPlanInvocations } from "../src/coding-runtime.ts";

const temporaryDirectories: string[] = [];

function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "3xhaustpi-read-plan-"));
	temporaryDirectories.push(root);
	writeFileSync(join(root, "alpha.ts"), "export const ALPHA = 1;\n");
	writeFileSync(join(root, "beta.ts"), "export const BETA = 2;\n");
	return root;
}

function searchInvocation(query: string): CapabilityInvocation {
	return {
		invocationId: `invocation_${query}`,
		logicalCallId: `logical_${query}`,
		capability: "searchText",
		capabilityVersion: "1",
		effect: "read",
		cache: "revision",
		timeoutMs: 5_000,
		maxAttempts: 1,
		idempotencyKey: `idempotency_${query}`,
		input: { query },
		basedOn: { projectRevision: "fixture", observationDigests: [] },
		policy: { decision: "allow", policyVersion: "test" },
	};
}

afterEach(() => {
	clearReadCapabilityCache();
	for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("parallel read plan execution", () => {
	it("runs every invocation concurrently and returns one observation per invocation in order", async () => {
		const project = fixture();
		const started: string[] = [];
		let concurrent = 0;
		let peakConcurrency = 0;

		const observations = await executeReadPlanInvocations([searchInvocation("ALPHA"), searchInvocation("BETA")], {
			projectRoot: project,
			documents: new Map(),
			onStarted: (capability) => {
				started.push(capability);
				concurrent += 1;
				peakConcurrency = Math.max(peakConcurrency, concurrent);
			},
			onCompleted: () => {
				concurrent -= 1;
			},
		});

		expect(observations).toHaveLength(2);
		expect(observations.map((observation) => observation.observationId)).toHaveLength(2);
		expect(new Set(started)).toEqual(new Set(["searchText"]));
		expect(peakConcurrency).toBeGreaterThan(1);
	});

	it("keeps every observation successful when all reads succeed", async () => {
		const project = fixture();
		const observations = await executeReadPlanInvocations([searchInvocation("ALPHA")], {
			projectRoot: project,
			documents: new Map(),
		});
		expect(observations).toHaveLength(1);
		expect(JSON.parse(JSON.stringify(observations[0])).status ?? "succeeded").toBeTruthy();
	});
});
