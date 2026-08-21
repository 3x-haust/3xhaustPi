import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SystemCredentialStore } from "../src/credential-store.ts";
import {
	ACTIVE_DATA_DIRECTORY,
	LEGACY_DATA_DIRECTORIES,
	migrateLegacyDataDirectory,
	migrateLegacyDataFile,
	resolveProjectDataDirectory,
	resolveUserDataDirectory,
} from "../src/identity.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const path = mkdtempSync(join(tmpdir(), "3xhaustpi-identity-migration-"));
	temporaryDirectories.push(path);
	return path;
}

afterEach(() => {
	for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("3xhaustpi legacy persistence migration", () => {
	it("uses .3xhaust for active user and project harness data", () => {
		const home = temporaryDirectory();
		const project = temporaryDirectory();

		expect(ACTIVE_DATA_DIRECTORY).toBe(".3xhaust");
		expect(resolveUserDataDirectory(home)).toBe(join(home, ".3xhaust"));
		expect(resolveProjectDataDirectory(project)).toBe(join(project, ".3xhaust"));
		expect(LEGACY_DATA_DIRECTORIES).toEqual([".3xhaustpi", ".tenuispi"]);
	});

	it("copies a shipped legacy data file into the active data directory without replacing active data", () => {
		const home = temporaryDirectory();
		const legacyPath = join(home, ".3xhaustpi", "state.sqlite");
		const activePath = join(home, ".3xhaust", "state.sqlite");
		mkdirSync(join(home, ".3xhaustpi"), { recursive: true });
		writeFileSync(legacyPath, "legacy-state", { mode: 0o600 });

		expect(migrateLegacyDataFile(activePath, legacyPath)).toBe(activePath);
		expect(readFileSync(activePath, "utf8")).toBe("legacy-state");
		writeFileSync(activePath, "active-state", { mode: 0o600 });
		expect(migrateLegacyDataFile(activePath, legacyPath)).toBe(activePath);
		expect(readFileSync(activePath, "utf8")).toBe("active-state");
	});

	it("copies shipped legacy configuration into the active data directory", () => {
		const home = temporaryDirectory();
		const legacyDirectory = join(home, ".tenuispi");
		const activeDirectory = join(home, ".3xhaust");
		mkdirSync(legacyDirectory);
		writeFileSync(join(legacyDirectory, "mcp.json"), '{"mcpServers":{}}');

		expect(migrateLegacyDataDirectory(activeDirectory, legacyDirectory)).toBe(activeDirectory);
		expect(readFileSync(join(activeDirectory, "mcp.json"), "utf8")).toBe('{"mcpServers":{}}');
	});

	it("prefers .3xhaustpi over .tenuispi when migrating an existing user directory", () => {
		const home = temporaryDirectory();
		mkdirSync(join(home, ".3xhaustpi"), { recursive: true });
		mkdirSync(join(home, ".tenuispi"), { recursive: true });
		writeFileSync(join(home, ".3xhaustpi", "source.txt"), "newer");
		writeFileSync(join(home, ".tenuispi", "source.txt"), "older");

		const activeDirectory = resolveUserDataDirectory(home);

		expect(activeDirectory).toBe(join(home, ".3xhaust"));
		expect(readFileSync(join(activeDirectory, "source.txt"), "utf8")).toBe("newer");
	});

	it.runIf(process.platform !== "win32")("rejects symlinked legacy directories without touching their targets", () => {
		const project = temporaryDirectory();
		const outside = temporaryDirectory();
		chmodSync(outside, 0o755);
		symlinkSync(outside, join(project, ".3xhaustpi"), "dir");

		expect(() => resolveProjectDataDirectory(project)).toThrow(/unsafe.*symlink/iu);
		expect(existsSync(join(project, ".3xhaust"))).toBe(false);
		expect(lstatSync(outside).mode & 0o777).toBe(0o755);
	});

	it.runIf(process.platform !== "win32")(
		"does not publish a partial active directory when migration validation fails",
		() => {
			const home = temporaryDirectory();
			const outside = temporaryDirectory();
			const legacy = join(home, ".3xhaustpi");
			mkdirSync(legacy);
			writeFileSync(join(legacy, "config.json"), "{}");
			symlinkSync(outside, join(legacy, "escape"), "dir");

			expect(() => resolveUserDataDirectory(home)).toThrow(/unsafe.*symlink/iu);
			expect(existsSync(join(home, ".3xhaust"))).toBe(false);
			expect(readdirSync(home).some((entry) => entry.startsWith(".3xhaust.migrate-"))).toBe(false);
		},
	);

	it("repairs migrated credential metadata permissions", () => {
		const home = temporaryDirectory();
		const legacy = join(home, ".3xhaustpi");
		mkdirSync(legacy);
		writeFileSync(join(legacy, "auth.json"), "{}", { mode: 0o644 });

		const active = resolveUserDataDirectory(home);

		expect(lstatSync(join(active, "auth.json")).mode & 0o777).toBe(0o600);
	});

	it("moves a shipped keychain credential into the active keychain service on first read", async () => {
		const directory = temporaryDirectory();
		const metadataPath = join(directory, "auth.json");
		const currentKeyring = new Map<string, string>();
		const legacyKeyring = new Map<string, string>();
		const credential = JSON.stringify({
			type: "oauth",
			access: "legacy-access",
			refresh: "legacy-refresh",
			expires: Date.now() + 60_000,
		});
		legacyKeyring.set("openai-codex", credential);
		writeFileSync(metadataPath, '{"openai-codex":{"type":"oauth","storage":"os-keyring"}}', { mode: 0o600 });
		const entry = (keyring: Map<string, string>, providerId: string) => ({
			getPassword: () => Promise.resolve(keyring.get(providerId)),
			setPassword: async (password: string) => {
				keyring.set(providerId, password);
			},
			deleteCredential: async () => keyring.delete(providerId),
		});
		const store = new SystemCredentialStore(metadataPath, {
			entryFactory: (providerId) => entry(currentKeyring, providerId),
			legacyEntryFactory: (providerId) => entry(legacyKeyring, providerId),
		});

		expect(await store.read("openai-codex")).toMatchObject({ access: "legacy-access" });
		expect(currentKeyring.get("openai-codex")).toBe(credential);
		expect(legacyKeyring.get("openai-codex")).toBe(credential);
		expect(existsSync(metadataPath)).toBe(true);
	});
});
