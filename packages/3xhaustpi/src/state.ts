import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveStatePath } from "./identity.ts";

export interface ResumeCheckpoint {
	readonly sessionId: string;
	readonly projectPath: string;
	readonly payload: string;
	readonly requestId: string;
	readonly requestPayload: string;
	readonly fingerprint: string;
	readonly generation: number;
	readonly outboxState: "queued" | "dispatching" | "accepted" | "settled" | "indeterminate";
	readonly updatedAt: string;
}

export interface BeginRunInput {
	readonly projectId: string;
	readonly projectPath: string;
	readonly sessionId: string;
	readonly requestId: string;
	readonly fingerprint: string;
	readonly payload: string;
	readonly checkpoint: string;
	readonly generation: number;
}

export interface WorkspaceSnapshot {
	readonly projects: readonly {
		readonly path: string;
		readonly createdAt: string;
		readonly chatCount: number;
		readonly activeChatCount: number;
	}[];
	readonly chats: readonly {
		readonly id: string;
		readonly status: string;
		readonly updatedAt: string;
		readonly objective: string;
	}[];
	readonly requests: readonly { readonly id: string; readonly status: string; readonly position: number }[];
	readonly patches: readonly { readonly id: string; readonly state: string; readonly updatedAt: string }[];
}

export interface TuiRequest {
	readonly id: string;
	readonly projectPath: string;
	readonly objective: string;
	readonly position: number;
	readonly status: "queued" | "running";
	readonly createdAt: string;
}

export interface EnqueueTuiRequestInput {
	readonly requestId: string;
	readonly projectPath: string;
	readonly fingerprint: string;
	readonly objective: string;
}

export class ThreeXhaustState {
	readonly #database: DatabaseSync;

	constructor(path = resolveStatePath()) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.#database = new DatabaseSync(path);
		this.#database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;");
		this.#database.exec(`
			CREATE TABLE IF NOT EXISTS projects (
				project_id TEXT PRIMARY KEY,
				canonical_path TEXT NOT NULL UNIQUE,
				created_at TEXT NOT NULL
			) STRICT;
			CREATE TABLE IF NOT EXISTS chats (
				session_id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL REFERENCES projects(project_id),
				status TEXT NOT NULL CHECK (status IN ('idle', 'queued', 'running', 'paused', 'failed', 'completed')),
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			) STRICT;
			CREATE TABLE IF NOT EXISTS request_queue (
				request_id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL REFERENCES chats(session_id),
				position INTEGER NOT NULL,
				fingerprint TEXT NOT NULL,
				payload TEXT NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'failed', 'completed', 'indeterminate')),
				created_at TEXT NOT NULL,
				UNIQUE (session_id, fingerprint)
			) STRICT;
			CREATE TABLE IF NOT EXISTS checkpoints (
				session_id TEXT PRIMARY KEY REFERENCES chats(session_id),
				generation INTEGER NOT NULL,
				payload TEXT NOT NULL,
				updated_at TEXT NOT NULL
			) STRICT;
			CREATE TABLE IF NOT EXISTS provider_outbox (
				request_id TEXT PRIMARY KEY REFERENCES request_queue(request_id),
				generation INTEGER NOT NULL,
				state TEXT NOT NULL CHECK (state IN ('queued', 'dispatching', 'accepted', 'settled', 'indeterminate')),
				payload_digest TEXT NOT NULL,
				provider_request_id TEXT,
				updated_at TEXT NOT NULL
			) STRICT;
			CREATE TABLE IF NOT EXISTS observations (
				observation_id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL REFERENCES chats(session_id),
				payload TEXT NOT NULL,
				created_at TEXT NOT NULL
			) STRICT;
			CREATE TABLE IF NOT EXISTS observation_sessions (
				session_id TEXT NOT NULL REFERENCES chats(session_id),
				observation_id TEXT NOT NULL REFERENCES observations(observation_id),
				created_at TEXT NOT NULL,
				PRIMARY KEY (session_id, observation_id)
			) STRICT;
			CREATE TABLE IF NOT EXISTS patch_journal (
				patch_id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL REFERENCES chats(session_id),
				base_revision TEXT NOT NULL,
				state TEXT NOT NULL CHECK (state IN ('proposed', 'approved', 'applied', 'conflict', 'rejected')),
				payload TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			) STRICT;
			CREATE TABLE IF NOT EXISTS tui_request_queue (
				request_id TEXT PRIMARY KEY,
				canonical_path TEXT NOT NULL,
				position INTEGER NOT NULL,
				fingerprint TEXT NOT NULL,
				objective TEXT NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			) STRICT;
			CREATE UNIQUE INDEX IF NOT EXISTS tui_request_queue_active_fingerprint
				ON tui_request_queue(canonical_path, fingerprint)
				WHERE status IN ('queued', 'running');
		`);
	}

	recoverInterruptedRuns(): void {
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			this.#database.exec(`
			UPDATE request_queue SET status = 'queued' WHERE status = 'running';
			UPDATE provider_outbox SET state = 'indeterminate' WHERE state IN ('dispatching', 'accepted');
			UPDATE chats SET status = 'paused' WHERE status = 'running';
			`);
			this.#database.exec("COMMIT");
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	recoverInterruptedTuiRequests(projectPath: string): void {
		this.#database
			.prepare(
				"UPDATE tui_request_queue SET status = 'queued', updated_at = ? WHERE canonical_path = ? AND status = 'running'",
			)
			.run(new Date().toISOString(), projectPath);
	}

	enqueueTuiRequest(input: EnqueueTuiRequestInput): { readonly request: TuiRequest; readonly inserted: boolean } {
		const now = new Date().toISOString();
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			const existing = this.#database
				.prepare(
					`SELECT request_id, canonical_path, objective, position, status, created_at
					 FROM tui_request_queue
					 WHERE canonical_path = ? AND fingerprint = ? AND status IN ('queued', 'running')`,
				)
				.get(input.projectPath, input.fingerprint) as
				| {
						request_id: string;
						canonical_path: string;
						objective: string;
						position: number;
						status: TuiRequest["status"];
						created_at: string;
				  }
				| undefined;
			if (existing) {
				this.#database.exec("COMMIT");
				return {
					request: {
						id: existing.request_id,
						projectPath: existing.canonical_path,
						objective: existing.objective,
						position: existing.position,
						status: existing.status,
						createdAt: existing.created_at,
					},
					inserted: false,
				};
			}
			const row = this.#database
				.prepare(
					"SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM tui_request_queue WHERE canonical_path = ?",
				)
				.get(input.projectPath) as { next_position: number };
			this.#database
				.prepare(
					`INSERT INTO tui_request_queue(
						request_id, canonical_path, position, fingerprint, objective, status, created_at, updated_at
					) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
				)
				.run(input.requestId, input.projectPath, row.next_position, input.fingerprint, input.objective, now, now);
			this.#database.exec("COMMIT");
			return {
				request: {
					id: input.requestId,
					projectPath: input.projectPath,
					objective: input.objective,
					position: row.next_position,
					status: "queued",
					createdAt: now,
				},
				inserted: true,
			};
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	listTuiRequests(projectPath: string): readonly TuiRequest[] {
		const rows = this.#database
			.prepare(
				`SELECT request_id, canonical_path, objective, position, status, created_at
				 FROM tui_request_queue
				 WHERE canonical_path = ? AND status IN ('queued', 'running')
				 ORDER BY position`,
			)
			.all(projectPath) as Array<{
			request_id: string;
			canonical_path: string;
			objective: string;
			position: number;
			status: TuiRequest["status"];
			created_at: string;
		}>;
		return rows.map((row) => ({
			id: row.request_id,
			projectPath: row.canonical_path,
			objective: row.objective,
			position: row.position,
			status: row.status,
			createdAt: row.created_at,
		}));
	}

	claimNextTuiRequest(projectPath: string): TuiRequest | undefined {
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			const row = this.#database
				.prepare(
					`SELECT request_id, canonical_path, objective, position, created_at
					 FROM tui_request_queue
					 WHERE canonical_path = ? AND status = 'queued'
					 ORDER BY position
					 LIMIT 1`,
				)
				.get(projectPath) as
				| {
						request_id: string;
						canonical_path: string;
						objective: string;
						position: number;
						created_at: string;
				  }
				| undefined;
			if (!row) {
				this.#database.exec("COMMIT");
				return undefined;
			}
			const claimed = this.#database
				.prepare(
					"UPDATE tui_request_queue SET status = 'running', updated_at = ? WHERE request_id = ? AND status = 'queued'",
				)
				.run(new Date().toISOString(), row.request_id);
			if (claimed.changes !== 1) throw new Error("TUI request was claimed by another runtime");
			this.#database.exec("COMMIT");
			return {
				id: row.request_id,
				projectPath: row.canonical_path,
				objective: row.objective,
				position: row.position,
				status: "running",
				createdAt: row.created_at,
			};
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	completeTuiRequest(requestId: string, status: "completed" | "failed"): void {
		const result = this.#database
			.prepare("UPDATE tui_request_queue SET status = ?, updated_at = ? WHERE request_id = ? AND status = 'running'")
			.run(status, new Date().toISOString(), requestId);
		if (result.changes !== 1) throw new Error("TUI request is not running");
	}

	beginRun(input: BeginRunInput): void {
		const now = new Date().toISOString();
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			this.#database
				.prepare("INSERT OR IGNORE INTO projects(project_id, canonical_path, created_at) VALUES (?, ?, ?)")
				.run(input.projectId, input.projectPath, now);
			this.#database
				.prepare(
					"INSERT INTO chats(session_id, project_id, status, created_at, updated_at) VALUES (?, ?, 'running', ?, ?)",
				)
				.run(input.sessionId, input.projectId, now, now);
			this.#database
				.prepare(
					"INSERT INTO request_queue(request_id, session_id, position, fingerprint, payload, status, created_at) VALUES (?, ?, 1, ?, ?, 'running', ?)",
				)
				.run(input.requestId, input.sessionId, input.fingerprint, input.payload, now);
			this.#database
				.prepare("INSERT INTO checkpoints(session_id, generation, payload, updated_at) VALUES (?, ?, ?, ?)")
				.run(input.sessionId, input.generation, input.checkpoint, now);
			this.#database
				.prepare(
					"INSERT INTO provider_outbox(request_id, generation, state, payload_digest, updated_at) VALUES (?, ?, 'queued', ?, ?)",
				)
				.run(input.requestId, input.generation, input.fingerprint, now);
			this.#database.exec("COMMIT");
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	markProviderDispatching(requestId: string, generation: number): void {
		const result = this.#database
			.prepare(
				"UPDATE provider_outbox SET state = 'dispatching', updated_at = ? WHERE request_id = ? AND generation = ? AND state = 'queued'",
			)
			.run(new Date().toISOString(), requestId, generation);
		if (result.changes !== 1) {
			const row = this.#database
				.prepare("SELECT generation, state FROM provider_outbox WHERE request_id = ?")
				.get(requestId) as { generation: number; state: string } | undefined;
			if (!row) throw new Error("Provider outbox request is unavailable");
			if (row.generation !== generation) throw new Error("Provider outbox generation is stale");
			throw new Error(`Provider outbox is ${row.state}; automatic dispatch is blocked`);
		}
	}

	settleProvider(requestId: string, providerRequestId: string | undefined): void {
		const now = new Date().toISOString();
		const result = this.#database
			.prepare(
				"UPDATE provider_outbox SET state = 'settled', provider_request_id = ?, updated_at = ? WHERE request_id = ? AND state = 'dispatching'",
			)
			.run(providerRequestId ?? null, now, requestId);
		if (result.changes !== 1) throw new Error("Provider outbox could not be settled from dispatching");
	}

	settleProviderAndCheckpoint(
		requestId: string,
		sessionId: string,
		generation: number,
		providerRequestId: string | undefined,
		checkpoint: string,
	): void {
		const now = new Date().toISOString();
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			const settled = this.#database
				.prepare(
					"UPDATE provider_outbox SET state = 'settled', provider_request_id = ?, updated_at = ? WHERE request_id = ? AND generation = ? AND state = 'dispatching'",
				)
				.run(providerRequestId ?? null, now, requestId, generation);
			if (settled.changes !== 1) throw new Error("Provider outbox could not be settled from dispatching");
			this.#database
				.prepare("UPDATE checkpoints SET generation = ?, payload = ?, updated_at = ? WHERE session_id = ?")
				.run(generation, checkpoint, now, sessionId);
			this.#database.exec("COMMIT");
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	prepareProviderDispatch(
		requestId: string,
		sessionId: string,
		generation: number,
		payloadDigest: string,
		checkpoint: string,
	): void {
		const now = new Date().toISOString();
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			const prepared = this.#database
				.prepare(
					`UPDATE provider_outbox
					 SET generation = ?, state = 'queued', payload_digest = ?, provider_request_id = NULL, updated_at = ?
					 WHERE request_id = ? AND state = 'settled'`,
				)
				.run(generation, payloadDigest, now, requestId);
			if (prepared.changes !== 1) throw new Error("Provider outbox is not safely settled for the next dispatch");
			this.#database
				.prepare("UPDATE checkpoints SET generation = ?, payload = ?, updated_at = ? WHERE session_id = ?")
				.run(generation, checkpoint, now, sessionId);
			this.#database.prepare("UPDATE request_queue SET status = 'running' WHERE request_id = ?").run(requestId);
			this.#database
				.prepare("UPDATE chats SET status = 'running', updated_at = ? WHERE session_id = ?")
				.run(now, sessionId);
			this.#database.exec("COMMIT");
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	updateCheckpoint(sessionId: string, generation: number, checkpoint: string): void {
		const result = this.#database
			.prepare("UPDATE checkpoints SET generation = ?, payload = ?, updated_at = ? WHERE session_id = ?")
			.run(generation, checkpoint, new Date().toISOString(), sessionId);
		if (result.changes !== 1) throw new Error("Durable checkpoint is unavailable");
	}

	recordObservation(sessionId: string, observationId: string, payload: string): void {
		const now = new Date().toISOString();
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			const existing = this.#database
				.prepare("SELECT payload FROM observations WHERE observation_id = ?")
				.get(observationId) as { payload: string } | undefined;
			if (existing && existing.payload !== payload) {
				throw new Error("Content-addressed observation payload does not match its existing ID");
			}
			this.#database
				.prepare(
					"INSERT OR IGNORE INTO observations(observation_id, session_id, payload, created_at) VALUES (?, ?, ?, ?)",
				)
				.run(observationId, sessionId, payload, now);
			this.#database
				.prepare(
					"INSERT OR IGNORE INTO observation_sessions(session_id, observation_id, created_at) VALUES (?, ?, ?)",
				)
				.run(sessionId, observationId, now);
			this.#database.exec("COMMIT");
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	recordPatch(
		sessionId: string,
		patchId: string,
		baseRevision: string,
		state: "proposed" | "approved" | "applied" | "conflict" | "rejected",
		payload: string,
	): void {
		const now = new Date().toISOString();
		this.#database
			.prepare(
				`INSERT INTO patch_journal(patch_id, session_id, base_revision, state, payload, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(patch_id) DO UPDATE SET state = excluded.state, payload = excluded.payload, updated_at = excluded.updated_at`,
			)
			.run(patchId, sessionId, baseRevision, state, payload, now, now);
	}

	completeRun(sessionId: string, requestId: string, status: "completed" | "failed"): void {
		const now = new Date().toISOString();
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			this.#database
				.prepare("UPDATE request_queue SET status = ? WHERE request_id = ?")
				.run(status === "completed" ? "completed" : "failed", requestId);
			this.#database
				.prepare("UPDATE chats SET status = ?, updated_at = ? WHERE session_id = ?")
				.run(status, now, sessionId);
			this.#database.exec("COMMIT");
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	findResumeCheckpoint(sessionId?: string, projectPath?: string): ResumeCheckpoint | undefined {
		const row = this.#database
			.prepare(`
				SELECT chats.session_id, projects.canonical_path, checkpoints.payload, checkpoints.generation,
					checkpoints.updated_at, request_queue.request_id, request_queue.payload AS request_payload,
					request_queue.fingerprint, provider_outbox.state AS outbox_state
				FROM checkpoints
				JOIN chats ON chats.session_id = checkpoints.session_id
				JOIN projects ON projects.project_id = chats.project_id
				JOIN request_queue ON request_queue.session_id = chats.session_id
				JOIN provider_outbox ON provider_outbox.request_id = request_queue.request_id
				WHERE chats.status IN ('paused', 'queued', 'failed')
					${sessionId ? "AND chats.session_id = ?" : ""}
					${projectPath ? "AND projects.canonical_path = ?" : ""}
				ORDER BY checkpoints.updated_at DESC
				LIMIT 1
			`)
			.get(...(sessionId ? [sessionId] : []), ...(projectPath ? [projectPath] : [])) as
			| {
					session_id: string;
					canonical_path: string;
					payload: string;
					generation: number;
					updated_at: string;
					request_id: string;
					request_payload: string;
					fingerprint: string;
					outbox_state: ResumeCheckpoint["outboxState"];
			  }
			| undefined;
		return row
			? {
					sessionId: row.session_id,
					projectPath: row.canonical_path,
					payload: row.payload,
					requestId: row.request_id,
					requestPayload: row.request_payload,
					fingerprint: row.fingerprint,
					generation: row.generation,
					outboxState: row.outbox_state,
					updatedAt: row.updated_at,
				}
			: undefined;
	}

	claimResumeCheckpoint(sessionId?: string, projectPath?: string): ResumeCheckpoint | undefined {
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			const checkpoint = this.findResumeCheckpoint(sessionId, projectPath);
			if (!checkpoint) {
				this.#database.exec("COMMIT");
				return undefined;
			}
			if (checkpoint.outboxState === "indeterminate") {
				throw new Error(
					"Provider receipt is indeterminate; automatic resend is blocked. Inspect the provider before retrying.",
				);
			}
			if (checkpoint.outboxState !== "queued" && checkpoint.outboxState !== "settled") {
				throw new Error(`Provider outbox is ${checkpoint.outboxState}; resume is not safe`);
			}
			const claimed = this.#database
				.prepare(
					"UPDATE chats SET status = 'running', updated_at = ? WHERE session_id = ? AND status IN ('paused', 'queued', 'failed')",
				)
				.run(new Date().toISOString(), checkpoint.sessionId);
			if (claimed.changes !== 1) throw new Error("Durable checkpoint was claimed by another runtime");
			this.#database
				.prepare("UPDATE request_queue SET status = 'running' WHERE request_id = ?")
				.run(checkpoint.requestId);
			this.#database.exec("COMMIT");
			return checkpoint;
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	inspectWorkspace(projectPath: string): WorkspaceSnapshot {
		const projects = this.#database
			.prepare(`
				SELECT projects.canonical_path, projects.created_at,
					COUNT(chats.session_id) AS chat_count,
					COALESCE(SUM(CASE WHEN chats.status IN ('queued', 'running', 'paused') THEN 1 ELSE 0 END), 0)
						AS active_chat_count
				FROM projects
				LEFT JOIN chats ON chats.project_id = projects.project_id
				GROUP BY projects.project_id
				ORDER BY MAX(COALESCE(chats.updated_at, projects.created_at)) DESC
				LIMIT 20
			`)
			.all() as Array<{
			canonical_path: string;
			created_at: string;
			chat_count: number;
			active_chat_count: number;
		}>;
		const chats = this.#database
			.prepare(`
				SELECT chats.session_id, chats.status, chats.updated_at, request_queue.payload
				FROM chats JOIN projects ON projects.project_id = chats.project_id
				LEFT JOIN request_queue
					ON request_queue.session_id = chats.session_id AND request_queue.position = 1
				WHERE projects.canonical_path = ?
				ORDER BY chats.updated_at DESC LIMIT 20
			`)
			.all(projectPath) as Array<{ session_id: string; status: string; updated_at: string; payload: string | null }>;
		const requests = this.#database
			.prepare(`
				SELECT request_queue.request_id, request_queue.status, request_queue.position
				FROM request_queue
				JOIN chats ON chats.session_id = request_queue.session_id
				JOIN projects ON projects.project_id = chats.project_id
				WHERE projects.canonical_path = ?
				ORDER BY request_queue.created_at DESC LIMIT 8
			`)
			.all(projectPath) as Array<{ request_id: string; status: string; position: number }>;
		const patches = this.#database
			.prepare(`
				SELECT patch_journal.patch_id, patch_journal.state, patch_journal.updated_at
				FROM patch_journal
				JOIN chats ON chats.session_id = patch_journal.session_id
				JOIN projects ON projects.project_id = chats.project_id
				WHERE projects.canonical_path = ?
				ORDER BY patch_journal.updated_at DESC LIMIT 8
			`)
			.all(projectPath) as Array<{ patch_id: string; state: string; updated_at: string }>;
		return {
			projects: projects.map((row) => ({
				path: row.canonical_path,
				createdAt: row.created_at,
				chatCount: row.chat_count,
				activeChatCount: row.active_chat_count,
			})),
			chats: chats.map((row) => {
				let objective = "Untitled task";
				if (row.payload) {
					try {
						const payload: unknown = JSON.parse(row.payload);
						if (
							typeof payload === "object" &&
							payload !== null &&
							"objective" in payload &&
							typeof payload.objective === "string" &&
							payload.objective.trim()
						) {
							objective = payload.objective.trim();
						}
					} catch {
						objective = "Unreadable task";
					}
				}
				return {
					id: row.session_id,
					status: row.status,
					updatedAt: row.updated_at,
					objective,
				};
			}),
			requests: requests.map((row) => ({ id: row.request_id, status: row.status, position: row.position })),
			patches: patches.map((row) => ({ id: row.patch_id, state: row.state, updatedAt: row.updated_at })),
		};
	}

	close(): void {
		this.#database.close();
	}
}
