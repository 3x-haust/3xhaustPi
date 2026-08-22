let approvalPending = false;

process.on("message", (message) => {
	if (message?.type === "start") {
		if (message.request?.objective === "wait") return;
		if (message.request?.objective === "result-with-open-handle") {
			process.send?.({ type: "result", available: true, result: { pid: process.pid } });
			setInterval(() => {}, 60_000);
			return;
		}
		if (message.request?.objective === "result-ignoring-sigterm") {
			process.on("SIGTERM", () => {});
			process.send?.({ type: "result", available: true, result: { pid: process.pid } });
			setInterval(() => {}, 60_000);
			return;
		}
		process.send?.({
			type: "event",
			event: {
				type: "session.started",
				sessionId: "session_fixture_worker",
				provider: "fixture-provider",
				model: "fixture-model",
				objective: message.request?.objective ?? "fixture",
			},
		});
		approvalPending = true;
		process.send?.({
			type: "approval",
			proposal: {
				patchId: "patch_fixture_worker",
				files: ["src/fixture.ts"],
				diff: "--- a/src/fixture.ts\n+++ b/src/fixture.ts",
			},
		});
		return;
	}
	if (message?.type === "approval-decision" && approvalPending) {
		approvalPending = false;
		process.send?.({
			type: "event",
			event: {
				type: "capability.completed",
				capability: "applyPatch",
				success: message.approved,
				durationMs: 0.5,
				summary: "fixture worker completed",
			},
		});
		process.send?.({ type: "result", available: true, result: { approved: message.approved } });
		setImmediate(() => process.disconnect?.());
		return;
	}
	if (message?.type === "abort") {
		process.send?.({ type: "error", message: "fixture worker aborted" });
		setImmediate(() => process.disconnect?.());
	}
});
