import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface CommandProcess {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number | null;
	write(value: string): void;
	wait(): Promise<number>;
}

export type SpawnCommand = (
	command: string,
	args: readonly string[],
	options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv },
) => CommandProcess;

export interface AsideAccount {
	readonly id: string;
	readonly label: string;
	readonly provider?: string;
	readonly signedIn: boolean;
	readonly selected: boolean;
}

export interface PublishReview {
	readonly command: "npm publish";
	readonly account: string;
	readonly registry: string;
	readonly packageName: string;
	readonly version: string;
	readonly cwd: string;
}

function spawnCommand(
	command: string,
	args: readonly string[],
	options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv },
): CommandProcess {
	const child = nodeSpawn(command, [...args], {
		cwd: options.cwd,
		env: options.env,
		shell: false,
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	let exitCode: number | null = null;
	child.stdout.on("data", (chunk: Buffer) => {
		const text = chunk.toString("utf8");
		stdout += text;
		process.stdout.write(text);
	});
	child.stderr.on("data", (chunk: Buffer) => {
		const text = chunk.toString("utf8");
		stderr += text;
		process.stderr.write(text);
	});
	const wait = new Promise<number>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => {
			exitCode = code ?? 1;
			resolve(exitCode);
		});
	});
	return {
		get stdout() {
			return stdout;
		},
		get stderr() {
			return stderr;
		},
		get exitCode() {
			return exitCode;
		},
		write: (value) => child.stdin.write(value),
		wait: () => wait,
	};
}

export function parseAsideAccounts(output: string): readonly AsideAccount[] {
	const accounts: AsideAccount[] = [];
	for (const line of output.split(/\r?\n/u)) {
		const match = /^(\*|\s)\s+(u\d+)\s+(.+?)\s{2}(signed in|signed out)\s{2}profiles:/u.exec(line);
		if (match) {
			accounts.push({
				id: match[2]!,
				label: match[3]!.trim(),
				signedIn: match[4] === "signed in",
				selected: match[1] === "*",
			});
			continue;
		}
		const provider = /^\s+provider:\s+(.+)$/u.exec(line)?.[1];
		if (provider && accounts.length > 0) {
			const account = accounts.at(-1)!;
			accounts[accounts.length - 1] = { ...account, provider: provider.trim() };
		}
	}
	return accounts;
}

async function selectAsideAccount(input: {
	readonly account?: string;
	readonly asidePath: string;
	readonly cwd?: string;
	readonly spawn: SpawnCommand;
}): Promise<void> {
	if (!input.account) return;
	const selection = input.spawn(input.asidePath, ["account", "use", input.account], { cwd: input.cwd });
	const exitCode = await selection.wait();
	if (exitCode !== 0) throw new Error(selection.stderr.trim() || `Aside account selection exited with ${exitCode}`);
}

export async function runNpmLogin(input: {
	readonly account?: string;
	readonly asidePath: string;
	readonly cwd?: string;
	readonly userConfig?: string;
	readonly spawn?: SpawnCommand;
}): Promise<{ readonly account?: string }> {
	const spawn = input.spawn ?? spawnCommand;
	await selectAsideAccount({
		...(input.account ? { account: input.account } : {}),
		asidePath: input.asidePath,
		...(input.cwd ? { cwd: input.cwd } : {}),
		spawn,
	});
	const process = spawn("npm", ["login"], {
		cwd: input.cwd,
		env: {
			...globalThis.process.env,
			BROWSER: input.asidePath,
			...(input.userConfig ? { NPM_CONFIG_USERCONFIG: input.userConfig } : {}),
		},
	});
	process.write("\n");
	const exitCode = await process.wait();
	if (exitCode !== 0) throw new Error(process.stderr.trim() || `npm login exited with ${exitCode}`);
	return { ...(input.account ? { account: input.account } : {}) };
}

function packageIdentity(cwd: string): { readonly packageName: string; readonly version: string } {
	const path = join(cwd, "package.json");
	if (!existsSync(path)) return { packageName: "(no package.json)", version: "unknown" };
	const parsed = JSON.parse(readFileSync(path, "utf8")) as { readonly name?: unknown; readonly version?: unknown };
	return {
		packageName: typeof parsed.name === "string" ? parsed.name : "(unnamed)",
		version: typeof parsed.version === "string" ? parsed.version : "unknown",
	};
}

export async function runNpmPublish(input: {
	readonly account?: string;
	readonly asidePath?: string;
	readonly cwd?: string;
	readonly userConfig?: string;
	readonly registry?: string;
	readonly spawn?: SpawnCommand;
	readonly confirm: (review: PublishReview) => Promise<boolean>;
}): Promise<{ readonly account: string }> {
	const spawn = input.spawn ?? spawnCommand;
	const cwd = input.cwd ?? globalThis.process.cwd();
	const asidePath = input.asidePath ?? "aside";
	await selectAsideAccount({
		...(input.account ? { account: input.account } : {}),
		asidePath,
		cwd,
		spawn,
	});
	const environment = {
		...globalThis.process.env,
		BROWSER: asidePath,
		...(input.userConfig ? { NPM_CONFIG_USERCONFIG: input.userConfig } : {}),
	};
	const whoami = spawn("npm", ["whoami"], { cwd, env: environment });
	const whoamiExit = await whoami.wait();
	if (whoamiExit !== 0) throw new Error("npm account is not authenticated; run 3xhaustpi npm login first");
	const account = whoami.stdout.trim();
	if (!account) throw new Error("npm whoami returned an empty account");
	const identity = packageIdentity(cwd);
	const review: PublishReview = {
		command: "npm publish",
		account,
		registry: input.registry ?? "https://registry.npmjs.org/",
		packageName: identity.packageName,
		version: identity.version,
		cwd,
	};
	if (!(await input.confirm(review))) throw new Error("npm publish cancelled");
	const publish = spawn("npm", ["publish"], { cwd, env: environment });
	const exitCode = await publish.wait();
	if (exitCode !== 0) throw new Error(publish.stderr.trim() || `npm publish exited with ${exitCode}`);
	return { account };
}
