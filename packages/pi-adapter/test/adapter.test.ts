import { parseSemanticTurnRequest } from "@3xhaust/semantic-contract";
import {
	type AssistantMessage,
	type Context,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	createThreeXhaustPiAdapter,
	type PiComplete,
	type PiSemanticConnectionBinding,
	type SemanticTurnResult,
} from "../src/index.ts";
import { createSemanticContext } from "../src/prompt.ts";

const validOutput = {
	protocolVersion: 2,
	kind: "intent",
	payload: {
		kind: "inspect",
		objective: "Inspect the selected behavior.",
		target: { kind: "documents", documentIds: ["doc_selected"], hint: "src/index.ts is inert text" },
		evidenceGoals: ["Observe current behavior"],
		constraints: [],
		doneWhen: "An observation supports the answer",
	},
} as const;

const turn = parseSemanticTurnRequest({
	protocolVersion: 2,
	mode: "prompt",
	objective: "Inspect safely",
	disclosed: { selectionIds: [], documentIds: ["doc_selected"], observationIds: [] },
});

function binding(model: Model<string>): PiSemanticConnectionBinding {
	return {
		connectionId: "connection_test",
		model,
		sessionId: "session_test",
		cacheRetention: "long",
		cacheUsageSupport: { read: "reported", write: "unsupported" },
	};
}

function message(text: string, usage?: Partial<AssistantMessage["usage"]>): AssistantMessage {
	const base = fauxAssistantMessage(text, { responseId: "response_test" });
	return { ...base, usage: { ...base.usage, ...usage } };
}

describe("3xhaustpi Pi semantic adapter", () => {
	it("keeps a provider-cacheable stable contract prefix", () => {
		const handle = fauxProvider();
		const adapter = createThreeXhaustPiAdapter({ complete: async () => message(JSON.stringify(validOutput)) });
		expect(adapter.stablePrefix.length).toBeGreaterThanOrEqual(4_096);
		expect(adapter.stablePrefix).toContain('"kind":"intent","payload":{"kind":"complete"');
		expect(handle.getModel()).toBeDefined();
	});

	it("sends byte-stable tool-free provider contexts", async () => {
		const handle = fauxProvider();
		const contexts: Context[] = [];
		const options: Array<SimpleStreamOptions | undefined> = [];
		const complete: PiComplete = async (_model, context, requestOptions) => {
			contexts.push(structuredClone(context));
			options.push(requestOptions);
			return message(JSON.stringify(validOutput), { input: 100, output: 20, cacheRead: 80, cacheWrite: 0 });
		};
		const adapter = createThreeXhaustPiAdapter({ complete, now: () => 1_000 });
		const session = adapter.open(binding(handle.getModel()));

		const result = await session.submit(turn, new AbortController().signal);

		expect(result.output).toEqual(validOutput);
		expect(contexts).toHaveLength(1);
		expect(contexts[0]?.tools).toEqual([]);
		expect(contexts[0]?.systemPrompt).toBe(
			"3xhaustpi semantic boundary. Follow the stable contract in the first user message.",
		);
		expect(contexts[0]?.messages[0]).toEqual({
			role: "user",
			content: [
				{
					type: "text",
					text: expect.stringContaining(adapter.stablePrefix),
				},
			],
			timestamp: 0,
		});
		expect(contexts[0]?.messages[0]).toEqual(
			expect.objectContaining({
				role: "user",
				content: [expect.objectContaining({ text: expect.stringContaining('"o":"Inspect safely"') })],
			}),
		);
		expect(options[0]).toMatchObject({
			cacheRetention: "long",
			sessionId: "session_test-initial",
			promptCacheKey: "session_test-initial",
			maxRetries: 0,
		});
	});

	it("compacts an exact inspect target without changing its semantic fields", () => {
		const context = createSemanticContext(
			parseSemanticTurnRequest({
				protocolVersion: 2,
				mode: "prompt",
				objective: 'Return inspect for {"kind":"symbol","hint":"POLICY_VERSION"}.',
				disclosed: { selectionIds: [], documentIds: [], observationIds: [] },
			}),
			undefined,
			"bounded evidence",
		);
		const content = context.messages[0]?.content;
		const text = Array.isArray(content) ? content[0] : undefined;

		expect(text?.type).toBe("text");
		if (text?.type !== "text") throw new Error("Expected a compact text prompt");
		expect(text.text).toContain('"q":["s","POLICY_VERSION"]');
		expect(text.text).not.toContain("Return inspect for");
		expect(text.text).not.toContain('"d":"*"');
	});

	it("reuses the Codex WebSocket without carrying continuation state across tasks", async () => {
		const handle = fauxProvider();
		let options: SimpleStreamOptions | undefined;
		const complete: PiComplete = async (_model, _context, requestOptions) => {
			options = requestOptions;
			return message(JSON.stringify(validOutput));
		};
		const codexModel = { ...handle.getModel(), api: "openai-codex-responses" } as Model<string>;
		const session = createThreeXhaustPiAdapter({ complete }).open(binding(codexModel));

		await session.submit(turn, new AbortController().signal);

		expect(options?.transport).toBe("websocket");
		expect(options?.sessionId).toBe("session_test-initial");
	});

	it("keeps bounded stable project evidence ahead of the dynamic turn", async () => {
		const handle = fauxProvider();
		const contexts: Context[] = [];
		const complete: PiComplete = async (_model, context) => {
			contexts.push(structuredClone(context));
			return message(JSON.stringify(validOutput));
		};
		const adapter = createThreeXhaustPiAdapter({ complete });
		const session = adapter.open({ ...binding(handle.getModel()), stableContext: "sha256:abc\nrelevant source" });

		await session.submit(turn, new AbortController().signal);

		expect(contexts[0]?.messages[0]).toEqual(
			expect.objectContaining({
				role: "user",
				content: [
					expect.objectContaining({
						type: "text",
						text: expect.stringContaining("sha256:abc\nrelevant source"),
					}),
				],
			}),
		);
	});

	it("places bounded images on the dynamic semantic turn", async () => {
		const handle = fauxProvider();
		let context: Context | undefined;
		const complete: PiComplete = async (_model, nextContext) => {
			context = structuredClone(nextContext);
			return message(JSON.stringify(validOutput));
		};
		const session = createThreeXhaustPiAdapter({ complete }).open(binding(handle.getModel()));

		await session.submit(turn, new AbortController().signal, [
			{ type: "image", mimeType: "image/webp", data: "YWJjZA==" },
		]);

		expect(context?.messages[1]).toEqual(
			expect.objectContaining({
				role: "user",
				content: [
					expect.objectContaining({ type: "text", text: expect.stringContaining("Bounded image evidence") }),
					{ type: "image", mimeType: "image/webp", data: "YWJjZA==" },
				],
			}),
		);
	});

	it("accepts transport whitespace and a byte-order mark around one otherwise strict JSON object", async () => {
		const handle = fauxProvider();
		const complete: PiComplete = async () => message(`\uFEFF${JSON.stringify(validOutput)}\n`);
		const session = createThreeXhaustPiAdapter({ complete }).open(binding(handle.getModel()));

		await expect(session.submit(turn, new AbortController().signal)).resolves.toMatchObject({
			output: validOutput,
			attempts: 1,
			normalization: "none",
		});
	});

	it("normalizes exactly one unmatched trailing delimiter before strict protocol validation", async () => {
		const handle = fauxProvider();
		const complete: PiComplete = async () => message(`${JSON.stringify(validOutput)}}`);
		const session = createThreeXhaustPiAdapter({ complete }).open(binding(handle.getModel()));

		await expect(session.submit(turn, new AbortController().signal)).resolves.toMatchObject({
			output: validOutput,
			attempts: 1,
			normalization: "trailing-delimiter",
		});
	});

	it("does not discard trailing commentary", async () => {
		const handle = fauxProvider();
		let calls = 0;
		const complete: PiComplete = async () => {
			calls += 1;
			return message(`${JSON.stringify(validOutput)} commentary`);
		};
		const session = createThreeXhaustPiAdapter({ complete }).open(binding(handle.getModel()));

		await expect(session.submit(turn, new AbortController().signal)).rejects.toThrow("invalid after one repair");
		expect(calls).toBe(2);
	});

	it("repairs once without changing the stable prefix or exposing tools", async () => {
		const handle = fauxProvider();
		const contexts: Context[] = [];
		const responses = [
			message('{"kind":"intent","payload":{"path":"/tmp/private"}}'),
			message(JSON.stringify(validOutput)),
		];
		const complete: PiComplete = async (_model, context) => {
			contexts.push(structuredClone(context));
			return responses[contexts.length - 1] ?? responses[0]!;
		};
		const adapter = createThreeXhaustPiAdapter({ complete, now: () => contexts.length * 10 });
		const session = adapter.open(binding(handle.getModel()));

		await expect(session.submit(turn, new AbortController().signal)).resolves.toMatchObject({ attempts: 2 });
		const firstContent = contexts[0]?.messages[0]?.content;
		const repairContent = contexts[1]?.messages[0]?.content;
		const firstText = Array.isArray(firstContent) ? firstContent[0] : undefined;
		const repairText = Array.isArray(repairContent) ? repairContent[0] : undefined;
		expect(firstText?.type).toBe("text");
		expect(repairText?.type).toBe("text");
		if (firstText?.type !== "text" || repairText?.type !== "text") throw new Error("Expected text prompts");
		expect(firstText.text.slice(0, adapter.stablePrefix.length)).toBe(
			repairText.text.slice(0, adapter.stablePrefix.length),
		);
		expect(firstText.text).toContain('\n{"o":"Inspect safely"');
		expect(repairText.text).toContain('"repair"');
		expect(contexts[0]?.messages[0]).toEqual(
			expect.objectContaining({
				content: [
					expect.objectContaining({
						text: expect.stringContaining(adapter.stablePrefix),
					}),
				],
			}),
		);
		expect(contexts.every(({ tools }) => tools?.length === 0)).toBe(true);
	});

	it("repairs a completion that claims an undisclosed observation", async () => {
		const handle = fauxProvider();
		let calls = 0;
		const invalidCompletion = {
			protocolVersion: 2,
			kind: "intent",
			payload: {
				kind: "complete",
				summary: "Finished without evidence",
				claims: [{ observationRef: "obs_invented", claim: "Invented claim" }],
			},
		};
		const complete: PiComplete = async () => {
			calls += 1;
			return message(JSON.stringify(calls === 1 ? invalidCompletion : validOutput));
		};
		const session = createThreeXhaustPiAdapter({ complete }).open(binding(handle.getModel()));

		await expect(session.submit(turn, new AbortController().signal)).resolves.toMatchObject({
			output: validOutput,
			attempts: 2,
		});
	});

	it("rejects provider tool calls and stops after one failed repair", async () => {
		const handle = fauxProvider();
		let calls = 0;
		const complete: PiComplete = async () => {
			calls += 1;
			return fauxAssistantMessage(fauxToolCall("workspace.read", {}, { id: "call_1" }));
		};
		const session = createThreeXhaustPiAdapter({ complete }).open(binding(handle.getModel()));

		await expect(session.submit(turn, new AbortController().signal)).rejects.toThrow("invalid after one repair");
		expect(calls).toBe(2);
	});

	it("reports provider usage with explicit cache provenance", async () => {
		const handle = fauxProvider();
		const complete: PiComplete = async () =>
			message(JSON.stringify(validOutput), { input: 50, output: 10, cacheRead: 40, cacheWrite: 0 });
		const session = createThreeXhaustPiAdapter({ complete, now: () => 100 }).open(binding(handle.getModel()));

		const result: SemanticTurnResult = await session.submit(turn, new AbortController().signal);

		expect(result.usage.input).toEqual({ status: "measured", value: 50, source: "provider-usage" });
		expect(result.usage.cacheRead).toEqual({ status: "measured", value: 40, source: "provider-usage" });
		expect(result.usage.cacheWrite).toEqual({
			status: "unsupported",
			reason: "provider does not report cache writes",
		});
		expect(result.provider).toBe("faux");
		expect(result.responseId).toBe("response_test");
	});
});
