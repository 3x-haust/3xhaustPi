import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import type { CodingTaskEvent } from "./coding-runtime.ts";
import type { ObserverHook } from "./resource-loader.ts";

export interface HookOutcome {
	readonly id: string;
	readonly status: "completed" | "failed" | "timed-out";
	readonly exitCode?: number;
}

function sanitizedEvent(event: CodingTaskEvent): Readonly<Record<string, unknown>> {
	switch (event.type) {
		case "session.started":
			return {
				schemaVersion: 1,
				type: event.type,
				sessionId: event.sessionId,
				provider: event.provider,
				model: event.model,
			};
		case "model.completed":
			return {
				schemaVersion: 1,
				type: event.type,
				responseId: event.responseId,
				usage: event.usage,
				durationMs: event.durationMs,
			};
		case "capability.started":
			return { schemaVersion: 1, type: event.type, capability: event.capability };
		case "capability.completed":
			return {
				schemaVersion: 1,
				type: event.type,
				capability: event.capability,
				success: event.success,
				durationMs: event.durationMs,
			};
		case "patch.proposed":
			return {
				schemaVersion: 1,
				type: event.type,
				patchId: event.patchId,
				targetRevision: event.targetRevision,
				files: event.files,
			};
		case "patch.decision":
			return { schemaVersion: 1, type: event.type, patchId: event.patchId, approved: event.approved };
		case "diagnostics.completed":
			return {
				schemaVersion: 1,
				type: event.type,
				success: event.success,
				command: event.command,
				durationMs: event.durationMs,
			};
		case "assistant.delta":
			return { schemaVersion: 1, type: event.type };
		case "assistant.message":
			return { schemaVersion: 1, type: event.type };
		case "session.completed":
			return {
				schemaVersion: 1,
				type: event.type,
				sessionId: event.sessionId,
				outcome: event.outcome,
				decision: event.decision,
				usage: event.usage,
			};
		case "session.failed":
			return { schemaVersion: 1, type: event.type, sessionId: event.sessionId };
	}
}

function minimalEnvironment(): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH,
		HOME: process.env.HOME ?? homedir(),
		TMPDIR: process.env.TMPDIR ?? tmpdir(),
		LANG: process.env.LANG ?? "C.UTF-8",
	};
}

async function runHook(
	hook: ObserverHook,
	event: CodingTaskEvent,
	options: { readonly cwd: string; readonly timeoutMs: number },
): Promise<HookOutcome> {
	return await new Promise((resolve) => {
		const child = spawn(hook.command, [...hook.args], {
			cwd: options.cwd,
			env: minimalEnvironment(),
			shell: false,
			stdio: ["pipe", "ignore", "ignore"],
		});
		let settled = false;
		const finish = (outcome: HookOutcome) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(outcome);
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish({ id: hook.id, status: "timed-out" });
		}, options.timeoutMs);
		child.once("error", () => finish({ id: hook.id, status: "failed" }));
		child.once("exit", (code) =>
			finish({
				id: hook.id,
				status: code === 0 ? "completed" : "failed",
				...(code === null ? {} : { exitCode: code }),
			}),
		);
		child.stdin.end(`${JSON.stringify(sanitizedEvent(event))}\n`);
	});
}

export async function runObserverHooks(
	hooks: readonly ObserverHook[],
	event: CodingTaskEvent,
	options: { readonly cwd: string; readonly timeoutMs?: number },
): Promise<readonly HookOutcome[]> {
	const matching = hooks.filter((hook) => hook.event === event.type);
	return await Promise.all(
		matching.map((hook) => runHook(hook, event, { cwd: options.cwd, timeoutMs: options.timeoutMs ?? 5_000 })),
	);
}
