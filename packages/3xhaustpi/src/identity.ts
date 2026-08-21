import { chmodSync, constants, copyFileSync, cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const ACTIVE_DATA_DIRECTORY = ".3xhaustpi";
export const ACTIVE_KEYCHAIN_SERVICE = "io.3xhaustpi.cli.credentials.v1";

// Read-only migration inputs retained for users upgrading from the shipped predecessor identity.
export const LEGACY_DATA_DIRECTORY = ".tenuispi";
export const LEGACY_KEYCHAIN_SERVICE = "io.tenuispi.cli.credentials.v1";

export function migrateLegacyDataFile(activePath: string, legacyPath: string): string {
	if (existsSync(activePath) || !existsSync(legacyPath)) return activePath;
	mkdirSync(dirname(activePath), { recursive: true, mode: 0o700 });
	try {
		copyFileSync(legacyPath, activePath, constants.COPYFILE_EXCL);
		chmodSync(activePath, 0o600);
	} catch (error) {
		const code =
			typeof error === "object" && error !== null && "code" in error
				? String((error as { readonly code?: unknown }).code)
				: "";
		if (code !== "EEXIST") throw error;
	}
	return activePath;
}

export function migrateLegacyDataDirectory(activePath: string, legacyPath: string): string {
	if (existsSync(activePath) || !existsSync(legacyPath)) return activePath;
	mkdirSync(dirname(activePath), { recursive: true, mode: 0o700 });
	try {
		cpSync(legacyPath, activePath, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
		chmodSync(activePath, 0o700);
	} catch (error) {
		const code =
			typeof error === "object" && error !== null && "code" in error
				? String((error as { readonly code?: unknown }).code)
				: "";
		if (code !== "EEXIST") throw error;
	}
	return activePath;
}

export function resolveUserDataDirectory(home = homedir()): string {
	return migrateLegacyDataDirectory(join(home, ACTIVE_DATA_DIRECTORY), join(home, LEGACY_DATA_DIRECTORY));
}

export function resolveProjectDataDirectory(projectRoot: string): string {
	return migrateLegacyDataDirectory(
		join(projectRoot, ACTIVE_DATA_DIRECTORY),
		join(projectRoot, LEGACY_DATA_DIRECTORY),
	);
}

export function resolveStatePath(
	environment: Readonly<Record<string, string | undefined>> = process.env,
	home = homedir(),
): string {
	if (environment.X3HAUSTPI_STATE_PATH) return environment.X3HAUSTPI_STATE_PATH;
	const active = join(resolveUserDataDirectory(home), "state.sqlite");
	const legacy = join(home, LEGACY_DATA_DIRECTORY, "state.sqlite");
	for (const suffix of ["", "-wal", "-shm"] as const)
		migrateLegacyDataFile(`${active}${suffix}`, `${legacy}${suffix}`);
	return active;
}

export function resolveAuthPath(
	environment: Readonly<Record<string, string | undefined>> = process.env,
	home = homedir(),
): string {
	if (environment.X3HAUSTPI_AUTH_PATH) return environment.X3HAUSTPI_AUTH_PATH;
	return migrateLegacyDataFile(
		join(resolveUserDataDirectory(home), "auth.json"),
		join(home, LEGACY_DATA_DIRECTORY, "auth.json"),
	);
}
