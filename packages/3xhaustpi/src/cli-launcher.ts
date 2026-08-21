import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliArgumentError, parseCliArgs } from "./args.ts";
import { PRODUCT_DISPLAY_NAME } from "./product-identity.ts";

const RED = "\u001b[38;5;203m";
const RESET = "\u001b[0m";
const directory = dirname(fileURLToPath(import.meta.url));
const fullCliPath = join(directory, "cli-full.js");
const tuiCliPath = join(directory, "cli-tui.js");

function environment(overrides: Readonly<Record<string, string>> = {}): Record<string, string> {
	return {
		...Object.fromEntries(
			Object.entries(process.env).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])),
		),
		...overrides,
	};
}

function handoff(scriptPath: string, env: Readonly<Record<string, string>>): void {
	const args = [process.execPath, scriptPath, ...process.argv.slice(2)];
	const execve = (
		process as NodeJS.Process & {
			readonly execve?: (file: string, args: readonly string[], env: Readonly<Record<string, string>>) => never;
		}
	).execve;
	if (process.platform !== "win32" && execve) execve(process.execPath, args, env);
	const result = spawnSync(process.execPath, args.slice(1), { env, stdio: "inherit" });
	if (result.error) throw result.error;
	process.exitCode = result.status ?? 1;
}

try {
	const command = parseCliArgs(process.argv.slice(2));
	const interactive =
		command.kind === "run" && !command.prompt && !command.resume && process.stdin.isTTY && process.stdout.isTTY;
	handoff(
		interactive ? tuiCliPath : fullCliPath,
		interactive ? environment({ NODE_NO_WARNINGS: "1" }) : environment(),
	);
} catch (cause) {
	const message = cause instanceof Error ? cause.message : String(cause);
	const prefix = cause instanceof CliArgumentError ? "Usage error" : PRODUCT_DISPLAY_NAME;
	console.error(`${RED}${prefix}: ${message}${RESET}`);
	process.exitCode = 2;
}
