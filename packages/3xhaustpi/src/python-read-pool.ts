import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CapabilityInvocation } from "../../core/src/index.ts";
import { type CapabilityExecution, executeReadCapability, queryOf } from "./capability-executor.ts";

interface WorkerResponse {
	readonly id: string | null;
	readonly ok: boolean;
	readonly matches?: readonly string[];
	readonly cacheHit?: boolean;
	readonly error?: string;
}

interface PendingRequest {
	readonly id: string;
	readonly resolve: (value: CapabilityExecution) => void;
	readonly reject: (reason: Error) => void;
	readonly timeout: ReturnType<typeof setTimeout>;
	readonly abort?: () => void;
	readonly signal?: AbortSignal;
}

function pythonWorkerPath(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "python", "read_worker.py");
}

export function findPythonExecutable(): string | undefined {
	const configured = process.env.X3HAUSTPI_PYTHON;
	if (configured)
		return spawnSync(configured, ["--version"], { stdio: "ignore", timeout: 5_000 }).status === 0
			? configured
			: undefined;
	for (const candidate of ["python3", "python"]) {
		if (spawnSync(candidate, ["--version"], { stdio: "ignore", timeout: 5_000 }).status === 0) return candidate;
	}
	return undefined;
}

class PythonWorker {
	private readonly executable: string;
	private child?: ChildProcessWithoutNullStreams;
	private pending?: PendingRequest;
	private buffer = "";

	constructor(executable: string) {
		this.executable = executable;
	}

	get idle(): boolean {
		return !this.pending;
	}

	get processId(): number | undefined {
		return this.child?.pid;
	}

	execute(invocation: CapabilityInvocation, projectRoot: string, signal?: AbortSignal): Promise<CapabilityExecution> {
		if (signal?.aborted) return Promise.reject(new Error("Python read capability was cancelled"));
		if (!this.idle) return Promise.reject(new Error("Python read worker is busy"));
		const child = this.ensureChild();
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.rejectPending(new Error("Python read capability timed out"));
				this.replace();
			}, invocation.timeoutMs);
			const requestSignal = signal;
			const abort = requestSignal
				? () => {
						this.rejectPending(new Error("Python read capability was cancelled"));
						this.replace();
					}
				: undefined;
			if (requestSignal && abort) requestSignal.addEventListener("abort", abort, { once: true });
			this.pending = {
				id,
				resolve,
				reject,
				timeout,
				...(abort ? { abort } : {}),
				...(requestSignal ? { signal: requestSignal } : {}),
			};
			child.stdin.write(
				`${JSON.stringify({
					id,
					operation: "search",
					root: projectRoot,
					query: queryOf(invocation),
					revision: invocation.basedOn.projectRevision,
				})}\n`,
			);
		});
	}

	close(): void {
		this.rejectPending(new Error("Python read pool closed"));
		this.replace(false);
	}

	private ensureChild(): ChildProcessWithoutNullStreams {
		if (this.child && !this.child.killed) return this.child;
		const child = spawn(this.executable, ["-I", "-u", pythonWorkerPath()], {
			stdio: ["pipe", "pipe", "pipe"],
			env: { PATH: process.env.PATH ?? "" },
		});
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.consume(chunk));
		child.on("error", (error) => this.rejectPending(error));
		child.on("close", () => {
			if (this.child === child) this.child = undefined;
			this.rejectPending(new Error("Python read worker exited"));
		});
		this.child = child;
		return child;
	}

	private consume(chunk: string): void {
		this.buffer += chunk;
		const lines = this.buffer.split(/\r?\n/u);
		this.buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line) continue;
			let response: WorkerResponse;
			try {
				response = JSON.parse(line) as WorkerResponse;
			} catch {
				this.rejectPending(new Error("Python read worker returned invalid JSON"));
				this.replace();
				return;
			}
			if (!this.pending || response.id !== this.pending.id) continue;
			const pending = this.takePending();
			if (!pending) continue;
			if (!response.ok || !Array.isArray(response.matches)) {
				pending.reject(new Error(response.error ?? "Python read worker rejected the request"));
				continue;
			}
			const matches = [...response.matches].sort((left, right) => left.localeCompare(right, "en"));
			const output = matches.join("\n");
			pending.resolve({
				status: "succeeded",
				summary:
					matches.length > 0 ? `Found ${matches.length} exact matches` : "Search completed with no exact matches",
				matchCount: matches.length,
				outputHashInput: output,
				executor: "python",
				cacheHit: response.cacheHit === true,
			});
		}
	}

	private takePending(): PendingRequest | undefined {
		const pending = this.pending;
		this.pending = undefined;
		if (!pending) return undefined;
		clearTimeout(pending.timeout);
		if (pending.abort) pending.signal?.removeEventListener("abort", pending.abort);
		return pending;
	}

	private rejectPending(error: Error): void {
		this.takePending()?.reject(error);
	}

	private replace(restart = true): void {
		const child = this.child;
		this.child = undefined;
		this.buffer = "";
		if (child && !child.killed) child.kill("SIGKILL");
		if (restart) this.ensureChild();
	}
}

export class PythonReadPool {
	readonly concurrency: 1 | 4 | 8;
	private readonly workers: PythonWorker[];
	private cursor = 0;

	constructor(concurrency: 1 | 4 | 8, executable = findPythonExecutable()) {
		if (!executable) throw new Error("Python 3 is unavailable");
		this.concurrency = concurrency;
		this.workers = Array.from({ length: concurrency }, () => new PythonWorker(executable));
	}

	async execute(
		invocation: CapabilityInvocation,
		projectRoot: string,
		signal?: AbortSignal,
	): Promise<CapabilityExecution> {
		if (
			invocation.effect !== "read" ||
			invocation.policy.decision !== "allow" ||
			(invocation.capability !== "searchText" && invocation.capability !== "searchSymbol")
		) {
			return executeReadCapability(invocation, projectRoot);
		}
		const started = this.cursor;
		do {
			const worker = this.workers[this.cursor]!;
			this.cursor = (this.cursor + 1) % this.workers.length;
			if (worker.idle) return worker.execute(invocation, projectRoot, signal);
		} while (this.cursor !== started);
		return executeReadCapability(invocation, projectRoot);
	}

	processIds(): readonly number[] {
		return this.workers.flatMap(({ processId }) => (processId === undefined ? [] : [processId]));
	}

	close(): void {
		for (const worker of this.workers) worker.close();
	}
}
