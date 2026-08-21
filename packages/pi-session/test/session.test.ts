import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import * as sessionBridge from "../src/index.ts";
import {
	createThreeXhaustSession,
	type ThreeXhaustBrokeredTool,
	validateBrokeredTools,
	X3HAUST_SESSION_BRIDGE_VERSION,
} from "../src/index.ts";

const tool = (name: string) => ({ name }) as ThreeXhaustBrokeredTool;

describe("3xhaustpi session bridge", () => {
	it("exports a stable bridge version", () => {
		expect(X3HAUST_SESSION_BRIDGE_VERSION).toBe(1);
	});

	it("accepts an exact set of namespaced brokered tools", () => {
		expect(
			validateBrokeredTools(
				[tool("workspace.inspect"), tool("patch.apply"), tool("command.run")],
				["workspace.inspect", "patch.apply", "command.run"],
			),
		).toEqual(["command.run", "patch.apply", "workspace.inspect"]);
	});

	it("canonicalizes provider-visible tool order across caller permutations", () => {
		const first = validateBrokeredTools(
			[tool("workspace.inspect"), tool("command.run"), tool("patch.apply")],
			["patch.apply", "workspace.inspect", "command.run"],
		);
		const second = validateBrokeredTools(
			[tool("patch.apply"), tool("workspace.inspect"), tool("command.run")],
			["command.run", "patch.apply", "workspace.inspect"],
		);

		expect(first).toEqual(["command.run", "patch.apply", "workspace.inspect"]);
		expect(second).toEqual(first);
	});

	it("uses one long-lived cache identity and reports cache effectiveness", async () => {
		const models = createModels();
		const provider = fauxProvider({ provider: "3xhaustpi-cache-test" });
		models.setProvider(provider.provider);
		const providerRequests: Array<{ readonly sessionId?: string; readonly cacheRetention?: string }> = [];
		provider.setResponses([
			(_context, options) => {
				providerRequests.push({
					sessionId: options?.sessionId,
					cacheRetention: options?.cacheRetention,
				});
				expect(options?.cacheRetention).toBe("long");
				return fauxAssistantMessage("first");
			},
			(_context, options) => {
				providerRequests.push({
					sessionId: options?.sessionId,
					cacheRetention: options?.cacheRetention,
				});
				expect(options?.cacheRetention).toBe("long");
				return fauxAssistantMessage("second");
			},
		]);
		const session = createThreeXhaustSession({
			bridgeVersion: X3HAUST_SESSION_BRIDGE_VERSION,
			models,
			model: provider.getModel(),
			systemPrompt: "Stable 3xhaustpi prefix. ".repeat(256),
			tools: [],
			allowedToolNames: [],
			toolContext: () => ({
				projectId: "project-1",
				connectionBindingId: "binding-1",
				turnId: "turn-1",
			}),
		});
		await session.prompt("Inspect alpha");
		await session.prompt("Inspect beta");

		expect(new Set(providerRequests.map(({ sessionId }) => sessionId)).size).toBe(1);
		expect(providerRequests.every(({ cacheRetention }) => cacheRetention === "long")).toBe(true);
		expect(session.getMetrics()).toMatchObject({
			providerRequests: 2,
			modelTurns: 2,
			cache: {
				readTokens: expect.any(Number),
				writeTokens: expect.any(Number),
				hitRate: expect.any(Number),
			},
			tools: { calls: 0, succeeded: 0, failed: 0 },
		});
		expect(session.getMetrics().cache.readTokens).toBeGreaterThan(0);
		expect(session.getMetrics().cache.hitRate).toBeGreaterThan(0.25);
	});

	it("executes allowlisted brokered tools and records their lifecycle", async () => {
		const models = createModels();
		const provider = fauxProvider({ provider: "3xhaustpi-tool-test" });
		models.setProvider(provider.provider);
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall("workspace.inspect", { documentId: "document-1" }, { id: "call-1" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Inspection complete"),
		]);
		const executed: Array<{ readonly toolCallId: string; readonly documentId: string; readonly projectId: string }> =
			[];
		const inspectTool = {
			name: "workspace.inspect",
			label: "Inspect workspace document",
			description: "Inspect one 3xhaustpi-owned workspace document.",
			parameters: {
				type: "object",
				properties: { documentId: { type: "string" } },
				required: ["documentId"],
				additionalProperties: false,
			},
			execute: async (
				toolCallId: string,
				params: { readonly documentId: string },
				_signal: AbortSignal | undefined,
				_onUpdate: unknown,
				context: { readonly projectId: string },
			) => {
				executed.push({ toolCallId, documentId: params.documentId, projectId: context.projectId });
				return { content: [{ type: "text", text: "document contents" }], details: { bytes: 17 } };
			},
		} as ThreeXhaustBrokeredTool;
		const session = createThreeXhaustSession({
			bridgeVersion: X3HAUST_SESSION_BRIDGE_VERSION,
			models,
			model: provider.getModel(),
			systemPrompt: "Use only brokered 3xhaustpi tools.",
			tools: [inspectTool],
			allowedToolNames: ["workspace.inspect"],
			toolContext: () => ({
				projectId: "project-1",
				connectionBindingId: "binding-1",
				turnId: "turn-1",
			}),
		});
		const lifecycle: string[] = [];
		session.subscribe((event) => {
			if (event.type.startsWith("tool_execution_")) lifecycle.push(event.type);
		});

		await session.prompt("Inspect the selected document");

		expect(executed).toEqual([{ toolCallId: "call-1", documentId: "document-1", projectId: "project-1" }]);
		expect(lifecycle).toEqual(["tool_execution_start", "tool_execution_end"]);
		expect(session.getMetrics().tools).toMatchObject({
			calls: 1,
			succeeded: 1,
			failed: 0,
			successRate: 1,
		});
	});

	it("contains brokered tool failures and records a failed lifecycle", async () => {
		const models = createModels();
		const provider = fauxProvider({ provider: "3xhaustpi-tool-failure-test" });
		models.setProvider(provider.provider);
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall("command.run", { commandId: "command-1" }, { id: "call-failed" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("The command failed safely."),
		]);
		const failingTool = {
			name: "command.run",
			label: "Run brokered command",
			description: "Run one host-approved command.",
			parameters: {
				type: "object",
				properties: { commandId: { type: "string" } },
				required: ["commandId"],
				additionalProperties: false,
			},
			execute: async () => {
				throw new Error("host denied command");
			},
		} as ThreeXhaustBrokeredTool;
		const session = createThreeXhaustSession({
			bridgeVersion: X3HAUST_SESSION_BRIDGE_VERSION,
			models,
			model: provider.getModel(),
			systemPrompt: "Use only brokered 3xhaustpi tools.",
			tools: [failingTool],
			allowedToolNames: ["command.run"],
			toolContext: () => ({
				projectId: "project-1",
				connectionBindingId: "binding-1",
				turnId: "turn-1",
			}),
		});

		await expect(session.prompt("Run the approved command")).resolves.toBeDefined();
		expect(session.getMetrics().tools).toEqual({
			calls: 1,
			succeeded: 0,
			failed: 1,
			successRate: 0,
		});
	});

	it.each(["read", "bash", "write", "workspace", "extension.run", "../workspace.inspect"])(
		"rejects ambient or unowned tool %s",
		(name) => {
			expect(() => validateBrokeredTools([tool(name)], [name])).toThrow("not brokered by 3xhaustPi");
		},
	);

	it("rejects missing, extra, and duplicate implementations", () => {
		expect(() => validateBrokeredTools([tool("workspace.inspect")], ["workspace.inspect", "patch.apply"])).toThrow(
			"exactly one implementation",
		);
		expect(() => validateBrokeredTools([tool("workspace.inspect")], ["patch.apply"])).toThrow(
			"outside the explicit allowlist",
		);
		expect(() =>
			validateBrokeredTools([tool("workspace.inspect"), tool("workspace.inspect")], ["workspace.inspect"]),
		).toThrow("must be unique");
	});
});

type SemanticRequest = {
	readonly prompt: string;
	readonly semanticTurn?: Readonly<Record<string, unknown>>;
	readonly repairOf?: string;
	readonly tools: readonly never[];
	readonly mode?: "prompt" | "steer" | "followUp";
	readonly signal?: AbortSignal;
};

type SemanticEnvelope = {
	readonly protocolVersion: 2;
	readonly kind: "intent" | "patchProposal";
	readonly payload: Readonly<Record<string, unknown>>;
};

type SemanticSessionFactory = (input: { readonly complete: (request: SemanticRequest) => Promise<string> }) => {
	readonly prompt: (text: string) => Promise<SemanticEnvelope>;
	readonly steer: (text: string) => Promise<SemanticEnvelope>;
	readonly followUp: (text: string) => Promise<SemanticEnvelope>;
	readonly abort: () => void;
};

function semanticSessionFactory(): SemanticSessionFactory {
	const factory = (sessionBridge as unknown as { createThreeXhaustSemanticSession?: SemanticSessionFactory })
		.createThreeXhaustSemanticSession;
	expect(factory, "semantic session factory must exist").toBeTypeOf("function");
	if (!factory) throw new Error("semantic session factory must exist");
	return factory;
}

const strictSemanticIntent = {
	protocolVersion: 2,
	kind: "intent",
	payload: {
		kind: "inspect",
		objective: "Inspect the selected document",
		target: { kind: "documents", documentIds: ["doc_selected"] },
		evidenceGoals: ["Observe current behavior"],
		constraints: [],
		doneWhen: "An observation supports the answer",
	},
} as const;

describe("3xhaustpi semantic session", () => {
	it("keeps side-effecting tool schemas out of provider requests", async () => {
		const requests: SemanticRequest[] = [];
		const session = semanticSessionFactory()({
			complete: async (request) => {
				requests.push(request);
				return JSON.stringify(strictSemanticIntent);
			},
		});

		await expect(session.prompt("Inspect the selected document")).resolves.toEqual(strictSemanticIntent);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.tools).toEqual([]);
	});

	it("repairs one invalid semantic response and then stops", async () => {
		const responses = [
			JSON.stringify({
				kind: "intent",
				payload: { intent: "inspect", toolName: "workspace.search", path: "/tmp/private" },
			}),
			JSON.stringify(strictSemanticIntent),
		];
		const requests: SemanticRequest[] = [];
		const session = semanticSessionFactory()({
			complete: async (request) => {
				requests.push(request);
				return responses[requests.length - 1] ?? "";
			},
		});

		await expect(session.prompt("Inspect safely")).resolves.toMatchObject({
			kind: "intent",
			payload: { kind: "inspect" },
		});
		expect(requests).toHaveLength(2);
		expect(requests[1]?.repairOf).toBe(responses[0]);
		expect(requests.every((request) => request.tools.length === 0)).toBe(true);
	});

	it("rejects malformed output after one bounded repair", async () => {
		const requests: SemanticRequest[] = [];
		const session = semanticSessionFactory()({
			complete: async (request) => {
				requests.push(request);
				return requests.length === 1
					? "not-json"
					: JSON.stringify({
							...strictSemanticIntent,
							payload: { ...strictSemanticIntent.payload, command: "rm -rf /" },
						});
			},
		});

		await expect(session.prompt("Do something unsafe")).rejects.toThrow("Semantic response");
		expect(requests).toHaveLength(2);
	});

	it.each(["tool", "toolName", "capability", "path", "command", "timeoutMs", "retries", "permission"])(
		"rejects runtime-owned field %s anywhere in semantic payloads",
		async (field) => {
			const value = JSON.stringify({
				protocolVersion: 2,
				kind: "patchProposal",
				payload: {
					edits: [{ documentId: "doc_selected", oldText: "before", newText: "after", [field]: "forbidden" }],
					assumptions: [],
					verificationGoals: [],
				},
			});
			const session = semanticSessionFactory()({ complete: async () => value });

			await expect(session.prompt("Propose an edit")).rejects.toThrow("Semantic response");
		},
	);

	it("preserves prompt, steer, and follow-up modes without exposing tools", async () => {
		const requests: SemanticRequest[] = [];
		const session = semanticSessionFactory()({
			complete: async (request) => {
				requests.push(request);
				return JSON.stringify(strictSemanticIntent);
			},
		});

		await session.prompt("First");
		await session.steer("Second");
		await session.followUp("Third");

		expect(requests.map(({ mode }) => mode)).toEqual(["prompt", "steer", "followUp"]);
		expect(requests.every(({ tools }) => tools.length === 0)).toBe(true);
	});

	it("aborts an active semantic provider request", async () => {
		let activeRequest: SemanticRequest | undefined;
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const session = semanticSessionFactory()({
			complete: async (request) => {
				activeRequest = request;
				markStarted?.();
				return new Promise<string>((_resolve, reject) => {
					request.signal?.addEventListener("abort", () => reject(new Error("provider aborted")), {
						once: true,
					});
				});
			},
		});

		const pending = session.prompt("Wait");
		await started;
		session.abort();

		expect(activeRequest?.signal?.aborted).toBe(true);
		await expect(pending).rejects.toThrow("provider aborted");
	});
});
