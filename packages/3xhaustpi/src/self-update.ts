import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_DISPLAY_NAME } from "./product-identity.ts";

const REGISTRY_ORIGIN = "https://registry.npmjs.org";
const PACKAGE_NAME = "3xhaustpi";

interface RegistrySignature {
	readonly keyid: string;
	readonly sig: string;
}

interface RegistryMetadata {
	readonly name: string;
	readonly version: string;
	readonly dist: {
		readonly integrity: string;
		readonly tarball: string;
		readonly signatures?: readonly RegistrySignature[];
	};
}

interface RegistryKey {
	readonly keyid: string;
	readonly keytype: string;
	readonly scheme: string;
	readonly key: string;
	readonly expires: string | null;
}

export interface SelfUpdateDependencies {
	readonly fetchJson: <T>(url: string) => Promise<T>;
	readonly fetchBytes: (url: string) => Promise<Uint8Array>;
	readonly spawn: (command: string, args: readonly string[], options?: { cwd?: string }) => string;
	readonly packageRoot: () => string;
	readonly executablePath: () => string;
	readonly log: (message: string) => void;
}

function checkedSpawn(command: string, args: readonly string[], options: { cwd?: string } = {}): string {
	const result = spawnSync(command, [...args], {
		encoding: "utf8",
		timeout: 120_000,
		maxBuffer: 4_194_304,
		...(options.cwd ? { cwd: options.cwd } : {}),
	});
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
	}
	return result.stdout.trim();
}

export function verifyTarballIntegrity(bytes: Uint8Array, integrity: string): boolean {
	const [algorithm, expected] = integrity.split("-", 2);
	if (!algorithm || !expected || !["sha256", "sha384", "sha512"].includes(algorithm)) return false;
	const actual = createHash(algorithm).update(bytes).digest("base64");
	return actual === expected;
}

export function verifyRegistrySignature(
	metadata: Pick<RegistryMetadata, "name" | "version" | "dist">,
	keys: readonly RegistryKey[],
): boolean {
	const message = Buffer.from(`${metadata.name}@${metadata.version}:${metadata.dist.integrity}`, "utf8");
	return Boolean(
		metadata.dist.signatures?.some((signature) => {
			const key = keys.find(
				(candidate) =>
					candidate.keyid === signature.keyid &&
					candidate.keytype === "ecdsa-sha2-nistp256" &&
					candidate.scheme === "ecdsa-sha2-nistp256" &&
					(!candidate.expires || Date.parse(candidate.expires) > Date.now()),
			);
			if (!key) return false;
			try {
				const publicKey = createPublicKey({
					key: Buffer.from(key.key, "base64"),
					format: "der",
					type: "spki",
				});
				return verify("sha256", message, publicKey, Buffer.from(signature.sig, "base64"));
			} catch {
				return false;
			}
		}),
	);
}

async function fetchJson<T>(url: string): Promise<T> {
	const response = await fetch(url, {
		headers: { accept: "application/json", "user-agent": "3xhaustpi-self-update" },
		signal: AbortSignal.timeout(20_000),
	});
	if (!response.ok) throw new Error(`Update metadata request failed with HTTP ${response.status}`);
	return (await response.json()) as T;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
	const response = await fetch(url, {
		headers: { accept: "application/octet-stream", "user-agent": "3xhaustpi-self-update" },
		signal: AbortSignal.timeout(60_000),
	});
	if (!response.ok) throw new Error(`Update tarball request failed with HTTP ${response.status}`);
	return new Uint8Array(await response.arrayBuffer());
}

function executablePath(): string {
	const prefix = checkedSpawn("npm", ["prefix", "-g"]);
	return process.platform === "win32" ? join(prefix, "3xhaustpi.cmd") : join(prefix, "bin", "3xhaustpi");
}

function packageRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function packCurrentInstall(destination: string, dependencies: SelfUpdateDependencies): string {
	mkdirSync(destination, { recursive: true, mode: 0o700 });
	dependencies.spawn("npm", ["pack", dependencies.packageRoot(), "--pack-destination", destination]);
	const archive = readdirSync(destination).find((entry) => entry.endsWith(".tgz"));
	if (!archive) throw new Error("Current installation could not be packed for rollback");
	return join(destination, archive);
}

function defaultDependencies(): SelfUpdateDependencies {
	return {
		fetchJson,
		fetchBytes,
		spawn: checkedSpawn,
		packageRoot,
		executablePath,
		log: console.log,
	};
}

export async function runSelfUpdate(
	currentVersion: string,
	dependencies: SelfUpdateDependencies = defaultDependencies(),
): Promise<void> {
	const temporary = mkdtempSync(join(tmpdir(), "3xhaustpi-update-"));
	let rollbackArchive: string | undefined;
	try {
		const metadata = await dependencies.fetchJson<RegistryMetadata>(`${REGISTRY_ORIGIN}/${PACKAGE_NAME}/latest`);
		if (metadata.name !== PACKAGE_NAME || !metadata.version || !metadata.dist?.integrity || !metadata.dist.tarball) {
			throw new Error("Registry update metadata is invalid");
		}
		if (metadata.version === currentVersion) {
			dependencies.log(`${PRODUCT_DISPLAY_NAME} ${currentVersion} is already current.`);
			return;
		}
		const keyResponse = await dependencies.fetchJson<{ readonly keys?: readonly RegistryKey[] }>(
			`${REGISTRY_ORIGIN}/-/npm/v1/keys`,
		);
		if (!keyResponse.keys || !verifyRegistrySignature(metadata, keyResponse.keys)) {
			throw new Error("Registry ECDSA signature verification failed");
		}
		const tarball = await dependencies.fetchBytes(metadata.dist.tarball);
		if (!verifyTarballIntegrity(tarball, metadata.dist.integrity)) {
			throw new Error("Registry tarball checksum verification failed");
		}
		const updateArchive = join(
			temporary,
			basename(new URL(metadata.dist.tarball).pathname) || "3xhaustpi-update.tgz",
		);
		writeFileSync(updateArchive, tarball, { mode: 0o600 });
		rollbackArchive = packCurrentInstall(join(temporary, "rollback"), dependencies);
		dependencies.spawn("npm", ["install", "-g", updateArchive]);
		const reported = dependencies.spawn(dependencies.executablePath(), ["--version"]);
		if (reported !== metadata.version) {
			throw new Error(`Updated executable reported ${reported || "no version"} instead of ${metadata.version}`);
		}
		dependencies.log(
			`Updated ${PRODUCT_DISPLAY_NAME} ${currentVersion} → ${metadata.version}; checksum and registry signature verified.`,
		);
	} catch (error) {
		if (rollbackArchive) {
			try {
				dependencies.spawn("npm", ["install", "-g", rollbackArchive]);
				const restored = dependencies.spawn(dependencies.executablePath(), ["--version"]);
				if (restored !== currentVersion) throw new Error(`rollback reported ${restored}`);
			} catch (rollbackError) {
				throw new Error(
					`Update failed and rollback failed: ${error instanceof Error ? error.message : String(error)}; ${
						rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
					}`,
				);
			}
		}
		throw error;
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}
