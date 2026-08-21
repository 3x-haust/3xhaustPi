import { fork } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodingTaskEvent, CodingTaskPatchProposal } from "./coding-runtime.ts";

export interface TuiRuntimeHooks {
	readonly onEvent: (event: CodingTaskEvent) => void;
	readonly requestApproval: (proposal: CodingTaskPatchProposal) => Promise<boolean>;
	readonly signal: AbortSignal;
}

export type TuiRuntimeRequest =
	| {
			readonly mode: "run";
			readonly projectRoot: string;
			readonly objective: string;
			readonly provider?: string;
			readonly model?: string;
			readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
			readonly allowProjectHooks?: boolean;
	  }
	| {
			readonly mode: "resume";
			readonly projectRoot: string;
			readonly sessionId?: string;
			readonly allowProjectHooks?: boolean;
	  };

export function createTuiRunRequest(input: {
	readonly projectRoot: string;
	readonly objective: string;
	readonly selectedModel: { readonly provider: string; readonly model: string };
	readonly allowProjectHooks?: boolean;
}): TuiRuntimeRequest {
	return {
		mode: "run",
		projectRoot: input.projectRoot,
		objective: input.objective,
		provider: input.selectedModel.provider,
		model: input.selectedModel.model,
		...(input.allowProjectHooks ? { allowProjectHooks: true } : {}),
	};
}

type RuntimeWorkerMessage =
	| { readonly type: "event"; readonly event: CodingTaskEvent }
	| { readonly type: "approval"; readonly proposal: CodingTaskPatchProposal }
	| { readonly type: "result"; readonly available: boolean; readonly result?: unknown }
	| { readonly type: "error"; readonly message: string };

const defaultWorkerPath = join(dirname(fileURLToPath(import.meta.url)), "tui-runtime-worker.js");

function isWorkerMessage(value: unknown): value is RuntimeWorkerMessage {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const type = (value as { readonly type?: unknown }).type;
	return type === "event" || type === "approval" || type === "result" || type === "error";
}

export async function runTuiRuntime(
	request: TuiRuntimeRequest,
	hooks: TuiRuntimeHooks,
	options: { readonly workerPath?: string } = {},
): Promise<unknown> {
	return await new Promise((resolve, reject) => {
		const child = fork(options.workerPath ?? defaultWorkerPath, [], {
			env: process.env,
			serialization: "json",
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		let stderr = "";
		let stdout = "";
		let settled = false;
		let abortTimer: NodeJS.Timeout | undefined;
		const finish = (error?: Error, value?: unknown) => {
			if (settled) return;
			settled = true;
			if (abortTimer) clearTimeout(abortTimer);
			hooks.signal.removeEventListener("abort", abort);
			if (error) reject(error);
			else resolve(value);
		};
		const abort = () => {
			if (child.connected) child.send({ type: "abort" });
			abortTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
		};
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout = `${stdout}${chunk}`.slice(-65_536);
		});
		child.stderr?.on("data", (chunk: string) => {
			stderr = `${stderr}${chunk}`.slice(-65_536);
		});
		child.on("message", (message: unknown) => {
			if (!isWorkerMessage(message)) {
				child.kill("SIGKILL");
				finish(new Error("TUI runtime worker returned an invalid message."));
				return;
			}
			if (message.type === "event") {
				hooks.onEvent(message.event);
				return;
			}
			if (message.type === "approval") {
				void hooks.requestApproval(message.proposal).then(
					(approved) => {
						if (child.connected) child.send({ type: "approval-decision", approved });
					},
					(error: unknown) => {
						if (child.connected) child.send({ type: "approval-decision", approved: false });
						finish(error instanceof Error ? error : new Error(String(error)));
					},
				);
				return;
			}
			if (message.type === "error") {
				finish(new Error(message.message));
				return;
			}
			finish(undefined, message.available ? message.result : undefined);
		});
		child.once("error", (error) => finish(error));
		child.once("exit", (code, signal) => {
			if (settled) return;
			const detail = (stderr || stdout).trim().slice(-2_048);
			finish(new Error(detail || `TUI runtime worker exited before completion (${signal ?? code ?? "unknown"}).`));
		});
		hooks.signal.addEventListener("abort", abort, { once: true });
		if (hooks.signal.aborted) abort();
		else child.send({ type: "start", request });
	});
}
