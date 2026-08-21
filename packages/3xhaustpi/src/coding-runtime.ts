import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	type Stats,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import {
	type PatchProposal,
	parseProjectId,
	parseSemanticOutput,
	parseSemanticTurnRequest,
	type SemanticOutput,
} from "@3xhaust/semantic-contract";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import { compileSemanticOutput, normalizeObservation } from "../../core/src/index.ts";
import {
	createThreeXhaustPiAdapter,
	type SemanticTurnResult,
	semanticProviderSessionId,
	X3HAUST_SEMANTIC_STABLE_PREFIX,
} from "../../pi-adapter/src/index.ts";
import { executeReadCapability } from "./capability-executor.ts";
import { runObserverHooks } from "./hook-runner.ts";
import { createProjectSnapshot, displayName, type ProjectDocument } from "./project-snapshot.ts";
import {
	createProviderRuntime,
	DEFAULT_MODEL,
	DEFAULT_PROVIDER,
	providerCredentialOverride,
	resolveModel,
} from "./provider-runtime.ts";
import { PythonReadPool } from "./python-read-pool.ts";
import { loadHarnessResources } from "./resource-loader.ts";
import { type ResumeCheckpoint, ThreeXhaustState } from "./state.ts";

export interface CodingTaskResourceOptions {
	readonly enabled: boolean;
	readonly allowProjectHooks?: boolean;
	readonly userRoot?: string;
	readonly builtinRoot?: string;
}

export interface CodingTaskInput {
	readonly projectRoot: string;
	readonly objective: string;
	readonly images?: readonly CodingTaskImage[];
	readonly approve: boolean;
	readonly statePath?: string;
	readonly provider?: string;
	readonly model?: string;
	readonly credential?: string;
	readonly sessionId?: string;
	/** Use only non-executing diagnostics and never run validation scripts from the project. */
	readonly strict?: boolean;
	/** @deprecated Independent full-context tasks always release continuation resources. */
	readonly preserveProviderSession?: boolean;
	readonly signal?: AbortSignal;
	readonly onEvent?: (event: CodingTaskEvent) => void;
	readonly requestApproval?: (proposal: CodingTaskPatchProposal) => Promise<boolean>;
	readonly resumeCheckpoint?: ResumeCheckpoint;
	readonly resources?: CodingTaskResourceOptions;
}

export interface CodingTaskImage {
	readonly data: string;
	readonly mimeType: "image/jpeg" | "image/png" | "image/webp";
}

export interface CodingTaskUsage {
	readonly input: number | null;
	readonly output: number | null;
	readonly cacheRead: number | null;
}

export interface CodingTaskPatchProposal {
	readonly patchId: string;
	readonly targetRevision: string;
	readonly diff: string;
	readonly files: readonly string[];
}

export type CodingTaskEvent =
	| {
			readonly type: "session.started";
			readonly sessionId: string;
			readonly provider: string;
			readonly model: string;
			readonly objective: string;
	  }
	| {
			readonly type: "model.completed";
			readonly responseId: string;
			readonly usage: CodingTaskUsage;
			readonly durationMs: number;
	  }
	| {
			readonly type: "capability.started";
			readonly capability: "searchText" | "searchSymbol" | "readRanges" | "applyPatch" | "getDiagnostics";
	  }
	| {
			readonly type: "capability.completed";
			readonly capability: "searchText" | "searchSymbol" | "readRanges" | "applyPatch" | "getDiagnostics";
			readonly success: boolean;
			readonly durationMs: number;
			readonly summary: string;
	  }
	| ({ readonly type: "patch.proposed" } & CodingTaskPatchProposal)
	| {
			readonly type: "patch.decision";
			readonly patchId: string;
			readonly approved: boolean;
	  }
	| {
			readonly type: "diagnostics.completed";
			readonly success: boolean;
			readonly command: string;
			readonly output: string;
			readonly durationMs: number;
	  }
	| {
			readonly type: "assistant.message";
			readonly text: string;
	  }
	| {
			readonly type: "session.completed";
			readonly sessionId: string;
			readonly outcome: "completed" | "rejected";
			readonly decision: string;
			readonly usage: CodingTaskUsage;
	  }
	| {
			readonly type: "session.failed";
			readonly sessionId: string;
			readonly message: string;
	  };

export interface CodingTaskResult {
	readonly sessionId: string;
	readonly outcome: "completed" | "rejected";
	readonly decision: string;
	readonly usage: CodingTaskUsage;
	readonly patchId?: string;
	readonly diagnostics?: {
		readonly success: boolean;
		readonly command: string;
		readonly output: string;
	};
}

export interface ConversationInput {
	readonly provider?: string;
	readonly model?: string;
	readonly credential?: string;
	readonly system: string;
	readonly prompt: string;
	readonly images?: readonly CodingTaskImage[];
	readonly sessionId?: string;
	readonly signal?: AbortSignal;
}

export interface ConversationResult {
	readonly text: string;
	readonly inputTokens: number;
	readonly outputTokens: number;
}

export async function runConversation(input: ConversationInput): Promise<ConversationResult> {
	const provider = input.provider ?? DEFAULT_PROVIDER;
	const modelId = input.model ?? DEFAULT_MODEL;
	const models = createProviderRuntime(
		input.credential ? providerCredentialOverride(provider, input.credential) : undefined,
	);
	if (!(await models.checkAuth(provider))) throw new Error(`Provider is not authenticated: ${provider}`);
	const model = resolveModel(models, provider, modelId);
	try {
		const message = await models.completeSimple(
			model,
			{
				systemPrompt: input.system,
				messages: [
					{
						role: "user",
						content: input.images?.length
							? [
									{ type: "text", text: input.prompt },
									...input.images.map((image) => ({
										type: "image" as const,
										data: image.data,
										mimeType: image.mimeType,
									})),
								]
							: input.prompt,
						timestamp: Date.now(),
					},
				],
			},
			{
				...(input.signal ? { signal: input.signal } : {}),
				...(input.sessionId ? { sessionId: input.sessionId, promptCacheKey: input.sessionId } : {}),
				...(model.api === "openai-codex-responses" ? { transport: "websocket" as const } : {}),
				cacheRetention: "long",
				maxRetries: 0,
				maxTokens: 4_096,
			},
		);
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			throw new Error(message.errorMessage ?? `Provider stopped with ${message.stopReason}`);
		}
		if (message.content.some((content) => content.type === "toolCall")) {
			throw new Error("Conversation provider returned an undeclared tool call");
		}
		const text = message.content
			.filter((content) => content.type === "text")
			.map((content) => content.text)
			.join("")
			.trim();
		if (!text) throw new Error("Conversation provider returned no text");
		return {
			text,
			inputTokens: message.usage.input,
			outputTokens: message.usage.output,
		};
	} finally {
		if (input.sessionId) cleanupSessionResources(input.sessionId);
	}
}

export interface ResumeCodingTaskInput {
	readonly approve: boolean;
	readonly statePath?: string;
	readonly sessionId?: string;
	readonly projectRoot?: string;
	readonly credential?: string;
	/** Use only non-executing diagnostics and never run validation scripts from the project. */
	readonly strict?: boolean;
	readonly preserveProviderSession?: boolean;
	readonly signal?: AbortSignal;
	readonly onEvent?: (event: CodingTaskEvent) => void;
	readonly requestApproval?: (proposal: CodingTaskPatchProposal) => Promise<boolean>;
	readonly resources?: CodingTaskResourceOptions;
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

interface DurableCodingTaskCheckpoint {
	readonly version: 1;
	readonly phase:
		| "provider-ready"
		| "provider-settled"
		| "followup-ready"
		| "followup-settled"
		| "patch-approved"
		| "patch-applied";
	readonly projectRoot: string;
	readonly objective: string;
	readonly images?: readonly CodingTaskImage[];
	readonly approve: boolean;
	readonly provider: string;
	readonly model: string;
	readonly sessionId: string;
	readonly requestId: string;
	readonly fingerprint: string;
	readonly snapshotSha256: string;
	readonly snapshotRevision?: string;
	readonly documents?: readonly ProjectDocument[];
	readonly generation: number;
	readonly result?: PersistedSemanticResult;
	readonly finalResult?: PersistedSemanticResult;
	readonly observationId?: string;
}

interface PersistedSemanticResult {
	readonly output: SemanticOutput;
	readonly responseId?: string;
	readonly usage: CodingTaskUsage;
}

function parseDurableCodingTaskCheckpoint(checkpoint: ResumeCheckpoint): DurableCodingTaskCheckpoint {
	const candidate = JSON.parse(checkpoint.payload) as Partial<DurableCodingTaskCheckpoint>;
	if (
		candidate.version !== 1 ||
		![
			"provider-ready",
			"provider-settled",
			"followup-ready",
			"followup-settled",
			"patch-approved",
			"patch-applied",
		].includes(candidate.phase ?? "") ||
		typeof candidate.projectRoot !== "string" ||
		typeof candidate.objective !== "string" ||
		typeof candidate.approve !== "boolean" ||
		typeof candidate.provider !== "string" ||
		typeof candidate.model !== "string" ||
		typeof candidate.sessionId !== "string" ||
		typeof candidate.requestId !== "string" ||
		typeof candidate.fingerprint !== "string" ||
		typeof candidate.snapshotSha256 !== "string" ||
		!Number.isSafeInteger(candidate.generation)
	) {
		throw new Error("Durable coding checkpoint is invalid or unsupported");
	}
	if (
		candidate.sessionId !== checkpoint.sessionId ||
		candidate.requestId !== checkpoint.requestId ||
		candidate.fingerprint !== checkpoint.fingerprint ||
		candidate.projectRoot !== checkpoint.projectPath ||
		candidate.generation !== checkpoint.generation
	) {
		throw new Error("Durable coding checkpoint identity does not match the state database");
	}
	const ready = candidate.phase === "provider-ready" || candidate.phase === "followup-ready";
	if ((ready && checkpoint.outboxState !== "queued") || (!ready && checkpoint.outboxState !== "settled")) {
		throw new Error(`Checkpoint provider state is ${checkpoint.outboxState}; automatic replay is blocked`);
	}
	const result = candidate.result
		? {
				output: parseSemanticOutput(candidate.result.output),
				...(candidate.result.responseId ? { responseId: candidate.result.responseId } : {}),
				usage: candidate.result.usage,
			}
		: undefined;
	if (candidate.phase === "provider-settled" && !result) {
		throw new Error("Settled provider checkpoint has no durable response");
	}
	const finalResult = candidate.finalResult
		? {
				output: parseSemanticOutput(candidate.finalResult.output),
				...(candidate.finalResult.responseId ? { responseId: candidate.finalResult.responseId } : {}),
				usage: candidate.finalResult.usage,
			}
		: undefined;
	if (
		(candidate.phase === "followup-ready" || candidate.phase === "followup-settled") &&
		(!result || typeof candidate.observationId !== "string")
	) {
		throw new Error("Follow-up checkpoint is missing its durable observation");
	}
	if (candidate.phase === "followup-settled" && !finalResult) {
		throw new Error("Settled follow-up checkpoint has no durable response");
	}
	if (
		(candidate.phase === "patch-approved" || candidate.phase === "patch-applied") &&
		(!result ||
			typeof candidate.snapshotRevision !== "string" ||
			!Array.isArray(candidate.documents) ||
			candidate.documents.length === 0)
	) {
		throw new Error("Patch checkpoint is missing its durable project evidence");
	}
	return {
		...(candidate as DurableCodingTaskCheckpoint),
		...(result ? { result } : {}),
		...(finalResult ? { finalResult } : {}),
	};
}

function approvalQuestion(): Promise<boolean> {
	const readline = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => {
		readline.question("Apply this patch? [y/N] ", (answer) => {
			readline.close();
			resolve(["y", "yes"].includes(answer.trim().toLowerCase()));
		});
	});
}

function renderPatch(proposal: PatchProposal, documents: ReadonlyMap<string, ProjectDocument>): string {
	const lines: string[] = [];
	for (const edit of proposal.edits) {
		const document = documents.get(edit.documentId);
		if (!document) throw new Error(`Patch references undisclosed document ${edit.documentId}`);
		lines.push(`--- a/${document.relativePath}`, `+++ b/${document.relativePath}`, `@@ exact replacement @@`);
		for (const line of edit.oldText.split("\n")) lines.push(`-${line}`);
		for (const line of edit.newText.split("\n")) lines.push(`+${line}`);
	}
	return lines.join("\n");
}

interface SecureProjectRoot {
	readonly path: string;
	readonly device: number;
	readonly inode: number;
}

function secureProjectRoot(projectRoot: string): SecureProjectRoot {
	const path = realpathSync(projectRoot);
	const stats = statSync(path);
	if (!stats.isDirectory()) throw new Error(`Project root is not a directory: ${projectRoot}`);
	return { path, device: stats.dev, inode: stats.ino };
}

function isPathContained(root: string, path: string): boolean {
	const fromRoot = relative(root, path);
	return fromRoot === "" || (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
}

function verifyProjectRoot(root: SecureProjectRoot): void {
	const stats = statSync(root.path);
	if (realpathSync(root.path) !== root.path || stats.dev !== root.device || stats.ino !== root.inode) {
		throw new Error("Project root changed while applying the patch");
	}
}

function lstatIfExists(path: string): Stats | undefined {
	try {
		return lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function verifyPatchPath(root: SecureProjectRoot, path: string): Stats | undefined {
	verifyProjectRoot(root);
	if (!isPathContained(root.path, path) || path === root.path) {
		throw new Error(`Patch target escapes the project: ${path}`);
	}
	const fromRoot = relative(root.path, path);
	let current = root.path;
	let targetStats: Stats | undefined;
	for (const component of fromRoot.split(sep)) {
		current = join(current, component);
		const stats = lstatIfExists(current);
		if (!stats) break;
		if (stats.isSymbolicLink()) throw new Error(`Patch target contains a symbolic link: ${current}`);
		targetStats = current === path ? stats : undefined;
	}
	let existing = path;
	while (!lstatIfExists(existing) && existing !== root.path) existing = dirname(existing);
	const canonicalExisting = realpathSync(existing);
	if (!isPathContained(root.path, canonicalExisting)) {
		throw new Error(`Patch target resolves outside the project: ${path}`);
	}
	return targetStats;
}

function ensurePatchParent(root: SecureProjectRoot, path: string): void {
	const parent = dirname(path);
	const fromRoot = relative(root.path, parent);
	let current = root.path;
	for (const component of fromRoot === "" ? [] : fromRoot.split(sep)) {
		current = join(current, component);
		const existing = verifyPatchPath(root, current);
		if (!existing) mkdirSync(current, { mode: 0o755 });
		const stats = verifyPatchPath(root, current);
		if (!stats?.isDirectory()) throw new Error(`Patch parent is not a directory: ${current}`);
	}
}

function patchPath(root: SecureProjectRoot, relativePath: string): string {
	const path = resolve(root.path, relativePath);
	verifyPatchPath(root, path);
	return path;
}

function preparePatchedFiles(
	projectRoot: string,
	proposal: PatchProposal,
	documents: ReadonlyMap<string, ProjectDocument>,
): readonly {
	readonly document: ProjectDocument;
	readonly before: string;
	readonly after: string;
	readonly existedBefore: boolean;
}[] {
	const secureRoot = secureProjectRoot(projectRoot);
	const pending = new Map<
		string,
		{
			document: ProjectDocument;
			before: string;
			after: string;
			existedBefore: boolean;
		}
	>();
	for (const edit of proposal.edits) {
		const document = documents.get(edit.documentId);
		if (!document) throw new Error(`Patch references undisclosed document ${edit.documentId}`);
		const previous = pending.get(edit.documentId);
		const path = patchPath(secureRoot, document.relativePath);
		const existedBefore = previous?.existedBefore ?? verifyPatchPath(secureRoot, path) !== undefined;
		const current =
			previous?.after ??
			(existedBefore
				? readFileSync(path, "utf8")
				: document.virtual
					? document.content
					: (() => {
							throw new Error(`Patch target is unavailable for ${displayName(document)}`);
						})());
		const first = current.indexOf(edit.oldText);
		if (first < 0) {
			const alreadyApplied = current.indexOf(edit.newText);
			if (alreadyApplied < 0 || current.indexOf(edit.newText, alreadyApplied + edit.newText.length) >= 0) {
				throw new Error(`Patch oldText is stale for ${displayName(document)}`);
			}
			pending.set(edit.documentId, {
				document,
				before: previous?.before ?? current,
				after: current,
				existedBefore,
			});
			continue;
		}
		if (current.indexOf(edit.oldText, first + edit.oldText.length) >= 0) {
			throw new Error(`Patch oldText is ambiguous for ${displayName(document)}`);
		}
		pending.set(edit.documentId, {
			document,
			before: previous?.before ?? current,
			after: `${current.slice(0, first)}${edit.newText}${current.slice(first + edit.oldText.length)}`,
			existedBefore,
		});
	}
	return [...pending.values()];
}

async function executeTaskReadCapability(
	invocation: Parameters<typeof executeReadCapability>[0],
	projectRoot: string,
	documents: ReadonlyMap<string, ProjectDocument>,
	pythonPool?: PythonReadPool,
) {
	if (pythonPool && (invocation.capability === "searchText" || invocation.capability === "searchSymbol")) {
		try {
			return await pythonPool.execute(invocation, projectRoot);
		} catch {
			return executeReadCapability(invocation, projectRoot);
		}
	}
	if (invocation.capability !== "readRanges") return executeReadCapability(invocation, projectRoot);
	if (invocation.policy.decision !== "allow") {
		return { status: "failed" as const, summary: "readRanges was denied", matchCount: 0, outputHashInput: "" };
	}
	const requested = Array.isArray(invocation.input.documentIds)
		? invocation.input.documentIds.filter((id): id is string => typeof id === "string")
		: [];
	const selected = requested.filter((id) => documents.has(id));
	return {
		status: selected.length > 0 ? ("succeeded" as const) : ("failed" as const),
		summary: selected.length > 0 ? `Read ${selected.length} disclosed documents` : "No disclosed documents matched",
		matchCount: selected.length,
		outputHashInput: selected.map((id) => documents.get(id)?.sha256 ?? "").join("\n"),
	};
}

function writePatchFile(root: SecureProjectRoot, path: string, content: string, mode: number): void {
	ensurePatchParent(root, path);
	const temporary = `${path}.3xhaust-${process.pid}-${randomUUID()}.tmp`;
	verifyPatchPath(root, path);
	try {
		writeFileSync(temporary, content, { encoding: "utf8", mode, flag: "wx" });
		verifyPatchPath(root, path);
		const temporaryStats = verifyPatchPath(root, temporary);
		if (!temporaryStats?.isFile()) throw new Error(`Patch temporary file is unavailable: ${temporary}`);
		renameSync(temporary, path);
	} catch (error) {
		try {
			verifyPatchPath(root, temporary);
			rmSync(temporary, { force: true });
		} catch {
			// Leave an unverifiable temporary path untouched rather than risk deleting outside the project.
		}
		throw error;
	}
}

function applyPreparedFiles(
	projectRoot: string,
	files: readonly {
		readonly document: ProjectDocument;
		readonly before: string;
		readonly after: string;
		readonly existedBefore: boolean;
	}[],
): void {
	const root = secureProjectRoot(projectRoot);
	const applied: { readonly file: (typeof files)[number]; readonly mode: number }[] = [];
	try {
		for (const file of files) {
			const path = patchPath(root, file.document.relativePath);
			const targetStats = verifyPatchPath(root, path);
			if (file.existedBefore && !targetStats?.isFile()) {
				throw new Error(`Patch target is not a regular file: ${path}`);
			}
			const mode = targetStats?.mode ?? 0o644;
			writePatchFile(root, path, file.after, mode);
			applied.push({ file, mode });
		}
	} catch (error) {
		for (const { file, mode } of applied.reverse()) {
			const path = patchPath(root, file.document.relativePath);
			if (file.existedBefore) writePatchFile(root, path, file.before, mode);
			else {
				verifyPatchPath(root, path);
				rmSync(path, { force: true });
			}
		}
		throw error;
	}
}

function runDiagnostics(
	projectRoot: string,
	strict: boolean,
): {
	readonly success: boolean;
	readonly command: string;
	readonly output: string;
} {
	let command = "git diff --check";
	let executable = "git";
	let args = ["diff", "--check"];
	if (!strict && existsSync(join(projectRoot, "package.json"))) {
		const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as {
			readonly scripts?: Readonly<Record<string, string>>;
		};
		if (packageJson.scripts?.test) {
			command = "npm test";
			executable = "npm";
			args = ["test"];
		}
	}
	const result = spawnSync(executable, args, {
		cwd: projectRoot,
		encoding: "utf8",
		timeout: 120_000,
		maxBuffer: 4_194_304,
		env: { ...process.env, CI: "1" },
	});
	return {
		success: result.status === 0,
		command,
		output: `${result.stdout}${result.stderr}`.trim().slice(-16_000),
	};
}

function measured(result: SemanticTurnResult, field: "input" | "output" | "cacheRead"): number | null {
	const value = result.usage[field];
	return value.status === "measured" ? value.value : null;
}

const PROVIDER_TURN_TIMEOUT_MS = 60_000;

async function runProviderTurn<T>(
	parent: AbortSignal | undefined,
	operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	const abortFromParent = () => controller.abort(parent?.reason ?? new Error("Provider turn cancelled"));
	if (parent?.aborted) abortFromParent();
	else parent?.addEventListener("abort", abortFromParent, { once: true });
	const timer = setTimeout(
		() => controller.abort(new Error(`Provider turn timed out after ${PROVIDER_TURN_TIMEOUT_MS} ms`)),
		PROVIDER_TURN_TIMEOUT_MS,
	);
	const aborted = new Promise<never>((_resolve, reject) => {
		const rejectAbort = () => {
			const reason = controller.signal.reason;
			reject(reason instanceof Error ? reason : new Error(String(reason ?? "Provider turn cancelled")));
		};
		if (controller.signal.aborted) rejectAbort();
		else controller.signal.addEventListener("abort", rejectAbort, { once: true });
	});
	try {
		return await Promise.race([operation(controller.signal), aborted]);
	} finally {
		clearTimeout(timer);
		parent?.removeEventListener("abort", abortFromParent);
	}
}

export function configuredPythonConcurrency(environment: NodeJS.ProcessEnv = process.env): 1 | 4 | 8 | undefined {
	if (!environment.X3HAUSTPI_PYTHON) return undefined;
	const value = Number(environment.X3HAUSTPI_PYTHON_CONCURRENCY ?? "1");
	if (value !== 1 && value !== 4 && value !== 8) {
		throw new Error("X3HAUSTPI_PYTHON_CONCURRENCY must be 1, 4, or 8");
	}
	return value;
}

export function providerCacheSessionId(projectRoot: string, provider: string, model: string, objective = ""): string {
	return `3xhaustpi-semantic-${digest(`${X3HAUST_SEMANTIC_STABLE_PREFIX}\0${projectRoot}\0${provider}\0${model}\0${objective}`).slice(0, 24)}`;
}

export function semanticOperationTurnIds(
	projectRoot: string,
	objective: string,
	projectRevision: string,
): {
	readonly initial: `turn_${string}`;
	readonly followup: `turn_${string}`;
} {
	const operation = digest(`${projectRoot}\0${objective}\0${projectRevision}`);
	return {
		initial: `turn_${operation.slice(0, 32)}`,
		followup: `turn_${digest(`${operation}\0followup`).slice(0, 32)}`,
	};
}

export async function runCodingTask(input: CodingTaskInput): Promise<CodingTaskResult> {
	const recovered = input.resumeCheckpoint ? parseDurableCodingTaskCheckpoint(input.resumeCheckpoint) : undefined;
	const projectRoot = recovered?.projectRoot ?? input.projectRoot;
	const objective = recovered?.objective ?? input.objective;
	const images = recovered?.images ?? input.images ?? [];
	const providerImages = images.map((image) => ({ type: "image" as const, ...image }));
	const provider = recovered?.provider ?? input.provider ?? DEFAULT_PROVIDER;
	const modelId = recovered?.model ?? input.model ?? DEFAULT_MODEL;
	const approve = recovered?.approve ?? input.approve;
	const resources = input.resources?.enabled
		? loadHarnessResources({
				projectRoot,
				allowProjectHooks: input.resources.allowProjectHooks,
				...(input.resources.userRoot ? { userRoot: input.resources.userRoot } : {}),
				...(input.resources.builtinRoot ? { builtinRoot: input.resources.builtinRoot } : {}),
			})
		: { skills: [], hooks: [], entries: [], skillContext: "", digest: "sha256:disabled" };
	let hookChain = Promise.resolve<unknown>(undefined);
	const emit = (event: CodingTaskEvent): void => {
		input.onEvent?.(event);
		if (resources.hooks.length > 0) {
			hookChain = hookChain.then(() => runObserverHooks(resources.hooks, event, { cwd: projectRoot }));
		}
	};
	const models = createProviderRuntime(
		input.credential ? providerCredentialOverride(provider, input.credential) : undefined,
	);
	const needsProvider = !recovered || recovered.phase === "provider-ready" || recovered.phase === "followup-ready";
	if (needsProvider && !(await models.checkAuth(provider))) {
		throw new Error(`Provider is not authenticated: ${provider}`);
	}
	const model = resolveModel(models, provider, modelId);
	const snapshot = createProjectSnapshot(projectRoot, objective);
	const skillContextBudget = Math.max(0, 18_000 - snapshot.stableContext.length - 2);
	const stableContext =
		skillContextBudget > 0 && resources.skillContext
			? `${snapshot.stableContext}\n\n${resources.skillContext.slice(0, skillContextBudget)}`
			: snapshot.stableContext;
	const resumesApprovedPatch = recovered?.phase === "patch-approved" || recovered?.phase === "patch-applied";
	if (recovered && !resumesApprovedPatch && recovered.snapshotSha256 !== snapshot.sha256) {
		throw new Error("Project evidence changed after the checkpoint; resume blocked as stale");
	}
	const durableDocuments = resumesApprovedPatch ? recovered.documents! : snapshot.documents;
	const documents = new Map(durableDocuments.map((document) => [document.id, document]));
	const snapshotRevision = recovered?.snapshotRevision ?? snapshot.revision;
	const snapshotSha256 = recovered?.snapshotSha256 ?? snapshot.sha256;
	const projectId = parseProjectId(`prj_${digest(projectRoot).slice(0, 24)}`);
	const sessionId = recovered?.sessionId ?? input.sessionId ?? `session_${randomUUID()}`;
	const providerSessionId = providerCacheSessionId(projectRoot, provider, modelId, objective);
	const semanticTurnIds = semanticOperationTurnIds(projectRoot, objective, snapshotRevision);
	const requestId = recovered?.requestId ?? `req_${randomUUID()}`;
	const fingerprint = recovered?.fingerprint ?? digest(`${projectRoot}\0${objective}`);
	const generation = recovered?.generation ?? 1;
	const state = new ThreeXhaustState(input.statePath);
	const pythonConcurrency = configuredPythonConcurrency();
	const pythonPool = pythonConcurrency ? new PythonReadPool(pythonConcurrency) : undefined;
	let latestUsage: CodingTaskUsage = { input: null, output: null, cacheRead: null };
	const durableBase = {
		version: 1 as const,
		projectRoot,
		objective,
		...(images.length > 0 ? { images } : {}),
		approve,
		provider,
		model: modelId,
		sessionId,
		requestId,
		fingerprint,
		snapshotSha256,
		snapshotRevision,
		documents: durableDocuments,
		generation,
	};
	if (!recovered) {
		const checkpoint: DurableCodingTaskCheckpoint = {
			...durableBase,
			phase: "provider-ready",
		};
		state.beginRun({
			projectId,
			projectPath: projectRoot,
			sessionId,
			requestId,
			fingerprint,
			payload: JSON.stringify({ objective }),
			checkpoint: JSON.stringify(checkpoint),
			generation,
		});
	}
	emit({ type: "session.started", sessionId, provider, model: modelId, objective });

	try {
		const adapter = createThreeXhaustPiAdapter({
			complete: (requestModel, context, options) => models.completeSimple(requestModel, context, options),
		});
		const semanticSession = adapter.open({
			connectionId: `connection_${provider}`,
			model,
			sessionId: providerSessionId,
			cacheRetention: "long",
			cacheUsageSupport: { read: "reported", write: "unsupported" },
			stableContext,
			maxTokens: 2_048,
		});
		let first: PersistedSemanticResult;
		if (recovered && recovered.phase !== "provider-ready") {
			first = recovered.result!;
			latestUsage = first.usage;
		} else {
			state.markProviderDispatching(requestId, generation);
			const firstStarted = performance.now();
			const liveFirst = await runProviderTurn(input.signal, (signal) =>
				semanticSession.submit(
					parseSemanticTurnRequest({
						protocolVersion: 2,
						mode: "prompt",
						objective,
						disclosed: {
							selectionIds: [],
							documentIds: durableDocuments.map((document) => document.id),
							observationIds: [],
						},
					}),
					signal,
					providerImages,
				),
			);
			latestUsage = {
				input: measured(liveFirst, "input"),
				output: measured(liveFirst, "output"),
				cacheRead: measured(liveFirst, "cacheRead"),
			};
			emit({
				type: "model.completed",
				responseId: liveFirst.responseId ?? `response_${requestId}`,
				usage: latestUsage,
				durationMs: performance.now() - firstStarted,
			});
			first = {
				output: liveFirst.output,
				...(liveFirst.responseId ? { responseId: liveFirst.responseId } : {}),
				usage: latestUsage,
			};
			state.settleProviderAndCheckpoint(
				requestId,
				sessionId,
				generation,
				liveFirst.responseId,
				JSON.stringify({ ...durableBase, phase: "provider-settled", result: first }),
			);
		}
		let decision = await compileSemanticOutput(first.output, {
			projectId,
			turnId: semanticTurnIds.initial,
			projectRevision: snapshotRevision,
			observationDigests: [],
		});
		let finalResult: PersistedSemanticResult = first;
		let observationId = recovered?.observationId;
		let checkpointGeneration = recovered?.generation ?? generation;
		if (decision.kind === "readPlan" && decision.invocations.length === 1) {
			const invocation = decision.invocations[0]!;
			const exactTarget =
				typeof invocation.input.query === "string"
					? JSON.stringify(invocation.input.query)
					: "the disclosed bounded evidence";
			if (recovered?.finalResult) {
				finalResult = recovered.finalResult!;
				latestUsage = finalResult.usage;
			} else {
				const followupGeneration = recovered?.phase === "followup-ready" ? recovered.generation : generation + 1;
				checkpointGeneration = followupGeneration;
				if (!observationId) {
					emit({ type: "capability.started", capability: invocation.capability });
					const capabilityStarted = performance.now();
					const outcome = await executeTaskReadCapability(invocation, projectRoot, documents, pythonPool);
					emit({
						type: "capability.completed",
						capability: invocation.capability,
						success: outcome.status === "succeeded",
						durationMs: performance.now() - capabilityStarted,
						summary: outcome.summary,
					});
					const observation = await normalizeObservation(invocation, {
						status: outcome.status,
						summary: outcome.summary,
						facts: { matchCount: outcome.matchCount, outputSha256: digest(outcome.outputHashInput) },
						artifactRefs: [],
					});
					observationId = observation.observationId;
					state.recordObservation(sessionId, observationId, JSON.stringify(observation));
					state.prepareProviderDispatch(
						requestId,
						sessionId,
						followupGeneration,
						digest(`${objective}\0${observationId}`),
						JSON.stringify({
							...durableBase,
							phase: "followup-ready",
							generation: followupGeneration,
							result: first,
							observationId,
						}),
					);
				}
				state.markProviderDispatching(requestId, followupGeneration);
				const followUpStarted = performance.now();
				const liveFinalResult = await runProviderTurn(input.signal, (signal) =>
					semanticSession.submit(
						parseSemanticTurnRequest({
							protocolVersion: 2,
							mode: "followUp",
							objective: `Successful observation: ${exactTarget}.`,
							disclosed: {
								selectionIds: [],
								documentIds: durableDocuments.map((document) => document.id),
								observationIds: [observationId],
							},
						}),
						signal,
					),
				);
				latestUsage = {
					input: measured(liveFinalResult, "input"),
					output: measured(liveFinalResult, "output"),
					cacheRead: measured(liveFinalResult, "cacheRead"),
				};
				emit({
					type: "model.completed",
					responseId: liveFinalResult.responseId ?? `response_${requestId}_followup`,
					usage: latestUsage,
					durationMs: performance.now() - followUpStarted,
				});
				finalResult = {
					output: liveFinalResult.output,
					...(liveFinalResult.responseId ? { responseId: liveFinalResult.responseId } : {}),
					usage: latestUsage,
				};
				state.settleProviderAndCheckpoint(
					requestId,
					sessionId,
					followupGeneration,
					liveFinalResult.responseId,
					JSON.stringify({
						...durableBase,
						phase: "followup-settled",
						generation: followupGeneration,
						result: first,
						finalResult,
						observationId,
					}),
				);
			}
			decision = await compileSemanticOutput(finalResult.output, {
				projectId,
				turnId: semanticTurnIds.followup,
				projectRevision: snapshotRevision,
				observationDigests: observationId ? [observationId] : [],
			});
		}
		await semanticSession.close();

		if (decision.kind !== "mutationProposal") {
			state.completeRun(sessionId, requestId, "completed");
			if (decision.kind === "completionSuggestion") emit({ type: "assistant.message", text: decision.summary });
			else if (decision.kind === "clarify") emit({ type: "assistant.message", text: decision.question });
			else throw new Error(`Coding task ended without a patch proposal: ${decision.kind}`);
			const result: CodingTaskResult = {
				sessionId,
				outcome: "completed",
				decision: decision.kind,
				usage: latestUsage,
			};
			emit({
				type: "session.completed",
				sessionId,
				outcome: result.outcome,
				decision: result.decision,
				usage: result.usage,
			});
			return result;
		}

		const patchId = `patch_${decision.proposal.proposalDigest.slice(-24)}`;
		const serializedProposal = JSON.stringify(decision.proposal);
		state.recordPatch(sessionId, patchId, snapshotRevision, "proposed", serializedProposal);
		const proposal: CodingTaskPatchProposal = {
			patchId,
			targetRevision: snapshotRevision,
			diff: renderPatch(decision.proposal, documents),
			files: decision.proposal.edits.map((edit) => {
				const document = documents.get(edit.documentId);
				if (!document) throw new Error(`Patch references undisclosed document ${edit.documentId}`);
				return document.relativePath;
			}),
		};
		emit({ type: "patch.proposed", ...proposal });
		const approved =
			resumesApprovedPatch ||
			approve ||
			(input.requestApproval
				? await input.requestApproval(proposal)
				: Boolean(process.stdin.isTTY && (await approvalQuestion())));
		emit({ type: "patch.decision", patchId, approved });
		if (!approved) {
			state.recordPatch(sessionId, patchId, snapshotRevision, "rejected", serializedProposal);
			state.completeRun(sessionId, requestId, "completed");
			const result: CodingTaskResult = {
				sessionId,
				outcome: "rejected",
				decision: decision.kind,
				usage: latestUsage,
				patchId,
			};
			emit({
				type: "session.completed",
				sessionId,
				outcome: result.outcome,
				decision: result.decision,
				usage: result.usage,
			});
			return result;
		}
		if (!resumesApprovedPatch) {
			const current = createProjectSnapshot(projectRoot, objective);
			if (current.revision !== snapshotRevision) {
				state.recordPatch(sessionId, patchId, snapshotRevision, "conflict", serializedProposal);
				throw new Error("Project revision changed after proposal; patch blocked as stale");
			}
			state.recordPatch(sessionId, patchId, snapshotRevision, "approved", serializedProposal);
			state.updateCheckpoint(
				sessionId,
				checkpointGeneration,
				JSON.stringify({
					...durableBase,
					phase: "patch-approved",
					generation: checkpointGeneration,
					result: first,
					finalResult,
					...(observationId ? { observationId } : {}),
				} satisfies DurableCodingTaskCheckpoint),
			);
		} else {
			state.recordPatch(
				sessionId,
				patchId,
				snapshotRevision,
				recovered?.phase === "patch-applied" ? "applied" : "approved",
				serializedProposal,
			);
		}
		const prepared = preparePatchedFiles(projectRoot, decision.proposal, documents);
		const filesToApply = prepared.filter((file) => file.before !== file.after);
		if (resumesApprovedPatch && filesToApply.length === prepared.length) {
			const current = createProjectSnapshot(projectRoot, objective);
			if (current.revision !== snapshotRevision) {
				state.recordPatch(sessionId, patchId, snapshotRevision, "conflict", serializedProposal);
				throw new Error("Project revision changed after proposal; patch blocked as stale");
			}
		}
		if (recovered?.phase !== "patch-applied") {
			emit({ type: "capability.started", capability: "applyPatch" });
			const patchStarted = performance.now();
			applyPreparedFiles(projectRoot, filesToApply);
			emit({
				type: "capability.completed",
				capability: "applyPatch",
				success: true,
				durationMs: performance.now() - patchStarted,
				summary: `Applied ${filesToApply.length} file${filesToApply.length === 1 ? "" : "s"}`,
			});
			state.recordPatch(sessionId, patchId, snapshotRevision, "applied", serializedProposal);
			state.updateCheckpoint(
				sessionId,
				checkpointGeneration,
				JSON.stringify({
					...durableBase,
					phase: "patch-applied",
					generation: checkpointGeneration,
					result: first,
					finalResult,
					...(observationId ? { observationId } : {}),
				} satisfies DurableCodingTaskCheckpoint),
			);
		}
		emit({ type: "capability.started", capability: "getDiagnostics" });
		const diagnosticsStarted = performance.now();
		const diagnostics = runDiagnostics(projectRoot, input.strict === true);
		const diagnosticsDurationMs = performance.now() - diagnosticsStarted;
		emit({
			type: "capability.completed",
			capability: "getDiagnostics",
			success: diagnostics.success,
			durationMs: diagnosticsDurationMs,
			summary: diagnostics.success ? `${diagnostics.command} passed` : `${diagnostics.command} failed`,
		});
		emit({ type: "diagnostics.completed", ...diagnostics, durationMs: diagnosticsDurationMs });
		if (!diagnostics.success) throw new Error(`Diagnostics failed: ${diagnostics.command}`);
		state.completeRun(sessionId, requestId, "completed");
		const result: CodingTaskResult = {
			sessionId,
			outcome: "completed",
			decision: decision.kind,
			usage: latestUsage,
			patchId,
			diagnostics,
		};
		emit({
			type: "session.completed",
			sessionId,
			outcome: result.outcome,
			decision: result.decision,
			usage: result.usage,
		});
		return result;
	} catch (error) {
		state.completeRun(sessionId, requestId, "failed");
		emit({
			type: "session.failed",
			sessionId,
			message: error instanceof Error ? error.message : String(error),
		});
		throw error;
	} finally {
		await hookChain;
		pythonPool?.close();
		// The Codex connection and prompt-cache affinity are project-scoped and expire
		// after five idle minutes. Each task still sends a full independent context.
		for (const phase of ["initial", "followup"] as const) {
			cleanupSessionResources(semanticProviderSessionId(providerSessionId, phase));
			cleanupSessionResources(semanticProviderSessionId(providerSessionId, phase, true));
		}
		state.close();
	}
}

export async function resumeCodingTask(input: ResumeCodingTaskInput): Promise<CodingTaskResult | undefined> {
	const state = new ThreeXhaustState(input.statePath);
	let checkpoint: ResumeCheckpoint | undefined;
	try {
		state.recoverInterruptedRuns();
		checkpoint = state.claimResumeCheckpoint(input.sessionId, input.projectRoot);
	} finally {
		state.close();
	}
	if (!checkpoint) return undefined;
	return runCodingTask({
		projectRoot: checkpoint.projectPath,
		objective: "",
		approve: input.approve,
		...(input.statePath ? { statePath: input.statePath } : {}),
		...(input.signal ? { signal: input.signal } : {}),
		...(input.onEvent ? { onEvent: input.onEvent } : {}),
		...(input.requestApproval ? { requestApproval: input.requestApproval } : {}),
		...(input.credential ? { credential: input.credential } : {}),
		...(input.strict ? { strict: true } : {}),
		...(input.preserveProviderSession ? { preserveProviderSession: true } : {}),
		...(input.resources ? { resources: input.resources } : {}),
		resumeCheckpoint: checkpoint,
	});
}
