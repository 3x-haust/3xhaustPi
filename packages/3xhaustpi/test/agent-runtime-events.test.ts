import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingTaskEvent } from "../src/coding-runtime.ts";

const mocks = vi.hoisted(() => ({
	cleanupSessionResources: vi.fn(),
	createAgentSessionFromServices: vi.fn(),
	createAgentSessionServices: vi.fn(),
	createCredentialStore: vi.fn(),
	createModelRuntime: vi.fn(),
	createSessionManager: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", () => ({
	cleanupSessionResources: mocks.cleanupSessionResources,
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	ModelRuntime: { create: mocks.createModelRuntime },
	SessionManager: { create: mocks.createSessionManager },
	createAgentSessionFromServices: mocks.createAgentSessionFromServices,
	createAgentSessionServices: mocks.createAgentSessionServices,
	getAgentDir: () => "/tmp/3xhaustpi-agent-runtime-events",
}));

vi.mock("../src/provider-runtime.ts", () => ({
	createCredentialStore: mocks.createCredentialStore,
}));

import { runAgentTask } from "../src/agent-runtime.ts";

const usage = {
	input: 4_234,
	output: 110,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 4_344,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("native agent event projection", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		const model = {
			provider: "openai-codex",
			id: "gpt-5.3-codex-spark",
			api: "openai-codex-responses",
		};
		let subscriber: ((event: unknown) => void) | undefined;
		const session = {
			agent: { streamFunction: vi.fn() },
			subscribe: vi.fn((listener) => {
				subscriber = listener;
				return vi.fn();
			}),
			prompt: vi.fn(async () => {
				const message = {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "" },
						{ type: "text", text: "안녕" },
					],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage,
					stopReason: "stop",
					timestamp: 1,
				};
				subscriber?.({ type: "message_start", message });
				subscriber?.({ type: "message_end", message });
			}),
			abort: vi.fn(),
			dispose: vi.fn(),
		};
		mocks.createCredentialStore.mockReturnValue({});
		mocks.createModelRuntime.mockResolvedValue({});
		mocks.createAgentSessionServices.mockResolvedValue({
			modelRuntime: { getAvailable: vi.fn().mockResolvedValue([model]) },
			settingsManager: { getDefaultThinkingLevel: vi.fn().mockReturnValue("medium") },
		});
		mocks.createSessionManager.mockReturnValue({ getSessionId: () => "session_fixture" });
		mocks.createAgentSessionFromServices.mockResolvedValue({ session });
	});

	it("emits the final assistant text when the provider sends no text deltas", async () => {
		const events: CodingTaskEvent[] = [];

		await runAgentTask({
			projectRoot: "/tmp/project",
			objective: "ㅎㅇ 한 단어로 답해",
			provider: "openai-codex",
			model: "gpt-5.3-codex-spark",
			onEvent: (event) => events.push(event),
		});

		expect(events).toContainEqual({ type: "assistant.message", text: "안녕" });
		expect(events.findIndex((event) => event.type === "assistant.message")).toBeLessThan(
			events.findIndex((event) => event.type === "model.completed"),
		);
	});
});
