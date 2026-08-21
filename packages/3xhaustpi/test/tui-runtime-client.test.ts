import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CodingTaskEvent } from "../src/coding-runtime.ts";
import { createTuiRunRequest, runTuiRuntime } from "../src/tui-runtime-client.ts";

const workerPath = resolve(import.meta.dirname, "fixtures/tui-runtime-worker-fixture.mjs");

describe("TUI runtime worker boundary", () => {
	it("forwards the model selected inside the live TUI", () => {
		expect(
			createTuiRunRequest({
				projectRoot: "/tmp/project",
				objective: "inspect",
				selectedModel: { provider: "openai-codex", model: "gpt-5.6-luna" },
				allowProjectHooks: true,
			}),
		).toEqual({
			mode: "run",
			projectRoot: "/tmp/project",
			objective: "inspect",
			provider: "openai-codex",
			model: "gpt-5.6-luna",
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
});
