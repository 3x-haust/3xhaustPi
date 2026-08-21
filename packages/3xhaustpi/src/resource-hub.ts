import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveProjectDataDirectory, resolveUserDataDirectory } from "./identity.ts";

export interface ResourceHubItem {
	readonly id: string;
	readonly label: string;
	readonly scope: "builtin" | "user" | "project";
	readonly state: "enabled" | "disabled" | "configured" | "unavailable";
}

export interface ResourceHubState {
	readonly skills: readonly ResourceHubItem[];
	readonly mcpServers: readonly ResourceHubItem[];
	readonly hooks: readonly ResourceHubItem[];
}

export interface McpServerConfiguration {
	readonly command: string;
	readonly args?: readonly string[];
}

interface McpConfiguration {
	readonly mcpServers?: Readonly<Record<string, McpServerConfiguration>>;
}

const RESOURCE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

function assertId(value: string, label: string): void {
	if (!RESOURCE_ID.test(value)) throw new Error(`${label} has an invalid id: ${value}`);
}

function assertRegularFile(path: string): void {
	const info = lstatSync(path);
	if (info.isSymbolicLink()) throw new Error(`MCP config must not be a symbolic link: ${path}`);
	if (!info.isFile()) throw new Error(`MCP config must be a regular file: ${path}`);
}

function parseMcpConfiguration(path: string): McpConfiguration {
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`MCP config must be an object: ${path}`);
	}
	const rawServers = (parsed as { readonly mcpServers?: unknown }).mcpServers;
	if (rawServers === undefined) return {};
	if (typeof rawServers !== "object" || rawServers === null || Array.isArray(rawServers)) {
		throw new Error(`MCP servers must be an object: ${path}`);
	}
	const mcpServers: Record<string, McpServerConfiguration> = {};
	for (const [id, server] of Object.entries(rawServers)) {
		assertId(id, "MCP server");
		if (typeof server !== "object" || server === null || Array.isArray(server)) {
			throw new Error(`MCP server must be an object: ${id}`);
		}
		const command = (server as { readonly command?: unknown }).command;
		const args = (server as { readonly args?: unknown }).args;
		if (typeof command !== "string" || !command.trim()) throw new Error(`MCP command must not be empty: ${id}`);
		if (args !== undefined && (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))) {
			throw new Error(`MCP args must be strings: ${id}`);
		}
		mcpServers[id] = { command, ...(args && args.length > 0 ? { args } : {}) };
	}
	return { mcpServers };
}

function parseMcpFile(path: string, scope: "user" | "project"): readonly ResourceHubItem[] {
	if (!existsSync(path)) return [];
	assertRegularFile(path);
	const parsed = parseMcpConfiguration(path);
	return Object.entries(parsed.mcpServers ?? {})
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([id, server]) => ({
			id,
			label: [server.command, ...(server.args ?? [])].join(" "),
			scope,
			state: "configured",
		}));
}

export function loadMcpResources(input: {
	readonly projectRoot: string;
	readonly userRoot?: string;
}): readonly ResourceHubItem[] {
	const userRoot = input.userRoot ?? resolveUserDataDirectory();
	const projectRoot = resolveProjectDataDirectory(input.projectRoot);
	const byId = new Map<string, ResourceHubItem>();
	for (const item of parseMcpFile(join(userRoot, "mcp.json"), "user")) byId.set(item.id, item);
	for (const item of parseMcpFile(join(projectRoot, "mcp.json"), "project")) byId.set(item.id, item);
	return [...byId.values()];
}

export function loadMcpServerConfiguration(input: {
	readonly projectRoot: string;
	readonly id: string;
	readonly userRoot?: string;
}): McpServerConfiguration | undefined {
	assertId(input.id, "MCP server");
	const userRoot = input.userRoot ?? resolveUserDataDirectory();
	const userPath = join(userRoot, "mcp.json");
	const projectPath = join(resolveProjectDataDirectory(input.projectRoot), "mcp.json");
	let user: McpServerConfiguration | undefined;
	if (existsSync(userPath)) {
		assertRegularFile(userPath);
		user = parseMcpConfiguration(userPath).mcpServers?.[input.id];
	}
	let project: McpServerConfiguration | undefined;
	if (existsSync(projectPath)) {
		assertRegularFile(projectPath);
		project = parseMcpConfiguration(projectPath).mcpServers?.[input.id];
	}
	return project ?? user;
}

export function addMcpServer(input: {
	readonly projectRoot: string;
	readonly id: string;
	readonly command: string;
	readonly args: readonly string[];
	readonly scope: "user" | "project";
	readonly userRoot?: string;
}): string {
	assertId(input.id, "MCP server");
	if (!input.command.trim()) throw new Error("MCP command must not be empty");
	if (input.args.some((arg) => typeof arg !== "string")) throw new Error("MCP args must be strings");
	const root =
		input.scope === "project"
			? resolveProjectDataDirectory(input.projectRoot)
			: (input.userRoot ?? resolveUserDataDirectory());
	const path = join(root, "mcp.json");
	let current: McpConfiguration = {};
	if (existsSync(path)) {
		assertRegularFile(path);
		current = parseMcpConfiguration(path);
	}
	if (current.mcpServers?.[input.id]) throw new Error(`MCP server already exists: ${input.id}`);
	const next: McpConfiguration = {
		mcpServers: {
			...(current.mcpServers ?? {}),
			[input.id]: { command: input.command, ...(input.args.length > 0 ? { args: input.args } : {}) },
		},
	};
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	return path;
}

function section(title: string, items: readonly ResourceHubItem[]): string[] {
	return [
		`${title} ${items.length}`,
		...(items.length === 0
			? ["  — none"]
			: items.map(
					(item) =>
						`  ${item.state === "enabled" || item.state === "configured" ? "●" : "○"} ${item.id}  ${item.scope}  ${item.state}  ${item.label}`,
				)),
	];
}

export function renderResourceHub(state: ResourceHubState): string {
	return [
		"Resources",
		"",
		...section("Skills", state.skills),
		"",
		...section("MCP", state.mcpServers),
		"",
		...section("Hooks", state.hooks),
	].join("\n");
}
