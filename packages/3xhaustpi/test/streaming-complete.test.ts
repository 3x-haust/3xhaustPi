import type { Models } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { type CodingTaskEvent, createStreamingComplete } from "../src/coding-runtime.ts";

interface FakeStreamEvent {
	readonly type: string;
	readonly delta?: string;
	readonly error?: unknown;
	readonly message?: unknown;
}

function fakeModels(streamEvents: readonly FakeStreamEvent[], finalMessage: object): Models {
	const stream = {
		async *[Symbol.asyncIterator]() {
			for (const event of streamEvents) yield event;
		},
		result: () => Promise.resolve(finalMessage),
	};
	return { streamSimple: () => stream } as unknown as Models;
}

const FINAL_MESSAGE = {
	role: "assistant",
	content: [{ type: "text", text: "무엇을 도와드릴까요?" }],
	api: "openai-completions",
	provider: "openai-codex",
	model: "gpt-5.6-terra",
	usage: { input: 1, output: 1, cacheRead: 0 },
	stopReason: "stop",
	timestamp: 0,
};

describe("createStreamingComplete", () => {
	it("emits assistant.delta per token and resolves to the final message", async () => {
		const events: CodingTaskEvent[] = [];
		const models = fakeModels(
			[
				{ type: "text_delta", delta: "안녕하세요," },
				{ type: "text_delta", delta: " 반가워요" },
				{ type: "done", message: FINAL_MESSAGE },
			],
			FINAL_MESSAGE,
		);
		const complete = createStreamingComplete(models, (event) => events.push(event));
		const message = await complete({} as never, {} as never);
		expect(message).toBe(FINAL_MESSAGE);
		expect(events.map((event) => event.type)).toEqual(["assistant.delta", "assistant.delta"]);
	});

	it("rejects when the stream reports an error", async () => {
		const failure = new Error("provider exploded");
		const models = fakeModels([{ type: "error", error: failure }], failure);
		const complete = createStreamingComplete(fakeErrorResult(models, failure), () => {});
		await expect(complete({} as never, {} as never)).rejects.toThrow("provider exploded");
	});
});

function fakeErrorResult(models: Models, failure: unknown): Models {
	const original = models.streamSimple.bind(models);
	return {
		...models,
		streamSimple: (...args: Parameters<Models["streamSimple"]>) => {
			const stream = original(...args);
			return {
				...stream,
				result: () => Promise.reject(failure),
			};
		},
	} as Models;
}
