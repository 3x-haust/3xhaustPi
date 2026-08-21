import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addMcpServer, loadMcpResources, renderResourceHub } from "../src/resource-hub.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const path = mkdtempSync(join(tmpdir(), "3xhaustpi-resource-hub-"));
	temporaryDirectories.push(path);
	return path;
}

afterEach(() => {
	for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("resource hub", () => {
	it("shows skills, MCP servers, and hooks with scope and state", () => {
		const output = renderResourceHub({
			skills: [{ id: "skill-creator", label: "Skill Creator", scope: "builtin", state: "enabled" }],
			mcpServers: [{ id: "aside", label: "aside mcp", scope: "user", state: "configured" }],
			hooks: [{ id: "notify", label: "session.completed", scope: "user", state: "enabled" }],
		});

		expect(output).toContain("Skills 1");
		expect(output).toContain("MCP 1");
		expect(output).toContain("Hooks 1");
		expect(output).toContain("skill-creator");
		expect(output).toContain("aside");
		expect(output).toContain("notify");
	});

	it("adds and lists MCP servers from user and project config without dependencies", () => {
		const root = temporaryDirectory();
		const projectRoot = join(root, "project");
		const userRoot = join(root, "user");

		const userPath = addMcpServer({
			projectRoot,
			userRoot,
			id: "aside",
			command: "aside",
			args: ["mcp"],
			scope: "user",
		});
		addMcpServer({ projectRoot, userRoot, id: "local", command: "node", args: ["server.mjs"], scope: "project" });

		expect(JSON.parse(readFileSync(userPath, "utf8"))).toEqual({
			mcpServers: { aside: { command: "aside", args: ["mcp"] } },
		});
		expect(loadMcpResources({ projectRoot, userRoot })).toEqual([
			{ id: "aside", label: "aside mcp", scope: "user", state: "configured" },
			{ id: "local", label: "node server.mjs", scope: "project", state: "configured" },
		]);
		expect(() =>
			addMcpServer({ projectRoot, userRoot, id: "aside", command: "aside", args: [], scope: "user" }),
		).toThrow(/already exists/u);
	});

	it("rejects malformed or linked MCP configs", () => {
		const root = temporaryDirectory();
		const projectRoot = join(root, "project");
		const userRoot = join(root, "user");
		writeFileSync(join(root, "outside.json"), '{"mcpServers":{}}');
		mkdirSync(userRoot, { recursive: true });
		symlinkSync(join(root, "outside.json"), join(userRoot, "mcp.json"));

		expect(() =>
			addMcpServer({ projectRoot, userRoot: root, id: "bad id", command: "cmd", args: [], scope: "user" }),
		).toThrow(/invalid id/iu);
		expect(() => loadMcpResources({ projectRoot, userRoot })).toThrow(/symbolic link/u);
		rmSync(join(userRoot, "mcp.json"));
		writeFileSync(join(userRoot, "mcp.json"), '{"mcpServers":{"bad":{"args":[1]}}}');
		expect(() => loadMcpResources({ projectRoot, userRoot })).toThrow(/command must not be empty/u);
	});
});
