import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runObserverHooks } from "../src/hook-runner.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("observer hooks", () => {
	it("runs without a shell and exposes only sanitized event fields", async () => {
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-hook-"));
		temporaryDirectories.push(root);
		const output = join(root, "event.json");
		const script = join(root, "capture.mjs");
		writeFileSync(
			script,
			`import { writeFileSync } from "node:fs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
writeFileSync(process.argv[2], JSON.stringify({ event: JSON.parse(input), env: process.env }));
`,
		);
		chmodSync(script, 0o755);

		const outcomes = await runObserverHooks(
			[
				{
					id: "capture",
					event: "session.completed",
					command: process.execPath,
					args: [script, output],
					scope: "user",
					sourcePath: script,
				},
			],
			{
				type: "session.completed",
				sessionId: "session_test",
				outcome: "completed",
				decision: "completionSuggestion",
				usage: { input: 10, output: 5, cacheRead: 2 },
			},
			{ cwd: root, timeoutMs: 2_000 },
		);

		expect(outcomes).toEqual([{ id: "capture", status: "completed", exitCode: 0 }]);
		const captured = JSON.parse(readFileSync(output, "utf8")) as {
			event: Record<string, unknown>;
			env: Record<string, string>;
		};
		expect(captured.event).toEqual({
			schemaVersion: 1,
			type: "session.completed",
			sessionId: "session_test",
			outcome: "completed",
			decision: "completionSuggestion",
			usage: { input: 10, output: 5, cacheRead: 2 },
		});
		expect(captured.env.OPENAI_API_KEY).toBeUndefined();
		expect(captured.env.NPM_TOKEN).toBeUndefined();
	});
});
