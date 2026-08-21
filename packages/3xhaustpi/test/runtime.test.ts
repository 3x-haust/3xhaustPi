import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	configuredPythonConcurrency,
	providerCacheSessionId,
	semanticOperationTurnIds,
} from "../src/coding-runtime.ts";
import { FileCredentialStore, SystemCredentialStore } from "../src/credential-store.ts";
import { createStableProjectEvidence } from "../src/project-evidence.ts";
import { createProjectSnapshot } from "../src/project-snapshot.ts";
import { createProviderRuntime, providerCredentialOverride } from "../src/provider-runtime.ts";
import { ThreeXhaustState } from "../src/state.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const path = mkdtempSync(join(tmpdir(), "3xhaustpi-runtime-test-"));
	temporaryDirectories.push(path);
	return path;
}

afterEach(() => {
	for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("standalone runtime foundations", () => {
	it("accepts only the supported Python read concurrency levels", () => {
		expect(configuredPythonConcurrency({})).toBeUndefined();
		expect(configuredPythonConcurrency({ X3HAUSTPI_PYTHON: "/python" })).toBe(1);
		expect(
			configuredPythonConcurrency({
				X3HAUSTPI_PYTHON: "/python",
				X3HAUSTPI_PYTHON_CONCURRENCY: "4",
			}),
		).toBe(4);
		expect(
			configuredPythonConcurrency({
				X3HAUSTPI_PYTHON: "/python",
				X3HAUSTPI_PYTHON_CONCURRENCY: "8",
			}),
		).toBe(8);
		expect(() =>
			configuredPythonConcurrency({
				X3HAUSTPI_PYTHON: "/python",
				X3HAUSTPI_PYTHON_CONCURRENCY: "2",
			}),
		).toThrow(/1, 4, or 8/u);
	});

	it("resolves a host-provided API credential through the in-memory overlay", async () => {
		const models = createProviderRuntime({
			providerId: "openai",
			credential: { type: "api_key", key: "host-owned-key" },
		});

		expect(await models.checkAuth("openai")).toMatchObject({
			source: "stored credential",
			type: "api_key",
		});
	});

	it("resolves a host-brokered OAuth credential without reading the process credential store", async () => {
		const override = providerCredentialOverride(
			"openai-codex",
			JSON.stringify({
				type: "oauth",
				access: "host-owned-access",
				refresh: "host-owned-refresh",
				expires: Date.now() + 60_000,
			}),
		);
		const models = createProviderRuntime(override);

		expect(await models.checkAuth("openai-codex")).toMatchObject({
			source: "OAuth",
			type: "oauth",
		});
	});

	it("builds a bounded content-addressed snapshot and detects revision changes", () => {
		const project = temporaryDirectory();
		mkdirSync(join(project, "src"));
		writeFileSync(join(project, "src", "login.ts"), "export const LOGIN_ERROR = 'old';\n");
		writeFileSync(join(project, "README.md"), "fixture\n");

		const before = createProjectSnapshot(project, "fix LOGIN_ERROR in login.ts");
		writeFileSync(join(project, "src", "login.ts"), "export const LOGIN_ERROR = 'new';\n");
		const after = createProjectSnapshot(project, "fix LOGIN_ERROR in login.ts");

		expect(before.documents.some(({ relativePath }) => relativePath === "src/login.ts")).toBe(true);
		expect(before.documents.map(({ relativePath }) => relativePath)).toEqual([
			"README.md",
			"src/login.ts",
			"src/server.js",
		]);
		expect(before.stableContext.length).toBeLessThan(18_000);
		expect(before.revision).not.toBe(after.revision);
	});

	it("keeps project evidence order and provider cache affinity stable across objectives", () => {
		const project = temporaryDirectory();
		mkdirSync(join(project, "src"));
		writeFileSync(join(project, "src", "zeta.ts"), "export const zeta = 1;\n");
		writeFileSync(join(project, "src", "alpha.ts"), "export const alpha = 1;\n");
		const first = createProjectSnapshot(project, "inspect zeta");
		const second = createProjectSnapshot(project, "inspect alpha");

		expect(first.documents.map(({ relativePath }) => relativePath)).toEqual([
			"src/alpha.ts",
			"src/zeta.ts",
			"src/server.js",
		]);
		expect(second.documents.map(({ relativePath }) => relativePath)).toEqual(
			first.documents.map(({ relativePath }) => relativePath),
		);
		expect(providerCacheSessionId(project, "openai-codex", "gpt-5.4-mini")).toBe(
			providerCacheSessionId(project, "openai-codex", "gpt-5.4-mini"),
		);
		expect(providerCacheSessionId(project, "openai-codex", "gpt-5.4-mini")).not.toBe(
			providerCacheSessionId(project, "openai-codex", "gpt-5.5"),
		);
		expect(providerCacheSessionId(project, "openai-codex", "gpt-5.4-mini", "inspect alpha")).not.toBe(
			providerCacheSessionId(project, "openai-codex", "gpt-5.4-mini", "inspect zeta"),
		);
		const turnIds = semanticOperationTurnIds(project, "inspect alpha", first.revision);
		expect(semanticOperationTurnIds(project, "inspect alpha", first.revision)).toEqual(turnIds);
		expect(semanticOperationTurnIds(project, "inspect zeta", first.revision)).not.toEqual(turnIds);
	});

	it("bounds deterministic semantic evidence for real-provider calibration", () => {
		const repositoryRoot = resolve(import.meta.dirname, "../../..");
		const evidence = createStableProjectEvidence(repositoryRoot, 128);

		expect(evidence.text).toHaveLength(128);
		expect(() => createStableProjectEvidence(repositoryRoot, 0)).toThrow(/1 to 18,000/);
		expect(() => createStableProjectEvidence(repositoryRoot, 18_001)).toThrow(/1 to 18,000/);
	});

	it("exposes bounded new-file slots for an empty project", () => {
		const project = temporaryDirectory();
		const snapshot = createProjectSnapshot(project, "build a tested todo web app");

		expect(snapshot.documents.map(({ relativePath }) => relativePath)).toEqual([
			"README.md",
			"index.html",
			"package.json",
			"src/app.js",
			"src/server.js",
			"src/styles.css",
			"test/app.test.js",
		]);
		expect(snapshot.documents.every(({ virtual }) => virtual)).toBe(true);
		expect(snapshot.stableContext).toContain("NEW FILE SLOT");
		expect(snapshot.stableContext).toContain("oldText is exactly the marker");
	});

	it("keeps a bounded server new-file slot available in an existing project", () => {
		const project = temporaryDirectory();
		writeFileSync(join(project, "package.json"), '{"scripts":{"start":"node src/server.js"}}');
		const snapshot = createProjectSnapshot(project, "add a static server");
		const server = snapshot.documents.find(({ relativePath }) => relativePath === "src/server.js");

		expect(server).toMatchObject({ virtual: true });
		expect(snapshot.stableContext).toContain("NEW FILE SLOT");
		expect(snapshot.documents).toHaveLength(2);
	});

	it("exposes only requested skill slots and existing skill documents under the hidden skills directory", () => {
		const project = temporaryDirectory();
		mkdirSync(join(project, ".3xhaustpi", "skills", "deploy-checklist"), { recursive: true });
		mkdirSync(join(project, ".3xhaustpi", "skills", "notes"), { recursive: true });
		writeFileSync(join(project, "package.json"), "{}\n");
		writeFileSync(join(project, ".env"), "SECRET=value\n");
		writeFileSync(join(project, ".3xhaustpi", "config.json"), "{}\n");
		writeFileSync(join(project, ".3xhaustpi", "skills", "deploy-checklist", "SKILL.md"), "# Deploy Checklist\n");
		writeFileSync(join(project, ".3xhaustpi", "skills", "notes", "draft.txt"), "hidden notes\n");

		const createSkill = createProjectSnapshot(project, "npm-release 스킬 만들어줘");
		expect(createSkill.documents.map(({ relativePath }) => relativePath)).toEqual([
			".3xhaustpi/skills/deploy-checklist/SKILL.md",
			"package.json",
			".3xhaustpi/skills/npm-release/SKILL.md",
			"src/server.js",
		]);
		expect(
			createSkill.documents.find(({ relativePath }) => relativePath === ".3xhaustpi/skills/npm-release/SKILL.md"),
		).toMatchObject({
			virtual: true,
		});
		expect(createSkill.documents.map(({ relativePath }) => relativePath)).not.toContain(".env");
		expect(createSkill.documents.map(({ relativePath }) => relativePath)).not.toContain(".3xhaustpi/config.json");
		expect(createSkill.documents.map(({ relativePath }) => relativePath)).not.toContain(
			".3xhaustpi/skills/notes/draft.txt",
		);

		const ambiguous = createProjectSnapshot(project, "create skill npm-release deploy-helper");
		expect(ambiguous.documents.map(({ relativePath }) => relativePath)).not.toContain(
			".3xhaustpi/skills/npm-release/SKILL.md",
		);

		const invalid = createProjectSnapshot(project, "create skill NPM_Release");
		expect(invalid.documents.map(({ relativePath }) => relativePath)).not.toContain(
			".3xhaustpi/skills/NPM_Release/SKILL.md",
		);
	});

	it("persists credentials with private file permissions without exposing them in list", async () => {
		const directory = temporaryDirectory();
		const path = join(directory, "auth.json");
		const store = new FileCredentialStore(path);
		await store.modify("openai-codex", async () => ({
			type: "oauth",
			access: "secret-access",
			refresh: "secret-refresh",
			expires: Date.now() + 60_000,
		}));

		expect(await store.list()).toEqual([{ providerId: "openai-codex", type: "oauth" }]);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readFileSync(path, "utf8")).toContain("secret-access");
	});

	it("migrates legacy credentials into an OS keyring and leaves only non-secret metadata", async () => {
		const directory = temporaryDirectory();
		const path = join(directory, "auth.json");
		const keyring = new Map<string, string>();
		writeFileSync(
			path,
			JSON.stringify({
				"openai-codex": {
					type: "oauth",
					access: "legacy-secret-access",
					refresh: "legacy-secret-refresh",
					expires: Date.now() + 60_000,
				},
			}),
			{ mode: 0o600 },
		);
		const store = new SystemCredentialStore(path, {
			entryFactory: (providerId) => ({
				getPassword: () => Promise.resolve(keyring.get(providerId)),
				setPassword: async (password) => {
					keyring.set(providerId, password);
				},
				deleteCredential: async () => keyring.delete(providerId),
			}),
		});

		expect(await store.list()).toEqual([{ providerId: "openai-codex", type: "oauth" }]);
		expect(await store.read("openai-codex")).toMatchObject({
			type: "oauth",
			access: "legacy-secret-access",
			refresh: "legacy-secret-refresh",
		});
		const metadata = readFileSync(path, "utf8");
		expect(metadata).not.toContain("legacy-secret");
		expect(metadata).toContain('"storage": "os-keyring"');
		expect(statSync(path).mode & 0o777).toBe(0o600);

		await store.modify("openai-codex", async (current) => ({
			...current,
			type: "oauth",
			access: "rotated-access",
			refresh: "rotated-refresh",
			expires: Date.now() + 120_000,
		}));
		expect(await store.read("openai-codex")).toMatchObject({
			access: "rotated-access",
			refresh: "rotated-refresh",
		});
		expect(readFileSync(path, "utf8")).not.toContain("rotated-access");

		await store.delete("openai-codex");
		expect(await store.read("openai-codex")).toBeUndefined();
		expect(await store.list()).toEqual([]);
	});

	it("lists registered system credentials without opening the OS keyring", async () => {
		const directory = temporaryDirectory();
		const path = join(directory, "auth.json");
		let secureEntryReads = 0;
		writeFileSync(
			path,
			JSON.stringify({
				"openai-codex": { type: "oauth", storage: "os-keyring" },
			}),
			{ mode: 0o600 },
		);
		const store = new SystemCredentialStore(path, {
			entryFactory: () => ({
				getPassword: async () => {
					secureEntryReads += 1;
					return undefined;
				},
				setPassword: async () => {},
				deleteCredential: async () => false,
			}),
		});

		expect(await store.list()).toEqual([{ providerId: "openai-codex", type: "oauth" }]);
		expect(secureEntryReads).toBe(0);
	});

	it("recovers a running request only when recovery is explicitly requested", () => {
		const directory = temporaryDirectory();
		const databasePath = join(directory, "state.sqlite");
		const state = new ThreeXhaustState(databasePath);
		state.beginRun({
			projectId: "prj_fixture",
			projectPath: directory,
			sessionId: "session_fixture",
			requestId: "req_fixture",
			fingerprint: "digest_fixture",
			payload: "{}",
			checkpoint: '{"phase":"provider"}',
			generation: 1,
		});
		state.close();

		const recovered = new ThreeXhaustState(databasePath);
		expect(recovered.findResumeCheckpoint()).toBeUndefined();
		expect(recovered.inspectWorkspace(directory).chats[0]?.status).toBe("running");
		recovered.recoverInterruptedRuns();
		expect(recovered.findResumeCheckpoint()).toMatchObject({
			sessionId: "session_fixture",
			projectPath: directory,
			payload: '{"phase":"provider"}',
		});
		recovered.close();
	});

	it("claims a queued pre-dispatch checkpoint exactly once", () => {
		const directory = temporaryDirectory();
		const databasePath = join(directory, "state.sqlite");
		const state = new ThreeXhaustState(databasePath);
		state.beginRun({
			projectId: "prj_claim",
			projectPath: directory,
			sessionId: "session_claim",
			requestId: "req_claim",
			fingerprint: "digest_claim",
			payload: '{"objective":"resume"}',
			checkpoint: '{"version":1,"phase":"provider-ready"}',
			generation: 1,
		});
		state.close();

		const recovered = new ThreeXhaustState(databasePath);
		recovered.recoverInterruptedRuns();
		expect(recovered.claimResumeCheckpoint()).toMatchObject({
			sessionId: "session_claim",
			requestId: "req_claim",
			outboxState: "queued",
			generation: 1,
		});
		expect(recovered.claimResumeCheckpoint()).toBeUndefined();
		expect(recovered.inspectWorkspace(directory).chats[0]?.status).toBe("running");
		recovered.close();
	});

	it("never automatically replays an indeterminate provider transmission", () => {
		const directory = temporaryDirectory();
		const databasePath = join(directory, "state.sqlite");
		const state = new ThreeXhaustState(databasePath);
		state.beginRun({
			projectId: "prj_indeterminate",
			projectPath: directory,
			sessionId: "session_indeterminate",
			requestId: "req_indeterminate",
			fingerprint: "digest_indeterminate",
			payload: '{"objective":"resume"}',
			checkpoint: '{"version":1,"phase":"provider-ready"}',
			generation: 1,
		});
		state.markProviderDispatching("req_indeterminate", 1);
		state.close();

		const recovered = new ThreeXhaustState(databasePath);
		recovered.recoverInterruptedRuns();
		expect(recovered.findResumeCheckpoint()?.outboxState).toBe("indeterminate");
		expect(() => recovered.claimResumeCheckpoint()).toThrow(/indeterminate.*blocked/iu);
		recovered.close();
	});

	it("links one content-addressed observation to repeated independent sessions", () => {
		const directory = temporaryDirectory();
		const state = new ThreeXhaustState(join(directory, "state.sqlite"));
		for (const suffix of ["one", "two"]) {
			state.beginRun({
				projectId: "prj_observation",
				projectPath: directory,
				sessionId: `session_${suffix}`,
				requestId: `request_${suffix}`,
				fingerprint: `fingerprint_${suffix}`,
				payload: "{}",
				checkpoint: '{"phase":"provider-ready"}',
				generation: 1,
			});
			state.recordObservation(`session_${suffix}`, "obs_content_addressed", '{"summary":"same"}');
		}
		expect(() => state.recordObservation("session_two", "obs_content_addressed", '{"summary":"different"}')).toThrow(
			/does not match/iu,
		);
		state.close();
	});

	it("atomically persists a settled provider response checkpoint for replay without resend", () => {
		const directory = temporaryDirectory();
		const databasePath = join(directory, "state.sqlite");
		const state = new ThreeXhaustState(databasePath);
		state.beginRun({
			projectId: "prj_settled",
			projectPath: directory,
			sessionId: "session_settled",
			requestId: "req_settled",
			fingerprint: "digest_settled",
			payload: '{"objective":"resume"}',
			checkpoint: '{"version":1,"phase":"provider-ready"}',
			generation: 1,
		});
		state.markProviderDispatching("req_settled", 1);
		state.settleProviderAndCheckpoint(
			"req_settled",
			"session_settled",
			1,
			"response_settled",
			'{"version":1,"phase":"provider-settled","result":{"responseId":"response_settled"}}',
		);
		state.completeRun("session_settled", "req_settled", "failed");
		state.close();

		const recovered = new ThreeXhaustState(databasePath);
		expect(recovered.claimResumeCheckpoint()).toMatchObject({
			sessionId: "session_settled",
			outboxState: "settled",
			payload: expect.stringContaining('"provider-settled"'),
		});
		recovered.close();
	});

	it("persists TUI follow-ups in FIFO order and safely restores only an unhanded request", () => {
		const directory = temporaryDirectory();
		const databasePath = join(directory, "state.sqlite");
		const state = new ThreeXhaustState(databasePath);
		const first = state.enqueueTuiRequest({
			requestId: "tui_first",
			projectPath: directory,
			fingerprint: "fingerprint_first",
			objective: "first follow-up",
		});
		const duplicate = state.enqueueTuiRequest({
			requestId: "tui_duplicate",
			projectPath: directory,
			fingerprint: "fingerprint_first",
			objective: "first follow-up",
		});
		const second = state.enqueueTuiRequest({
			requestId: "tui_second",
			projectPath: directory,
			fingerprint: "fingerprint_second",
			objective: "second follow-up",
		});

		expect(first).toMatchObject({ inserted: true, request: { id: "tui_first", position: 1 } });
		expect(duplicate).toMatchObject({ inserted: false, request: { id: "tui_first", position: 1 } });
		expect(second).toMatchObject({ inserted: true, request: { id: "tui_second", position: 2 } });
		expect(state.claimNextTuiRequest(directory)).toMatchObject({
			id: "tui_first",
			objective: "first follow-up",
			status: "running",
		});
		state.close();

		const recovered = new ThreeXhaustState(databasePath);
		expect(recovered.listTuiRequests(directory).map((request) => request.status)).toEqual(["running", "queued"]);
		recovered.recoverInterruptedTuiRequests(directory);
		expect(recovered.claimNextTuiRequest(directory)?.id).toBe("tui_first");
		recovered.completeTuiRequest("tui_first", "completed");
		expect(recovered.claimNextTuiRequest(directory)?.id).toBe("tui_second");
		recovered.completeTuiRequest("tui_second", "completed");
		expect(recovered.listTuiRequests(directory)).toEqual([]);
		recovered.close();
	});

	it("returns project and chat summaries for TUI navigation without mutating runtime state", () => {
		const firstProject = temporaryDirectory();
		const secondProject = temporaryDirectory();
		const state = new ThreeXhaustState(join(temporaryDirectory(), "state.sqlite"));
		for (const [index, project] of [firstProject, secondProject].entries()) {
			const suffix = String(index + 1);
			state.beginRun({
				projectId: `project_${suffix}`,
				projectPath: project,
				sessionId: `session_${suffix}`,
				requestId: `request_${suffix}`,
				fingerprint: `fingerprint_${suffix}`,
				payload: JSON.stringify({ objective: `Investigate project ${suffix}` }),
				checkpoint: '{"version":1,"phase":"provider-ready"}',
				generation: 1,
			});
			if (index === 0) {
				state.markProviderDispatching(`request_${suffix}`, 1);
				state.settleProvider(`request_${suffix}`, `response_${suffix}`);
				state.completeRun(`session_${suffix}`, `request_${suffix}`, "completed");
			}
		}

		const first = state.inspectWorkspace(firstProject);
		expect(first.chats).toEqual([
			expect.objectContaining({
				id: "session_1",
				status: "completed",
				objective: "Investigate project 1",
			}),
		]);
		expect(first.projects).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: firstProject, chatCount: 1, activeChatCount: 0 }),
				expect.objectContaining({ path: secondProject, chatCount: 1, activeChatCount: 1 }),
			]),
		);
		expect(state.inspectWorkspace(secondProject).chats[0]).toMatchObject({
			id: "session_2",
			status: "running",
			objective: "Investigate project 2",
		});
		state.close();
	});
});
