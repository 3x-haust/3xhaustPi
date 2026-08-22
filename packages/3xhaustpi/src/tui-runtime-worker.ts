import { runAgentTask } from "./agent-runtime.ts";
import { resumeCodingTask, runCodingTask } from "./coding-runtime.ts";
import type { TuiRuntimeRequest } from "./tui-runtime-client.ts";

type ParentMessage =
	| { readonly type: "start"; readonly request: TuiRuntimeRequest }
	| { readonly type: "approval-decision"; readonly approved: boolean }
	| { readonly type: "abort" };

let started = false;
let controller: AbortController | undefined;
let approvalResolve: ((approved: boolean) => void) | undefined;

function send(message: unknown): void {
	if (process.connected) process.send?.(message);
}

function isParentMessage(value: unknown): value is ParentMessage {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const type = (value as { readonly type?: unknown }).type;
	return type === "start" || type === "approval-decision" || type === "abort";
}

async function execute(request: TuiRuntimeRequest): Promise<void> {
	controller = new AbortController();
	const hooks = {
		onEvent: (event: Parameters<NonNullable<Parameters<typeof runCodingTask>[0]["onEvent"]>>[0]) =>
			send({ type: "event", event }),
		requestApproval: (proposal: Parameters<NonNullable<Parameters<typeof runCodingTask>[0]["requestApproval"]>>[0]) =>
			new Promise<boolean>((resolve) => {
				if (approvalResolve) throw new Error("A TUI runtime approval is already pending.");
				approvalResolve = resolve;
				send({ type: "approval", proposal });
			}),
		signal: controller.signal,
	};
	const result =
		request.mode === "run"
			? await executeRun(request, hooks)
			: await resumeCodingTask({
					projectRoot: request.projectRoot,
					approve: false,
					...hooks,
					resources: { enabled: true, allowProjectHooks: request.allowProjectHooks },
					...(request.sessionId ? { sessionId: request.sessionId } : {}),
				});
	send({ type: "result", available: result !== undefined, ...(result === undefined ? {} : { result }) });
}

/**
 * Full agent runtime first; the legacy semantic task stays as a stability
 * fallback while the migration settles.
 */
async function executeRun(
	request: Extract<TuiRuntimeRequest, { mode: "run" }>,
	hooks: {
		onEvent: NonNullable<Parameters<typeof runCodingTask>[0]["onEvent"]>;
		requestApproval: NonNullable<Parameters<typeof runCodingTask>[0]["requestApproval"]>;
		signal: AbortSignal;
	},
) {
	try {
		return await runAgentTask({
			projectRoot: request.projectRoot,
			objective: request.objective,
			...(request.provider ? { provider: request.provider } : {}),
			...(request.model ? { model: request.model } : {}),
			...(request.sessionId ? { sessionId: request.sessionId } : {}),
			...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}),
			signal: hooks.signal,
			onEvent: hooks.onEvent,
		});
	} catch (error) {
		if (request.sessionId) throw error;
		send({
			type: "event",
			event: {
				type: "assistant.message",
				text: `Agent runtime unavailable, falling back: ${error instanceof Error ? error.message : String(error)}`,
			},
		});
		return runCodingTask({
			projectRoot: request.projectRoot,
			objective: request.objective,
			approve: false,
			...hooks,
			resources: { enabled: true, allowProjectHooks: request.allowProjectHooks },
			...(request.provider ? { provider: request.provider } : {}),
			...(request.model ? { model: request.model } : {}),
		});
	}
}

process.on("message", (message: unknown) => {
	if (!isParentMessage(message)) {
		send({ type: "error", message: "TUI runtime worker received an invalid message." });
		return;
	}
	if (message.type === "abort") {
		controller?.abort(new Error("TUI runtime cancelled."));
		if (approvalResolve) {
			const resolve = approvalResolve;
			approvalResolve = undefined;
			resolve(false);
		}
		return;
	}
	if (message.type === "approval-decision") {
		if (!approvalResolve) {
			send({ type: "error", message: "TUI runtime worker has no pending approval." });
			return;
		}
		const resolve = approvalResolve;
		approvalResolve = undefined;
		resolve(message.approved);
		return;
	}
	if (started) {
		send({ type: "error", message: "TUI runtime worker already started." });
		return;
	}
	started = true;
	void execute(message.request)
		.catch((cause) => {
			const detail = cause instanceof Error ? cause.message : String(cause);
			send({ type: "error", message: detail.replace(/\s+/gu, " ").trim().slice(0, 1_024) });
		})
		.finally(() => {
			setImmediate(() => process.disconnect?.());
		});
});
