import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CapabilityInvocation } from "../../core/src/index.ts";
import { executeReadCapability } from "../src/capability-executor.ts";
import { findPythonExecutable, PythonReadPool } from "../src/python-read-pool.ts";

const temporaryDirectories: string[] = [];

function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "3xhaustpi-python-read-"));
	temporaryDirectories.push(root);
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src", "alpha.ts"), "export const TARGET = 1;\nconst other = TARGET;\n");
	writeFileSync(join(root, "src", "beta.ts"), "export const TARGET = 2;\n");
	mkdirSync(join(root, "node_modules"));
	writeFileSync(join(root, "node_modules", "ignored.js"), "TARGET\n");
	return root;
}

function invocation(query = "TARGET", timeoutMs = 5_000): CapabilityInvocation {
	return {
		invocationId: "invocation_python_test",
		logicalCallId: "logical_python_test",
		capability: "searchSymbol",
		capabilityVersion: "1",
		effect: "read",
		cache: "revision",
		timeoutMs,
		maxAttempts: 1,
		idempotencyKey: "python_test",
		input: { query },
		basedOn: { projectRevision: "fixture", observationDigests: [] },
		policy: { decision: "allow", policyVersion: "test" },
	};
}

afterEach(() => {
	for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe.skipIf(!findPythonExecutable())("Python read pool", () => {
	it("matches the TypeScript executor and supports bounded parallel reads", async () => {
		const root = fixture();
		const pool = new PythonReadPool(4);
		try {
			const expected = executeReadCapability(invocation(), root);
			const actual = await pool.execute(invocation(), root);
			expect(actual).toMatchObject({
				status: expected.status,
				matchCount: expected.matchCount,
				executor: "python",
			});
			expect(actual.outputHashInput.split("\n").sort()).toEqual(expected.outputHashInput.split("\n").sort());
			const parallel = await Promise.all(Array.from({ length: 8 }, () => pool.execute(invocation(), root)));
			expect(parallel.every((result) => result.matchCount === expected.matchCount)).toBe(true);
		} finally {
			pool.close();
		}
	});

	it("cancels without running a request", async () => {
		const root = fixture();
		const pool = new PythonReadPool(1);
		const controller = new AbortController();
		controller.abort();
		try {
			await expect(pool.execute(invocation(), root, controller.signal)).rejects.toThrow(/cancelled/u);
		} finally {
			pool.close();
		}
	});

	it("replaces a crashed worker before the next bounded read", async () => {
		const root = fixture();
		const pool = new PythonReadPool(1);
		try {
			await expect(pool.execute(invocation(), root)).resolves.toMatchObject({ status: "succeeded" });
			const before = pool.processIds()[0];
			expect(before).toBeDefined();
			process.kill(before!, "SIGKILL");
			await new Promise((resolve) => setTimeout(resolve, 50));
			await expect(pool.execute(invocation(), root)).resolves.toMatchObject({ status: "succeeded" });
			const after = pool.processIds()[0];
			expect(after).toBeDefined();
			expect(after).not.toBe(before);
		} finally {
			pool.close();
		}
	});
});
