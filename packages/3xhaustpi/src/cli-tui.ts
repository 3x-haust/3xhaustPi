import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { CliArgumentError, parseCliArgs } from "./args.ts";
import { PRODUCT_DISPLAY_NAME } from "./product-identity.ts";
import { AUTH_PATH } from "./provider-runtime.ts";
import { runTui } from "./tui.ts";
import { createTuiRunRequest, runTuiRuntime } from "./tui-runtime-client.ts";

const RED = "\u001b[38;5;203m";
const RESET = "\u001b[0m";

function canonicalProject(input: string | undefined): string {
	const target = resolve(input ?? process.cwd());
	if (!existsSync(target)) throw new Error(`Project directory does not exist: ${target}`);
	if (!statSync(target).isDirectory()) throw new Error(`Project path is not a directory: ${target}`);
	return realpathSync(target);
}

function providerConfigured(provider: string): boolean {
	if (!existsSync(AUTH_PATH)) return false;
	try {
		const parsed = JSON.parse(readFileSync(AUTH_PATH, "utf8")) as unknown;
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && provider in parsed;
	} catch {
		return false;
	}
}

try {
	const command = parseCliArgs(process.argv.slice(2));
	if (command.kind !== "run" || command.prompt || command.resume) {
		throw new Error("cli-tui only supports a fresh interactive TUI run");
	}
	const projectRoot = canonicalProject(command.project);
	const provider = command.provider ?? "openai-codex";
	const model = command.model ?? "gpt-5.6-terra";
	await runTui({
		projectRoot,
		provider,
		model,
		providerConfigured: providerConfigured(provider),
		runTask: (activeProjectRoot, objective, hooks, selectedModel) =>
			runTuiRuntime(
				createTuiRunRequest({
					projectRoot: activeProjectRoot,
					objective,
					selectedModel,
					...(selectedModel.sessionId ? { sessionId: selectedModel.sessionId } : {}),
					...(command.allowProjectHooks ? { allowProjectHooks: true } : {}),
				}),
				hooks,
			),
		resumeTask: (activeProjectRoot, sessionId, hooks) =>
			runTuiRuntime(
				{
					mode: "resume",
					projectRoot: activeProjectRoot,
					...(sessionId ? { sessionId } : {}),
					...(command.allowProjectHooks ? { allowProjectHooks: true } : {}),
				},
				hooks,
			),
	});
} catch (cause) {
	const message = cause instanceof Error ? cause.message : String(cause);
	const prefix = cause instanceof CliArgumentError ? "Usage error" : PRODUCT_DISPLAY_NAME;
	console.error(`${RED}${prefix}: ${message}${RESET}`);
	process.exitCode = 2;
}
