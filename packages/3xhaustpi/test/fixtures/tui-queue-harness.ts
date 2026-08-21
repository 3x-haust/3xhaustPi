import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { ThreeXhaustState } from "../../src/state.ts";
import { runTui, type TuiDesktopHost } from "../../src/tui.ts";

const statePath = process.argv[2];
if (!statePath) throw new Error("state path is required");

const projectRoot = resolve(process.argv[3] ?? process.cwd());
const secondaryProjectRoot = process.argv[4] ? resolve(process.argv[4]) : undefined;
if (secondaryProjectRoot) {
	const state = new ThreeXhaustState(statePath);
	if (state.inspectWorkspace(secondaryProjectRoot).chats.length === 0) {
		const sessionId = "session_fixture_secondary";
		const requestId = "request_fixture_secondary";
		state.beginRun({
			projectId: "project_fixture_secondary",
			projectPath: secondaryProjectRoot,
			sessionId,
			requestId,
			fingerprint: "fingerprint_fixture_secondary",
			payload: JSON.stringify({ objective: "Seeded secondary project chat" }),
			checkpoint: '{"version":1,"phase":"complete"}',
			generation: 1,
		});
		state.markProviderDispatching(requestId, 1);
		state.settleProvider(requestId, "response_fixture_secondary");
		state.completeRun(sessionId, requestId, "completed");
	}
	state.close();
}

const desktopDigest = "a".repeat(64);
const desktopHost: TuiDesktopHost = {
	async listApplications() {
		return {
			trusted: true,
			applications: [{ pid: 4242, name: "Fixture Desktop", bundleId: "test.3xhaustpi.fixture", active: true }],
		};
	},
	async observe() {
		return {
			application: { pid: 4242, name: "Fixture Desktop", frontmost: true },
			digest: desktopDigest,
			capturedAt: new Date().toISOString(),
			durationMs: 1.25,
			elements: [
				{ role: "window", name: "Fixture Desktop" },
				{ role: "button", name: "Toggle details" },
			],
		};
	},
	async act(target, action) {
		if (target.pid !== 4242 || action.action !== "click" || action.target.name !== "Toggle details") {
			throw new Error("fixture received an unexpected semantic action");
		}
		return {
			method: "accessibility",
			digest: "b".repeat(64),
			completedAt: new Date().toISOString(),
			durationMs: 0.75,
		};
	},
};

await runTui({
	projectRoot,
	statePath,
	desktopHost,
	providerConfigured: true,
	runTask: async (activeProjectRoot, objective, hooks) => {
		const sessionId = `session_fixture_${randomUUID()}`;
		const requestId = `request_fixture_${randomUUID()}`;
		const state = new ThreeXhaustState(statePath);
		state.beginRun({
			projectId: `project_fixture_${Buffer.from(activeProjectRoot).toString("hex").slice(-24)}`,
			projectPath: activeProjectRoot,
			sessionId,
			requestId,
			fingerprint: `fingerprint_${randomUUID()}`,
			payload: JSON.stringify({ objective }),
			checkpoint: '{"version":1,"phase":"provider-ready"}',
			generation: 1,
		});
		hooks.onEvent({
			type: "session.started",
			sessionId,
			provider: "fixture-provider",
			model: "fixture-model",
			objective,
		});
		hooks.onEvent({ type: "capability.started", capability: "searchText" });
		await new Promise<void>((resolveWait, rejectWait) => {
			const timeout = setTimeout(resolveWait, 1_500);
			hooks.signal.addEventListener(
				"abort",
				() => {
					clearTimeout(timeout);
					rejectWait(hooks.signal.reason);
				},
				{ once: true },
			);
		});
		hooks.onEvent({
			type: "capability.completed",
			capability: "searchText",
			success: true,
			durationMs: 1.5,
			summary: `Observed ${objective}`,
		});
		hooks.onEvent({ type: "assistant.message", text: `Completed ${objective}` });
		state.markProviderDispatching(requestId, 1);
		state.settleProvider(requestId, `response_${randomUUID()}`);
		state.completeRun(sessionId, requestId, "completed");
		state.close();
		hooks.onEvent({
			type: "session.completed",
			sessionId,
			outcome: "completed",
			decision: "inspect",
			usage: { input: 64, output: 16, cacheRead: 48 },
		});
		return { sessionId };
	},
	resumeTask: async (activeProjectRoot, selectedSessionId, hooks) => {
		const state = new ThreeXhaustState(statePath);
		state.recoverInterruptedRuns();
		const checkpoint = state.claimResumeCheckpoint(selectedSessionId, activeProjectRoot);
		if (!checkpoint) {
			state.close();
			return undefined;
		}
		let objective = "interrupted task";
		try {
			const payload: unknown = JSON.parse(checkpoint.requestPayload);
			if (
				typeof payload === "object" &&
				payload !== null &&
				"objective" in payload &&
				typeof payload.objective === "string"
			) {
				objective = payload.objective;
			}
		} catch {
			objective = "interrupted task";
		}
		hooks.onEvent({
			type: "session.started",
			sessionId: checkpoint.sessionId,
			provider: "fixture-provider",
			model: "fixture-model",
			objective,
		});
		hooks.onEvent({ type: "assistant.message", text: `Recovered ${objective}` });
		state.completeRun(checkpoint.sessionId, checkpoint.requestId, "completed");
		state.close();
		hooks.onEvent({
			type: "session.completed",
			sessionId: checkpoint.sessionId,
			outcome: "completed",
			decision: "inspect",
			usage: { input: 64, output: 16, cacheRead: 48 },
		});
		return { sessionId: checkpoint.sessionId };
	},
});
