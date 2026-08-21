import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ThreeXhaustState } from "../src/state.ts";

const CHILD_SCRIPT = `
const { DatabaseSync } = require("node:sqlite");
const database = new DatabaseSync(process.argv[1]);
database.exec("PRAGMA journal_mode = WAL;");
database.exec("BEGIN IMMEDIATE");
process.stdout.write("locked\\n");
setTimeout(() => {
	database.exec("COMMIT");
	process.exit(0);
}, 300);
`;

describe("ThreeXhaustState concurrent writers", () => {
	it("waits out cross-process write locks instead of failing with SQLITE_BUSY", async () => {
		const stateDirectory = mkdtempSync(join(tmpdir(), "3xhaustpi-sqlite-"));
		const statePath = join(stateDirectory, "state.sqlite");
		const state = new ThreeXhaustState(statePath);
		const enqueued = state.enqueueTuiRequest({
			requestId: "req_contention",
			projectPath: "/tmp/3xhaustpi-contention",
			fingerprint: "fp_contention",
			objective: "Hold the queue row across a foreign write lock",
		});
		expect(enqueued.inserted).toBe(true);
		state.claimNextTuiRequest("/tmp/3xhaustpi-contention");

		const child = spawn(process.execPath, ["-e", CHILD_SCRIPT, statePath], {
			stdio: ["ignore", "pipe", "inherit"],
		});
		try {
			await new Promise<void>((resolve, reject) => {
				child.stdout.on("data", (chunk: Buffer) => {
					if (chunk.toString().includes("locked")) resolve();
				});
				child.once("error", reject);
			});

			let completed = false;
			try {
				state.completeTuiRequest("req_contention", "completed");
				completed = true;
			} finally {
				child.kill("SIGKILL");
			}
			expect(completed).toBe(true);
			const requests = state.listTuiRequests("/tmp/3xhaustpi-contention");
			expect(requests.find((request) => request.id === "req_contention")).toBeUndefined();
		} finally {
			state.close();
		}
	});
});
