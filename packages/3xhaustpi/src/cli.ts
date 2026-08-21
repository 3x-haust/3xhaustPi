import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseProjectId } from "@3xhaust/semantic-contract";
import { compileSemanticOutput, createCoordinatorState, enqueueTurn, startNextTurn } from "../../core/src/index.ts";
import { runAgentTask } from "./agent-runtime.ts";
import { CliArgumentError, parseCliArgs, type ThreeXhaustCommand } from "./args.ts";
import { type CodingTaskEvent, resumeCodingTask, runCodingTask } from "./coding-runtime.ts";
import { collectConnections, renderConnections } from "./connections.ts";
import { DesktopAccessibilityHost, desktopComputerUseStatus } from "./desktop-runtime.ts";
import { resolveProjectDataDirectory, resolveUserDataDirectory } from "./identity.ts";
import { callMcpTool, listMcpTools } from "./mcp-client.ts";
import { runNpmLogin, runNpmPublish } from "./npm-workflow.ts";
import { PRODUCT_DISPLAY_NAME, PRODUCT_VERSION } from "./product-identity.ts";
import { credentialStoreDescription, loginProvider, providerStatuses } from "./provider-runtime.ts";
import { runRealBenchmark } from "./real-benchmark.ts";
import { addMcpServer, loadMcpResources, renderResourceHub } from "./resource-hub.ts";
import { createSkillTemplate, loadHarnessResources } from "./resource-loader.ts";
import { runSelfUpdate } from "./self-update.ts";
import { ThreeXhaustState } from "./state.ts";
import { runTui } from "./tui.ts";

const RED = "\u001b[38;5;203m";
const RESET = "\u001b[0m";

function printCodingTaskEvent(event: CodingTaskEvent): void {
	if (event.type === "model.completed") {
		console.log(
			JSON.stringify({
				responseId: event.responseId,
				usage: event.usage,
				durationMs: event.durationMs,
			}),
		);
		return;
	}
	if (event.type === "patch.proposed") {
		console.log(event.diff);
		return;
	}
	if (event.type === "patch.decision" && !event.approved) {
		console.log(`Patch ${event.patchId} was not applied.`);
		return;
	}
	if (event.type === "assistant.message") {
		console.log(event.text);
		return;
	}
	if (event.type === "diagnostics.completed") {
		console.log(
			JSON.stringify(
				{
					success: event.success,
					command: event.command,
					output: event.output,
					durationMs: event.durationMs,
				},
				null,
				2,
			),
		);
	}
}

function printHelp(): void {
	console.log(`${PRODUCT_DISPLAY_NAME} ${PRODUCT_VERSION}

Usage:
  3xhaustpi
  3xhaustpi -p "로그인 오류를 조사하고 수정해"
  3xhaustpi --project ./my-project
  3xhaustpi --resume

Commands:
  auth login [provider]  Configure a provider connection
  models                 List supported providers and configuration state
  extension list         List discovered extension candidates
  resource list          Show Skills, MCP servers, and Hooks
  accounts               Show provider, Aside, and npm accounts
  npm login [account]    Run plain npm login through Aside
  npm publish [account]  Review account and publish package
  skill create <name>    Create an editable project skill
  mcp add <n> <cmd>      Add a project MCP server
  mcp tools <server>     List tools from a configured MCP server
  mcp call <srv> <tool>  Call a configured MCP tool with optional JSON args
  benchmark              Run the labeled local semantic-core benchmark
  benchmark --real       Run >=20 paired calls against an authenticated provider
  doctor                 Inspect install, runtime, and integration status
  update                 Update a global npm installation

Options:
  -p, --print <prompt>    Submit one non-interactive request
  --project <directory>  Select a project directory
  --resume               Resume a durable checkpoint
  --approve              Apply an exact patch proposal after printing its diff
  --provider <id>        Select an authenticated provider
  --model <id>           Select a provider model
  --allow-project-hooks  Enable declared project observer hooks
  -h, --help             Show help
  -v, --version          Show version`);
}

function canonicalProject(input: string | undefined): string {
	const target = resolve(input ?? process.cwd());
	if (!existsSync(target)) throw new Error(`Project directory does not exist: ${target}`);
	if (!statSync(target).isDirectory()) throw new Error(`Project path is not a directory: ${target}`);
	return realpathSync(target);
}

async function providerRows(): Promise<
	readonly {
		readonly provider: string;
		readonly auth: string;
		readonly configured: boolean;
	}[]
> {
	return providerStatuses();
}

async function printModels(): Promise<void> {
	console.log("Provider        Auth                         State");
	for (const row of await providerRows()) {
		console.log(
			`${row.provider.padEnd(15)} ${row.auth.padEnd(28)} ${row.configured ? "configured" : "unconfigured"}`,
		);
	}
	console.log("\nDefault real-provider route: openai-codex/gpt-5.6-terra");
}

function extensionDirectories(project: string): readonly string[] {
	return [join(resolveUserDataDirectory(), "extensions"), join(resolveProjectDataDirectory(project), "extensions")];
}

function printExtensions(project: string): void {
	const entries = extensionDirectories(project).flatMap((directory) =>
		existsSync(directory)
			? readdirSync(directory, { withFileTypes: true }).map((entry) => ({
					name: entry.name,
					scope: directory.startsWith(homedir()) ? "user" : "project",
					state: "disabled candidate",
				}))
			: [],
	);
	if (entries.length === 0) {
		console.log("No extension candidates found.");
		return;
	}
	for (const entry of entries) console.log(`${entry.scope.padEnd(8)} ${entry.state.padEnd(20)} ${entry.name}`);
}

function printResources(project: string): void {
	const resources = loadHarnessResources({ projectRoot: project });
	console.log(
		renderResourceHub({
			skills: resources.skills.map((skill) => ({
				id: skill.id,
				label: skill.name,
				scope: skill.scope,
				state: "enabled",
			})),
			mcpServers: loadMcpResources({ projectRoot: project }),
			hooks: resources.entries
				.filter((entry) => entry.kind === "hook")
				.map((entry) => ({
					id: entry.id,
					label: entry.reason ?? entry.sourcePath,
					scope: entry.scope,
					state: entry.state,
				})),
		}),
	);
}

function asidePath(): string {
	const result = spawnSync("which", ["aside"], { encoding: "utf8", timeout: 3_000 });
	const path = result.stdout.trim();
	if (result.status !== 0 || !path) throw new Error("Aside CLI is not installed or unavailable on PATH");
	return path;
}

function confirmPublish(review: {
	readonly account: string;
	readonly registry: string;
	readonly packageName: string;
	readonly version: string;
}): Promise<boolean> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve(false);
	console.log(
		[
			"",
			"npm publish review",
			`  account   ${review.account}`,
			`  registry  ${review.registry}`,
			`  package   ${review.packageName}@${review.version}`,
		].join("\n"),
	);
	const readline = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => {
		readline.question("Publish this package? [y/N] ", (answer) => {
			readline.close();
			resolve(["y", "yes"].includes(answer.trim().toLowerCase()));
		});
	});
}

async function runBenchmark(repetitions: number): Promise<void> {
	const projectId = parseProjectId("prj_benchmark");
	const samples: number[] = [];
	for (let index = 0; index < repetitions; index += 1) {
		const started = performance.now();
		await compileSemanticOutput(
			{
				protocolVersion: 2,
				kind: "intent",
				payload: {
					kind: "inspect",
					objective: "Inspect a reported login failure",
					target: { kind: "behavior", description: "login failure" },
					evidenceGoals: ["Locate relevant behavior"],
					constraints: ["Do not mutate"],
					doneWhen: "Relevant evidence is identified",
				},
			},
			{
				projectId,
				turnId: `turn_${index}`,
				projectRevision: "revision_benchmark",
				observationDigests: [],
			},
		);
		samples.push(performance.now() - started);
	}
	const sorted = [...samples].sort((left, right) => left - right);
	const percentile = (ratio: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
	console.log(
		JSON.stringify(
			{
				mode: "synthetic-local",
				realProvider: "unmeasured",
				repetitions,
				semanticValidity: "measured",
				meanMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
				p50Ms: percentile(0.5),
				p95Ms: percentile(0.95),
				note: "This measures local compiler overhead only. It is not an LLM performance result.",
			},
			null,
			2,
		),
	);
}

async function runCoordinatorSelfCheck(): Promise<boolean> {
	const initial = createCoordinatorState({
		sessionId: "session_doctor",
		projectId: parseProjectId("prj_doctor"),
		generation: 1,
	});
	const enqueued = await enqueueTurn(initial, {
		protocolVersion: 2,
		mode: "prompt",
		objective: "doctor",
		disclosed: { selectionIds: [], documentIds: [], observationIds: [] },
	});
	return startNextTurn(enqueued.state).turn?.request.objective === "doctor";
}

function acceptedBenchmark(project: string): string | undefined {
	const directory = join(project, "artifacts", "real-llm");
	if (!existsSync(directory)) return undefined;
	for (const name of readdirSync(directory)
		.filter((entry) => entry.endsWith(".json"))
		.sort()
		.reverse()) {
		try {
			const report = JSON.parse(readFileSync(join(directory, name), "utf8")) as {
				readonly accepted?: boolean;
				readonly pairedSuccesses?: number;
				readonly model?: string;
			};
			if (report.accepted)
				return `${report.pairedSuccesses ?? "?"} paired successes, ${report.model ?? "unknown model"}`;
		} catch {
			// Ignore malformed or partial artifacts and continue searching.
		}
	}
	return undefined;
}

async function doctor(project: string): Promise<void> {
	let sqlite = "unavailable";
	try {
		const state = new ThreeXhaustState(":memory:");
		state.close();
		sqlite = "verified";
	} catch {
		sqlite = "unavailable";
	}
	const coordinator = (await runCoordinatorSelfCheck()) ? "verified" : "unavailable";
	const git = spawnSync("git", ["--version"], { encoding: "utf8" });
	let configuredProviders = 0;
	let credentialStoreError: string | undefined;
	try {
		configuredProviders = (await providerRows()).filter((row) => row.configured).length;
	} catch (cause) {
		credentialStoreError = cause instanceof Error ? cause.message : String(cause);
	}
	const benchmark = acceptedBenchmark(project);
	const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
	const nativeManifestPath = resolve(packageRoot, "../../..", "runtime-manifest.json");
	const nativeManifest = (() => {
		try {
			const value = JSON.parse(readFileSync(nativeManifestPath, "utf8")) as {
				readonly product?: string;
				readonly target?: string;
				readonly node?: string;
				readonly python?: string;
			};
			return value.product === "3xhaustpi" ? value : undefined;
		} catch {
			return undefined;
		}
	})();
	const bundledPython =
		process.env.X3HAUSTPI_PYTHON && existsSync(process.env.X3HAUSTPI_PYTHON)
			? spawnSync(process.env.X3HAUSTPI_PYTHON, ["--version"], { encoding: "utf8", timeout: 5_000 })
			: undefined;
	const desktopStatus = desktopComputerUseStatus();
	const computerUse = await (async (): Promise<readonly [string, string]> => {
		if (!desktopStatus.available)
			return ["unavailable", `no external-app accessibility host for ${desktopStatus.platform}`];
		try {
			const result = await new DesktopAccessibilityHost({ timeoutMs: 5_000 }).listApplications();
			return result.trusted
				? ["verified", `${result.applications.length} GUI applications · ${desktopStatus.helper}`]
				: ["permission", `${desktopStatus.helper} · accessibility permission or desktop session required`];
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			return ["unavailable", message.replace(/\s+/gu, " ").trim().slice(0, 160)];
		}
	})();
	const rows = [
		["package/bin", "implemented", `3xhaustpi ${PRODUCT_VERSION}`],
		["project", "verified", project],
		["Node.js", "verified", process.version],
		[
			"Python accelerator",
			bundledPython?.status === 0 ? "verified" : "unavailable",
			(bundledPython?.stdout || bundledPython?.stderr || "not bundled").trim(),
		],
		["Git", git.status === 0 ? "verified" : "unavailable", git.stdout.trim() || git.stderr.trim()],
		["SQLite durability schema", sqlite, "queue/checkpoint/outbox/observation/patch journal"],
		["semantic compiler", coordinator, "protocol v2, code-owned capabilities"],
		[
			"provider credentials",
			configuredProviders > 0 ? "configured" : "unavailable",
			`${configuredProviders} configured`,
		],
		[
			"real provider task",
			configuredProviders > 0 ? "verified" : "unavailable",
			"semantic adapter + capability runtime",
		],
		[
			"credential store",
			credentialStoreError ? "unavailable" : "verified",
			credentialStoreError ?? credentialStoreDescription(),
		],
		["Computer Use", computerUse[0], computerUse[1]],
		["real paired benchmark", benchmark ? "verified" : "unavailable", benchmark ?? "requires 20 paired successes"],
		[
			"native archive",
			nativeManifest ? "verified" : "unavailable",
			nativeManifest
				? `${nativeManifest.target ?? "unknown target"} · Node ${nativeManifest.node ?? "?"} · Python ${nativeManifest.python ?? "?"}`
				: "npm/source installation",
		],
	] as const;
	for (const [name, status, detail] of rows) {
		console.log(`${name.padEnd(26)} ${status.padEnd(12)} ${detail}`);
	}
}

async function run(command: Extract<ThreeXhaustCommand, { readonly kind: "run" }>, project: string): Promise<void> {
	if (command.resume) {
		const checkpoint = (() => {
			const state = new ThreeXhaustState();
			try {
				state.recoverInterruptedRuns();
				const claimed = state.claimResumeCheckpoint(undefined, command.project ? project : undefined);
				if (!claimed) throw new Error(`No durable ${PRODUCT_DISPLAY_NAME} checkpoint is available to resume.`);
				return claimed;
			} finally {
				state.close();
			}
		})();
		await runCodingTask({
			projectRoot: checkpoint.projectPath,
			objective: "",
			approve: command.approve,
			resumeCheckpoint: checkpoint,
			onEvent: printCodingTaskEvent,
			resources: { enabled: true, allowProjectHooks: command.allowProjectHooks },
		});
		return;
	}
	const requestId = `req_${randomUUID()}`;
	const fingerprint = createHash("sha256")
		.update(`${project}\0${command.prompt ?? ""}`)
		.digest("hex")
		.slice(0, 16);
	if (!command.prompt && process.stdin.isTTY && process.stdout.isTTY) {
		return runTui({
			projectRoot: project,
			thinkingLevel: "medium",
			...(command.provider ? { provider: command.provider } : {}),
			...(command.model ? { model: command.model } : {}),
			runTask: async (projectRoot, objective, hooks, selectedModel) => {
				try {
					return await runAgentTask({
						projectRoot,
						objective,
						onEvent: hooks.onEvent,
						signal: hooks.signal,
						provider: selectedModel.provider,
						model: selectedModel.model,
						thinkingLevel: "medium",
					});
				} catch (error) {
					hooks.onEvent({
						type: "assistant.message",
						text: `Agent runtime unavailable, falling back: ${error instanceof Error ? error.message : String(error)}`,
					});
					return runCodingTask({
						projectRoot,
						objective,
						approve: false,
						onEvent: hooks.onEvent,
						requestApproval: hooks.requestApproval,
						signal: hooks.signal,
						resources: { enabled: true, allowProjectHooks: command.allowProjectHooks },
						provider: selectedModel.provider,
						model: selectedModel.model,
					});
				}
			},
			resumeTask: (projectRoot, sessionId, hooks) =>
				resumeCodingTask({
					approve: false,
					projectRoot,
					...(sessionId ? { sessionId } : {}),
					onEvent: hooks.onEvent,
					requestApproval: hooks.requestApproval,
					signal: hooks.signal,
					resources: { enabled: true, allowProjectHooks: command.allowProjectHooks },
				}),
		});
	}
	if (!command.prompt) throw new Error(`Request ${requestId} (${fingerprint}) has no objective`);
	try {
		await runAgentTask({
			projectRoot: project,
			objective: command.prompt,
			onEvent: printCodingTaskEvent,
			thinkingLevel: "medium",
			...(command.provider ? { provider: command.provider } : {}),
			...(command.model ? { model: command.model } : {}),
		});
	} catch (error) {
		console.error(
			`Agent runtime unavailable, falling back: ${error instanceof Error ? error.message : String(error)}`,
		);
		await runCodingTask({
			projectRoot: project,
			objective: command.prompt,
			approve: command.approve,
			onEvent: printCodingTaskEvent,
			resources: { enabled: true, allowProjectHooks: command.allowProjectHooks },
			...(command.provider ? { provider: command.provider } : {}),
			...(command.model ? { model: command.model } : {}),
		});
	}
}

async function execute(command: ThreeXhaustCommand): Promise<void> {
	if (command.kind === "help") return printHelp();
	if (command.kind === "version") return console.log(PRODUCT_VERSION);
	const project = canonicalProject(command.kind === "run" ? command.project : undefined);
	if (command.kind === "models") return printModels();
	if (command.kind === "extension-list") return printExtensions(project);
	if (command.kind === "resource-list") return printResources(project);
	if (command.kind === "accounts-list") {
		console.log(renderConnections(await collectConnections()));
		return;
	}
	if (command.kind === "skill-create") {
		const created = createSkillTemplate({ projectRoot: project, name: command.name, scope: "project" });
		console.log(`Created ${created.path}`);
		return;
	}
	if (command.kind === "mcp-add") {
		const path = addMcpServer({
			projectRoot: project,
			id: command.name,
			command: command.command,
			args: command.args,
			scope: "project",
		});
		console.log(`Added ${command.name} to ${path}`);
		return;
	}
	if (command.kind === "mcp-tools") {
		console.log(JSON.stringify(await listMcpTools({ projectRoot: project, server: command.server }), null, 2));
		return;
	}
	if (command.kind === "mcp-call") {
		const args = command.jsonArgs ? JSON.parse(command.jsonArgs) : {};
		console.log(
			JSON.stringify(
				await callMcpTool({ projectRoot: project, server: command.server, tool: command.tool, arguments: args }),
				null,
				2,
			),
		);
		return;
	}
	if (command.kind === "npm-login") {
		await runNpmLogin({ account: command.account, asidePath: asidePath(), cwd: project });
		return;
	}
	if (command.kind === "npm-publish") {
		await runNpmPublish({ account: command.account, asidePath: asidePath(), cwd: project, confirm: confirmPublish });
		return;
	}
	if (command.kind === "benchmark") {
		if (command.real) {
			return runRealBenchmark({
				projectRoot: canonicalProject(command.project),
				repetitions: command.repetitions,
				...(command.provider ? { provider: command.provider } : {}),
				...(command.model ? { model: command.model } : {}),
			});
		}
		return runBenchmark(command.repetitions);
	}
	if (command.kind === "doctor") return doctor(project);
	if (command.kind === "update") return runSelfUpdate(PRODUCT_VERSION);
	if (command.kind === "auth-login") {
		return loginProvider(command.provider);
	}
	return run(command, project);
}

try {
	await execute(parseCliArgs(process.argv.slice(2)));
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	const prefix = error instanceof CliArgumentError ? "Usage error" : PRODUCT_DISPLAY_NAME;
	console.error(`${RED}${prefix}: ${message}${RESET}`);
	process.exitCode = 2;
}
