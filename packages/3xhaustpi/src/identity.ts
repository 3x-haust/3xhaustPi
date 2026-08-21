import { randomUUID } from "node:crypto";
import {
	chmodSync,
	constants,
	copyFileSync,
	cpSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export const ACTIVE_DATA_DIRECTORY = ".3xhaust";
export const ACTIVE_KEYCHAIN_SERVICE = "io.3xhaustpi.cli.credentials.v1";

// Read-only migration inputs retained for users upgrading from the shipped predecessor identity.
export const LEGACY_DATA_DIRECTORIES = [".3xhaustpi", ".tenuispi"] as const;
export const LEGACY_KEYCHAIN_SERVICE = "io.tenuispi.cli.credentials.v1";

export class UnsafeDataPathError extends Error {
	constructor(path: string, reason: string) {
		super(`Unsafe data path ${path}: ${reason}`);
		this.name = "UnsafeDataPathError";
	}
}

function errorCode(error: unknown): string {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { readonly code?: unknown }).code)
		: "";
}

function assertSafeRegularFile(path: string): void {
	const info = lstatSync(path);
	if (info.isSymbolicLink()) throw new UnsafeDataPathError(path, "symlink is not allowed");
	if (!info.isFile()) throw new UnsafeDataPathError(path, "regular file required");
}

function assertSafeDirectoryTree(path: string): void {
	const info = lstatSync(path);
	if (info.isSymbolicLink()) throw new UnsafeDataPathError(path, "symlink is not allowed");
	if (!info.isDirectory()) throw new UnsafeDataPathError(path, "directory required");
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		const child = join(path, entry.name);
		if (entry.isSymbolicLink()) throw new UnsafeDataPathError(child, "symlink is not allowed");
		if (entry.isDirectory()) {
			assertSafeDirectoryTree(child);
			continue;
		}
		if (!entry.isFile()) throw new UnsafeDataPathError(child, "regular file required");
	}
}

function temporaryMigrationPath(activePath: string): string {
	return join(dirname(activePath), `.${basename(activePath)}.migrate-${process.pid}-${randomUUID()}`);
}

export function migrateLegacyDataFile(activePath: string, legacyPath: string): string {
	if (existsSync(activePath)) {
		assertSafeRegularFile(activePath);
		chmodSync(activePath, 0o600);
		return activePath;
	}
	if (!existsSync(legacyPath)) return activePath;
	assertSafeRegularFile(legacyPath);
	mkdirSync(dirname(activePath), { recursive: true, mode: 0o700 });
	const temporaryPath = temporaryMigrationPath(activePath);
	try {
		copyFileSync(legacyPath, temporaryPath, constants.COPYFILE_EXCL);
		chmodSync(temporaryPath, 0o600);
		linkSync(temporaryPath, activePath);
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw error;
		assertSafeRegularFile(activePath);
		chmodSync(activePath, 0o600);
	} finally {
		rmSync(temporaryPath, { force: true });
	}
	return activePath;
}

export function migrateLegacyDataDirectory(activePath: string, legacyPath: string): string {
	if (existsSync(activePath)) {
		assertSafeDirectoryTree(activePath);
		return activePath;
	}
	if (!existsSync(legacyPath)) return activePath;
	assertSafeDirectoryTree(legacyPath);
	mkdirSync(dirname(activePath), { recursive: true, mode: 0o700 });
	const temporaryPath = temporaryMigrationPath(activePath);
	try {
		cpSync(legacyPath, temporaryPath, {
			recursive: true,
			errorOnExist: true,
			force: false,
			preserveTimestamps: true,
		});
		assertSafeDirectoryTree(temporaryPath);
		chmodSync(temporaryPath, 0o700);
		renameSync(temporaryPath, activePath);
	} catch (error) {
		const code = errorCode(error);
		if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
		assertSafeDirectoryTree(activePath);
	} finally {
		rmSync(temporaryPath, { recursive: true, force: true });
	}
	return activePath;
}

function hardenCredentialMetadata(directory: string): void {
	const path = join(directory, "auth.json");
	if (!existsSync(path)) return;
	assertSafeRegularFile(path);
	chmodSync(path, 0o600);
}

export function resolveUserDataDirectory(home = homedir()): string {
	const active = join(home, ACTIVE_DATA_DIRECTORY);
	for (const legacyDirectory of LEGACY_DATA_DIRECTORIES) {
		migrateLegacyDataDirectory(active, join(home, legacyDirectory));
	}
	if (existsSync(active)) {
		assertSafeDirectoryTree(active);
		hardenCredentialMetadata(active);
	}
	return active;
}

export function resolveProjectDataDirectory(projectRoot: string): string {
	const active = join(projectRoot, ACTIVE_DATA_DIRECTORY);
	for (const legacyDirectory of LEGACY_DATA_DIRECTORIES) {
		migrateLegacyDataDirectory(active, join(projectRoot, legacyDirectory));
	}
	if (existsSync(active)) assertSafeDirectoryTree(active);
	return active;
}

export function resolveStatePath(
	environment: Readonly<Record<string, string | undefined>> = process.env,
	home = homedir(),
): string {
	if (environment.X3HAUSTPI_STATE_PATH) return environment.X3HAUSTPI_STATE_PATH;
	const active = join(resolveUserDataDirectory(home), "state.sqlite");
	for (const legacyDirectory of LEGACY_DATA_DIRECTORIES) {
		const legacy = join(home, legacyDirectory, "state.sqlite");
		for (const suffix of ["", "-wal", "-shm"] as const)
			migrateLegacyDataFile(`${active}${suffix}`, `${legacy}${suffix}`);
	}
	return active;
}

export function resolveAuthPath(
	environment: Readonly<Record<string, string | undefined>> = process.env,
	home = homedir(),
): string {
	if (environment.X3HAUSTPI_AUTH_PATH) return environment.X3HAUSTPI_AUTH_PATH;
	const active = join(resolveUserDataDirectory(home), "auth.json");
	for (const legacyDirectory of LEGACY_DATA_DIRECTORIES) {
		migrateLegacyDataFile(active, join(home, legacyDirectory, "auth.json"));
	}
	return active;
}
