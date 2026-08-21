import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CapabilityInvocation } from "../../core/src/index.ts";
import { clearReadCapabilityCache, executeReadCapability } from "../src/capability-executor.ts";

const temporaryDirectories: string[] = [];

function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "3xhaustpi-capability-"));
	temporaryDirectories.push(root);
	writeFileSync(join(root, "sample.ts"), "export const PRESENT = true;\n");
	return root;
}

function invocation(query: string, decision: "allow" | "deny" = "allow"): CapabilityInvocation {
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
		policy:
			decision === "allow"
				? { decision: "allow", policyVersion: "test" }
				: { decision: "deny", policyVersion: "test", reason: "test denial" },
	};
}

afterEach(() => {
	clearReadCapabilityCache();
	for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("read capability execution status", () => {
	it("treats a completed search with no matches as a successful empty observation", () => {
		const outcome = executeReadCapability(invocation("ABSENT"), fixture());

		expect(outcome).toMatchObject({
			status: "succeeded",
			matchCount: 0,
			summary: "Search completed with no exact matches",
		});
	});

	it("keeps a denied search as a failed invocation", () => {
		const outcome = executeReadCapability(invocation("PRESENT", "deny"), fixture());

		expect(outcome).toMatchObject({ status: "failed", matchCount: 0 });
	});
});
