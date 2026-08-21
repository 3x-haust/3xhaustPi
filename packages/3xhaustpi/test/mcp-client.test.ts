import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { callMcpTool, listMcpTools } from "../src/mcp-client.ts";
import { addMcpServer } from "../src/resource-hub.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const path = mkdtempSync(join(tmpdir(), "3xhaustpi-mcp-client-"));
	temporaryDirectories.push(path);
	return path;
}

afterEach(() => {
	for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("MCP stdio client", () => {
	it("initializes a configured server and performs tools/list and tools/call over JSON-RPC stdio", async () => {
		const root = temporaryDirectory();
		const projectRoot = join(root, "project");
		mkdirSync(projectRoot, { recursive: true });
		const fixture = resolve(import.meta.dirname, "fixtures/mcp-stdio-fixture.mjs");
		addMcpServer({ projectRoot, id: "fixture", command: process.execPath, args: [fixture], scope: "project" });

		await expect(listMcpTools({ projectRoot, server: "fixture", timeoutMs: 1_000 })).resolves.toEqual([
			{
				name: "echo",
				description: "Echo fixture input",
				inputSchema: { type: "object", properties: { text: { type: "string" } } },
			},
		]);
		await expect(
			callMcpTool({ projectRoot, server: "fixture", tool: "echo", arguments: { text: "hello" }, timeoutMs: 1_000 }),
		).resolves.toEqual({
			content: [
				{ type: "text", text: "echo:hello" },
				{ type: "text", text: '{"tool":"echo","ok":true}' },
			],
		});
	});
});
