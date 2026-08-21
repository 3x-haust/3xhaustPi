import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "../src/api/openai-codex-responses.ts";
import { getModel } from "../src/compat.ts";

interface CapturedPayload {
	prompt_cache_key?: string;
	prompt_cache_retention?: string;
}

async function capturePayload(
	cacheRetention: "none" | "short" | "long",
	promptCacheKey?: string,
): Promise<CapturedPayload> {
	let captured: CapturedPayload | undefined;
	const apiKey = `header.${btoa(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } }),
	)}.signature`;
	const response = new Response("data: [DONE]\n\n", {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
	const request = streamSimple(
		getModel("openai-codex", "gpt-5.5"),
		{
			systemPrompt: "Reply concisely.",
			messages: [{ role: "user", content: "hello", timestamp: 0 }],
		},
		{
			apiKey,
			cacheRetention,
			sessionId: "cache-session",
			...(promptCacheKey ? { promptCacheKey } : {}),
			transport: "sse",
			fetch: vi.fn().mockResolvedValue(response),
			onPayload: (payload) => {
				captured = payload as CapturedPayload;
			},
		},
	);
	for await (const event of request) {
		if (event.type === "done" || event.type === "error") break;
	}
	if (!captured) throw new Error("Codex request payload was not captured");
	return captured;
}

describe("openai-codex prompt cache request fields", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps long retention implicit because the ChatGPT Codex endpoint rejects the API field", async () => {
		const payload = await capturePayload("long");

		expect(payload.prompt_cache_key).toBe("cache-session");
		expect(payload.prompt_cache_retention).toBeUndefined();
	});

	it("keeps short caching implicit", async () => {
		const payload = await capturePayload("short");

		expect(payload.prompt_cache_key).toBe("cache-session");
		expect(payload.prompt_cache_retention).toBeUndefined();
	});

	it("separates prompt-cache routing from the transport session", async () => {
		const payload = await capturePayload("long", "semantic-followup");

		expect(payload.prompt_cache_key).toBe("semantic-followup");
	});

	it("omits all prompt cache fields when caching is disabled", async () => {
		const payload = await capturePayload("none");

		expect(payload.prompt_cache_key).toBeUndefined();
		expect(payload.prompt_cache_retention).toBeUndefined();
	});
});
