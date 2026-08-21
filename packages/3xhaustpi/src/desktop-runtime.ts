import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type DesktopAccessibilityRole = "button" | "link" | "field" | "menu-item" | "window";

export interface DesktopApplication {
	readonly pid: number;
	readonly name: string;
	readonly bundleId: string;
	readonly active: boolean;
}

export interface DesktopApplicationTarget {
	readonly pid: number;
}

export interface DesktopAccessibilityElement {
	readonly role: DesktopAccessibilityRole;
	readonly name: string;
}

export interface DesktopAccessibilityObservation {
	readonly application: {
		readonly pid: number;
		readonly name: string;
		readonly frontmost: boolean;
	};
	readonly digest: string;
	readonly capturedAt: string;
	readonly durationMs: number;
	readonly elements: readonly DesktopAccessibilityElement[];
}

export type DesktopComputerAction =
	| {
			readonly action: "click";
			readonly target: DesktopAccessibilityElement & { readonly observationDigest: string };
			readonly coordinates?: { readonly x: number; readonly y: number };
			readonly button: "left" | "right" | "middle";
			readonly approvalDigest?: string;
	  }
	| {
			readonly action: "type";
			readonly target: DesktopAccessibilityElement & { readonly observationDigest: string };
			readonly text: string;
			readonly approvalDigest?: string;
	  }
	| {
			readonly action: "key";
			readonly target: DesktopAccessibilityElement & { readonly observationDigest: string };
			readonly key: "Enter" | "Escape" | "Tab" | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";
			readonly approvalDigest?: string;
	  }
	| {
			readonly action: "scroll";
			readonly target: DesktopAccessibilityElement & { readonly observationDigest: string };
			readonly deltaY: number;
			readonly approvalDigest?: string;
	  };

export interface DesktopActionResult {
	readonly method: "accessibility" | "coordinates";
	readonly digest: string;
	readonly completedAt: string;
	readonly durationMs: number;
}

interface InternalElement extends DesktopAccessibilityElement {
	readonly path: readonly number[];
}

interface InternalObservation {
	readonly application: DesktopAccessibilityObservation["application"];
	readonly trusted: boolean;
	readonly elements: readonly InternalElement[];
}

export type DesktopAccessibilityPlatform = "darwin" | "win32" | "linux";

export interface DesktopHelperRuntime {
	readonly platform: DesktopAccessibilityPlatform;
	readonly command: string;
	readonly args: readonly string[];
	readonly helper: string;
	readonly env?: Readonly<Record<string, string>>;
}

const runtimeRoot = dirname(fileURLToPath(import.meta.url));
const helperPaths = {
	darwin: join(runtimeRoot, "macos", "ax_host.jxa"),
	win32: join(runtimeRoot, "windows", "uia_host.ps1"),
	linux: join(runtimeRoot, "linux", "atspi_host.py"),
} as const;
const osascriptPath = "/usr/bin/osascript";
const linuxPythonPath = "/usr/bin/python3";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const observationDigest = (observation: InternalObservation): string =>
	digest({
		application: observation.application.pid,
		elements: observation.elements
			.map(({ role: elementRole, name }) => ({ role: elementRole, name }))
			.sort((left, right) => left.role.localeCompare(right.role) || left.name.localeCompare(right.name)),
	});

function assertObject(value: unknown, name: string): asserts value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${name} must be an object`);
}

function text(value: unknown, name: string, maximum = 512): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum) {
		throw new Error(`${name} must be a bounded non-empty string`);
	}
	return value.trim();
}

function integer(value: unknown, name: string, minimum = 0): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${name} must be a safe integer`);
	return value as number;
}

function role(value: unknown): DesktopAccessibilityRole {
	if (value === "button" || value === "link" || value === "field" || value === "menu-item" || value === "window") {
		return value;
	}
	throw new Error("desktop accessibility role is invalid");
}

function parseApplications(
	value: unknown,
	expectedPlatform: DesktopAccessibilityPlatform,
): {
	readonly platform: DesktopAccessibilityPlatform;
	readonly trusted: boolean;
	readonly applications: readonly DesktopApplication[];
} {
	assertObject(value, "desktop application response");
	if (
		value.platform !== expectedPlatform ||
		typeof value.trusted !== "boolean" ||
		!Array.isArray(value.applications)
	) {
		throw new Error("desktop application response is invalid");
	}
	const applications = value.applications.map((entry) => {
		assertObject(entry, "desktop application");
		if (typeof entry.active !== "boolean") throw new Error("desktop application active state is invalid");
		return {
			pid: integer(entry.pid, "desktop application pid", 1),
			name: text(entry.name, "desktop application name"),
			bundleId: text(entry.bundleId, "desktop application bundle id"),
			active: entry.active,
		};
	});
	return { platform: expectedPlatform, trusted: value.trusted, applications };
}

function parseObservation(value: unknown): InternalObservation {
	assertObject(value, "desktop observation");
	assertObject(value.application, "desktop observation application");
	if (value.trusted !== true || !Array.isArray(value.elements)) throw new Error("desktop observation is invalid");
	const elements = value.elements.map((entry) => {
		assertObject(entry, "desktop accessibility element");
		if (!Array.isArray(entry.path) || entry.path.length < 1 || entry.path.length > 17) {
			throw new Error("desktop accessibility path is invalid");
		}
		const path = entry.path.map((index) => integer(index, "desktop accessibility path index", -2));
		if (path.some((index) => index > 4_096)) throw new Error("desktop accessibility path index is invalid");
		return {
			role: role(entry.role),
			name: text(entry.name, "desktop accessibility name"),
			path,
		};
	});
	return {
		application: {
			pid: integer(value.application.pid, "desktop observation pid", 1),
			name: text(value.application.name, "desktop observation application name"),
			frontmost: Boolean(value.application.frontmost),
		},
		trusted: true,
		elements,
	};
}

function validateTarget(target: DesktopApplicationTarget): DesktopApplicationTarget {
	return { pid: integer(target.pid, "desktop target pid", 1) };
}

function validateAction(action: DesktopComputerAction): DesktopComputerAction {
	assertObject(action, "desktop action");
	assertObject(action.target, "desktop action target");
	const target = {
		role: role(action.target.role),
		name: text(action.target.name, "desktop target name"),
		observationDigest: text(action.target.observationDigest, "desktop observation digest", 64),
	};
	if (!/^[a-f0-9]{64}$/iu.test(target.observationDigest)) throw new Error("desktop observation digest is invalid");
	if (action.action === "click") {
		if (action.button !== "left" && action.button !== "right" && action.button !== "middle") {
			throw new Error("desktop click button is invalid");
		}
		const coordinates = action.coordinates
			? {
					x: integer(action.coordinates.x, "desktop click x"),
					y: integer(action.coordinates.y, "desktop click y"),
				}
			: undefined;
		return {
			action: "click",
			target,
			button: action.button,
			...(coordinates ? { coordinates } : {}),
			...(action.approvalDigest ? { approvalDigest: text(action.approvalDigest, "approval digest", 64) } : {}),
		};
	}
	if (action.action === "type") {
		return {
			action: "type",
			target,
			text: text(action.text, "desktop input text", 16_384),
			...(action.approvalDigest ? { approvalDigest: text(action.approvalDigest, "approval digest", 64) } : {}),
		};
	}
	if (action.action === "key") {
		if (!["Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(action.key)) {
			throw new Error("desktop key is invalid");
		}
		return {
			action: "key",
			target,
			key: action.key,
			...(action.approvalDigest ? { approvalDigest: text(action.approvalDigest, "approval digest", 64) } : {}),
		};
	}
	if (!Number.isInteger(action.deltaY) || Math.abs(action.deltaY) > 10_000) {
		throw new Error("desktop scroll delta is invalid");
	}
	return {
		action: "scroll",
		target,
		deltaY: action.deltaY,
		...(action.approvalDigest ? { approvalDigest: text(action.approvalDigest, "approval digest", 64) } : {}),
	};
}

function windowsPowerShellPath(): string {
	const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
	return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function resolveDesktopHelper(platform: NodeJS.Platform = process.platform): DesktopHelperRuntime | undefined {
	if (platform === "darwin" && existsSync(osascriptPath) && existsSync(helperPaths.darwin)) {
		return {
			platform,
			command: osascriptPath,
			args: ["-l", "JavaScript", helperPaths.darwin],
			helper: "macOS System Events accessibility",
			env: { PATH: "/usr/bin:/bin" },
		};
	}
	if (platform === "win32") {
		const command = windowsPowerShellPath();
		if (existsSync(command) && existsSync(helperPaths.win32)) {
			return {
				platform,
				command,
				args: [
					"-NoLogo",
					"-NoProfile",
					"-NonInteractive",
					"-ExecutionPolicy",
					"Bypass",
					"-File",
					helperPaths.win32,
				],
				helper: "Windows UI Automation",
				env: { SystemRoot: process.env.SystemRoot || process.env.WINDIR || "C:\\Windows" },
			};
		}
	}
	if (platform === "linux" && existsSync(linuxPythonPath) && existsSync(helperPaths.linux)) {
		return {
			platform,
			command: linuxPythonPath,
			args: ["-I", helperPaths.linux],
			helper: "Linux AT-SPI accessibility",
			env: {
				PATH: "/usr/bin:/bin",
				...(process.env.DBUS_SESSION_BUS_ADDRESS
					? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS }
					: {}),
				...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
				...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
				...(process.env.WAYLAND_DISPLAY ? { WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY } : {}),
			},
		};
	}
	return undefined;
}

export function desktopComputerUseStatus(): {
	readonly platform: NodeJS.Platform;
	readonly available: boolean;
	readonly helper: string;
} {
	const runtime = resolveDesktopHelper();
	return {
		platform: process.platform,
		available: runtime !== undefined,
		helper: runtime?.helper ?? "unavailable",
	};
}

export class DesktopAccessibilityHost {
	readonly #timeoutMs: number;
	readonly #runtime: DesktopHelperRuntime | undefined;

	constructor(options: { readonly timeoutMs?: number; readonly helperRuntime?: DesktopHelperRuntime } = {}) {
		this.#timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 10_000, 30_000));
		this.#runtime = options.helperRuntime ?? resolveDesktopHelper();
	}

	async listApplications(signal?: AbortSignal): Promise<{
		readonly platform: DesktopAccessibilityPlatform;
		readonly trusted: boolean;
		readonly applications: readonly DesktopApplication[];
	}> {
		if (!this.#runtime) throw new Error(`Desktop Computer Use is unavailable on ${process.platform}.`);
		return parseApplications(await this.#request({ operation: "list" }, signal), this.#runtime.platform);
	}

	async observe(
		targetInput: DesktopApplicationTarget,
		options: { readonly signal?: AbortSignal; readonly maxElements?: number } = {},
	): Promise<DesktopAccessibilityObservation> {
		const target = validateTarget(targetInput);
		const started = performance.now();
		const internal = parseObservation(
			await this.#request(
				{
					operation: "observe",
					target,
					maxElements: Math.max(1, Math.min(options.maxElements ?? 512, 512)),
				},
				options.signal,
			),
		);
		const currentDigest = observationDigest(internal);
		return {
			application: internal.application,
			digest: currentDigest,
			capturedAt: new Date().toISOString(),
			durationMs: performance.now() - started,
			elements: internal.elements.map(({ role: elementRole, name }) => ({ role: elementRole, name })),
		};
	}

	async act(
		targetInput: DesktopApplicationTarget,
		actionInput: DesktopComputerAction,
		options: { readonly signal?: AbortSignal; readonly approvedCoordinateDigest?: string } = {},
	): Promise<DesktopActionResult> {
		const target = validateTarget(targetInput);
		const action = validateAction(actionInput);
		const started = performance.now();
		const internal = parseObservation(
			await this.#request({ operation: "observe", target, maxElements: 512 }, options.signal),
		);
		const currentDigest = observationDigest(internal);
		if (currentDigest !== action.target.observationDigest) {
			throw new Error("Desktop Computer Use observation is stale; observe accessibility again.");
		}
		const matches = internal.elements.filter(
			(element) => element.role === action.target.role && element.name === action.target.name,
		);
		let path: readonly number[] | undefined;
		let coordinateFallback = false;
		if (matches.length > 1) throw new Error("Desktop Computer Use semantic target is ambiguous.");
		if (matches.length === 1) {
			path = matches[0]?.path;
		} else if (action.action === "click" && action.coordinates) {
			const expectedApproval = digest({
				scope: "desktop-coordinate-fallback",
				pid: target.pid,
				observationDigest: currentDigest,
				coordinates: action.coordinates,
				button: action.button,
			});
			if (!options.approvedCoordinateDigest || options.approvedCoordinateDigest !== expectedApproval) {
				throw new Error("Desktop coordinate fallback requires a matching host-issued approval.");
			}
			coordinateFallback = true;
		} else {
			throw new Error("Desktop Computer Use semantic target is unavailable.");
		}
		const result = await this.#request(
			{
				operation: "perform",
				target,
				action,
				...(path ? { path } : {}),
				expected: action.target,
				coordinateFallback,
			},
			options.signal,
		);
		assertObject(result, "desktop action result");
		if (result.method !== "accessibility" && result.method !== "coordinates") {
			throw new Error("desktop action result method is invalid");
		}
		return {
			method: result.method,
			digest: digest({ target, observationDigest: currentDigest, action, method: result.method }),
			completedAt: new Date().toISOString(),
			durationMs: performance.now() - started,
		};
	}

	async #request(request: unknown, signal?: AbortSignal): Promise<unknown> {
		const runtime = this.#runtime;
		if (!runtime) throw new Error(`Desktop Computer Use is unavailable on ${process.platform}.`);
		return await new Promise((resolveRequest, rejectRequest) => {
			const child = spawn(runtime.command, [...runtime.args], {
				stdio: ["pipe", "pipe", "pipe"],
				env: runtime.env,
			});
			let stdout = "";
			let stderr = "";
			let settled = false;
			const finish = (error?: Error, value?: unknown) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				signal?.removeEventListener("abort", abort);
				if (error) rejectRequest(error);
				else resolveRequest(value);
			};
			const abort = () => {
				child.kill("SIGKILL");
				finish(new Error("Desktop Computer Use was cancelled."));
			};
			const timeout = setTimeout(() => {
				child.kill("SIGKILL");
				finish(new Error("Desktop Computer Use timed out."));
			}, this.#timeoutMs);
			signal?.addEventListener("abort", abort, { once: true });
			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				stdout += chunk;
				if (stdout.length > 1_048_576) abort();
			});
			child.stderr.on("data", (chunk: string) => {
				stderr += chunk;
				if (stderr.length > 65_536) abort();
			});
			child.once("error", (error) => finish(error));
			child.once("close", (code) => {
				if (code !== 0) {
					finish(new Error((stderr || `${runtime.helper} exited with ${code}`).trim().slice(-2_048)));
					return;
				}
				try {
					finish(undefined, JSON.parse(stdout.trim()));
				} catch {
					finish(new Error("Desktop Computer Use returned invalid JSON."));
				}
			});
			child.stdin.end(JSON.stringify(request));
			if (signal?.aborted) abort();
		});
	}
}
