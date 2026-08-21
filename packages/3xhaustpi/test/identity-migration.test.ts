import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SystemCredentialStore } from "../src/credential-store.ts";
import { migrateLegacyDataDirectory, migrateLegacyDataFile } from "../src/identity.ts";

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
	it("copies a shipped legacy data file into the active data directory without replacing active data", () => {
		const home = temporaryDirectory();
		const legacyPath = join(home, ".tenuispi", "state.sqlite");
		const activePath = join(home, ".3xhaustpi", "state.sqlite");
		mkdirSync(join(home, ".tenuispi"), { recursive: true });
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
		const activeDirectory = join(home, ".3xhaustpi");
		mkdirSync(legacyDirectory);
		writeFileSync(join(legacyDirectory, "mcp.json"), '{"mcpServers":{}}');

		expect(migrateLegacyDataDirectory(activeDirectory, legacyDirectory)).toBe(activeDirectory);
		expect(readFileSync(join(activeDirectory, "mcp.json"), "utf8")).toBe('{"mcpServers":{}}');
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
