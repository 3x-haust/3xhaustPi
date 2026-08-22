import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodingTaskEvent } from "../src/coding-runtime.ts";
import { createTuiRunRequest, runTuiRuntime } from "../src/tui-runtime-client.ts";

const workerPath = resolve(import.meta.dirname, "fixtures/tui-runtime-worker-fixture.mjs");
const fixtureWorkerPids = new Set<number>();

afterEach(() => {
	const workerPids = [...fixtureWorkerPids];
	fixtureWorkerPids.clear();
	for (const workerPid of workerPids) {
		try {
			process.kill(workerPid, "SIGKILL");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ESRCH") continue;
			throw error;
		}
	}
});

describe("TUI runtime worker boundary", () => {
	it("forwards the model selected inside the live TUI", () => {
		expect(
			createTuiRunRequest({
				projectRoot: "/tmp/project",
				objective: "inspect",
				selectedModel: { provider: "openai-codex", model: "gpt-5.6-luna" },
				sessionId: "session_continuation",
				allowProjectHooks: true,
			}),
		).toEqual({
			mode: "run",
			projectRoot: "/tmp/project",
			objective: "inspect",
			provider: "openai-codex",
			model: "gpt-5.6-luna",
			sessionId: "session_continuation",
			allowProjectHooks: true,
		});
	});

	it("streams bounded events and resolves a reviewed action", async () => {
		const events: CodingTaskEvent[] = [];
		const requestApproval = vi.fn(async () => true);
		const result = await runTuiRuntime(
			{ mode: "run", projectRoot: "/tmp/fixture", objective: "inspect fixture" },
			{
				onEvent: (event) => events.push(event),
				requestApproval,
				signal: new AbortController().signal,
			},
			{ workerPath },
		);

		expect(requestApproval).toHaveBeenCalledOnce();
		expect(events.map((event) => event.type)).toEqual(["session.started", "capability.completed"]);
		expect(result).toEqual({ approved: true });
	});

	it("propagates cancellation to the runtime worker", async () => {
		const controller = new AbortController();
		const execution = runTuiRuntime(
			{ mode: "run", projectRoot: "/tmp/fixture", objective: "wait" },
			{
				onEvent: () => {},
				requestApproval: async () => false,
				signal: controller.signal,
			},
			{ workerPath },
		);
		controller.abort();
		await expect(execution).rejects.toThrow(/fixture worker aborted/u);
	});

	it("reaps a completed worker that still owns runtime handles", async () => {
		const result = await runTuiRuntime(
			{ mode: "run", projectRoot: "/tmp/fixture", objective: "result-with-open-handle" },
			{
				onEvent: () => {},
				requestApproval: async () => false,
				signal: new AbortController().signal,
			},
			{ workerPath },
		);
		if (typeof result !== "object" || result === null || !("pid" in result) || typeof result.pid !== "number") {
			throw new Error("Fixture worker did not return its process id.");
		}
		const workerPid = result.pid;
		fixtureWorkerPids.add(workerPid);

		expect(() => process.kill(workerPid, 0)).toThrow();
	});

	it("escalates shutdown when a completed worker ignores SIGTERM", async () => {
		const result = await runTuiRuntime(
			{ mode: "run", projectRoot: "/tmp/fixture", objective: "result-ignoring-sigterm" },
			{
				onEvent: () => {},
				requestApproval: async () => false,
				signal: new AbortController().signal,
			},
			{ workerPath, terminationGraceMs: 0 },
		);
		if (typeof result !== "object" || result === null || !("pid" in result) || typeof result.pid !== "number") {
			throw new Error("Fixture worker did not return its process id.");
		}
		const workerPid = result.pid;
		fixtureWorkerPids.add(workerPid);

		expect(() => process.kill(workerPid, 0)).toThrow();
	}, 1_000);
});
