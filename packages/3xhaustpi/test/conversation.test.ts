import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	checkAuth: vi.fn(),
	cleanupSessionResources: vi.fn(),
	completeSimple: vi.fn(),
	createProviderRuntime: vi.fn(),
	providerCredentialOverride: vi.fn(),
	resolveModel: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", () => ({
	cleanupSessionResources: mocks.cleanupSessionResources,
}));

vi.mock("../src/provider-runtime.ts", () => ({
	DEFAULT_MODEL: "gpt-default",
	DEFAULT_PROVIDER: "provider-default",
	createProviderRuntime: mocks.createProviderRuntime,
	providerCredentialOverride: mocks.providerCredentialOverride,
	resolveModel: mocks.resolveModel,
}));

import { runConversation } from "../src/coding-runtime.ts";

const usage = {
	input: 17,
	output: 9,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 26,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("runConversation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.checkAuth.mockResolvedValue(true);
		mocks.createProviderRuntime.mockReturnValue({ checkAuth: mocks.checkAuth, completeSimple: mocks.completeSimple });
		mocks.providerCredentialOverride.mockImplementation((providerId, credential) => ({ providerId, credential }));
		mocks.resolveModel.mockReturnValue({
			provider: "openai-codex",
			id: "gpt-5.6-terra",
			api: "openai-codex-responses",
		});
	});

	it("returns text and forwards auth, model, credential, and a tool-free conversation context", async () => {
		mocks.completeSimple.mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "  direct answer  " }],
			usage,
		});

		const result = await runConversation({
			provider: "openai-codex",
			model: "gpt-5.6-terra",
			credential: "oauth-envelope",
			system: "Answer directly.",
			prompt: "Hello",
			images: [{ mimeType: "image/png", data: "aGVsbG8=" }],
			sessionId: "session-chat-1",
		});

		expect(mocks.providerCredentialOverride).toHaveBeenCalledWith("openai-codex", "oauth-envelope");
		expect(mocks.createProviderRuntime).toHaveBeenCalledWith({
			providerId: "openai-codex",
			credential: "oauth-envelope",
		});
		expect(mocks.checkAuth).toHaveBeenCalledWith("openai-codex");
		expect(mocks.resolveModel).toHaveBeenCalledWith(expect.anything(), "openai-codex", "gpt-5.6-terra");
		expect(mocks.completeSimple).toHaveBeenCalledWith(
			expect.anything(),
			{
				systemPrompt: "Answer directly.",
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "Hello" },
							{ type: "image", mimeType: "image/png", data: "aGVsbG8=" },
						],
						timestamp: expect.any(Number),
					},
				],
			},
			expect.objectContaining({
				transport: "websocket",
				sessionId: "session-chat-1",
				promptCacheKey: "session-chat-1",
			}),
		);
		expect(mocks.completeSimple.mock.calls[0]?.[1]).not.toHaveProperty("tools");
		expect(result).toEqual({ text: "direct answer", inputTokens: 17, outputTokens: 9 });
		expect(mocks.cleanupSessionResources).toHaveBeenCalledWith("session-chat-1");
	});

	it("rejects a provider tool call and still releases session resources", async () => {
		mocks.completeSimple.mockResolvedValue({
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "tool-1", name: "applyPatch", arguments: {} }],
			usage,
		});

		await expect(
			runConversation({ system: "Chat only.", prompt: "Hello", sessionId: "session-chat-2" }),
		).rejects.toThrow("undeclared tool call");
		expect(mocks.cleanupSessionResources).toHaveBeenCalledWith("session-chat-2");
	});

	it("propagates cancellation and releases the provider session", async () => {
		const controller = new AbortController();
		const cancelled = new Error("cancelled");
		mocks.completeSimple.mockImplementation(async (_model, _context, options) => {
			expect(options.signal).toBe(controller.signal);
			controller.abort(cancelled);
			throw cancelled;
		});

		await expect(
			runConversation({
				system: "Chat only.",
				prompt: "Hello",
				sessionId: "session-chat-3",
				signal: controller.signal,
			}),
		).rejects.toThrow("cancelled");
		expect(mocks.cleanupSessionResources).toHaveBeenCalledWith("session-chat-3");
	});

	it("fails before dispatch when provider authentication is unavailable", async () => {
		mocks.checkAuth.mockResolvedValue(false);
		await expect(
			runConversation({ provider: "openai-codex", model: "gpt-5.6-terra", system: "Chat only.", prompt: "Hello" }),
		).rejects.toThrow("Provider is not authenticated: openai-codex");
		expect(mocks.completeSimple).not.toHaveBeenCalled();
	});
});
