import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { loadMcpServerConfiguration } from "./resource-hub.ts";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 1_048_576;

interface JsonRpcSuccess {
	readonly jsonrpc: "2.0";
	readonly id: number;
	readonly result: unknown;
}

interface JsonRpcFailure {
	readonly jsonrpc: "2.0";
	readonly id: number;
	readonly error: { readonly code?: number; readonly message?: string };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export interface McpTool {
	readonly name: string;
	readonly description?: string;
	readonly inputSchema?: unknown;
}

export async function listMcpTools(input: {
	readonly projectRoot: string;
	readonly server: string;
	readonly timeoutMs?: number;
	readonly userRoot?: string;
}): Promise<readonly McpTool[]> {
	return withMcpClient(input, async (client) => {
		const result = await client.request("tools/list", {});
		const tools = objectField(result, "tools");
		if (!Array.isArray(tools)) throw new Error("MCP tools/list result must contain tools array");
		return tools.map((tool) => parseTool(tool));
	});
}

export async function callMcpTool(input: {
	readonly projectRoot: string;
	readonly server: string;
	readonly tool: string;
	readonly arguments?: unknown;
	readonly timeoutMs?: number;
	readonly userRoot?: string;
}): Promise<unknown> {
	return withMcpClient(input, (client) =>
		client.request("tools/call", { name: input.tool, arguments: input.arguments ?? {} }),
	);
}

class StdioMcpClient {
	private nextId = 1;
	private outputBytes = 0;
	private closed = false;
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<
		number,
		{ readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }
	>();
	private readonly timer: NodeJS.Timeout;

	constructor(child: ChildProcessWithoutNullStreams, timeoutMs: number) {
		this.child = child;
		this.timer = setTimeout(() => this.fail(new Error(`MCP request timed out after ${timeoutMs} ms`)), timeoutMs);
		const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
		stdout.on("line", (line) => this.handleLine(line));
		child.stdout.on("data", (chunk: Buffer) => this.trackOutput(chunk.length));
		child.stderr.on("data", (chunk: Buffer) => this.trackOutput(chunk.length));
		child.once("error", (error) => this.fail(error));
		child.once("close", (code, signal) => {
			this.closed = true;
			this.fail(
				new Error(`MCP server exited before responding (code ${code ?? "null"}, signal ${signal ?? "null"})`),
			);
		});
	}

	async initialize(): Promise<void> {
		await this.request("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "3xhaustpi", version: "0.1.0" },
		});
		this.notify("notifications/initialized", {});
	}

	request(method: string, params: unknown): Promise<unknown> {
		if (this.closed) return Promise.reject(new Error("MCP server is closed"));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.write({ jsonrpc: "2.0", id, method, params });
		});
	}

	notify(method: string, params: unknown): void {
		this.write({ jsonrpc: "2.0", method, params });
	}

	async close(): Promise<void> {
		clearTimeout(this.timer);
		for (const [id, pending] of this.pending) {
			pending.reject(new Error("MCP client closed"));
			this.pending.delete(id);
		}
		this.child.stdin.end();
		if (!this.closed) this.child.kill("SIGTERM");
	}

	private write(message: unknown): void {
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	private handleLine(line: string): void {
		this.trackOutput(Buffer.byteLength(line));
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			this.fail(new Error("MCP server wrote invalid JSON-RPC"));
			return;
		}
		if (!isResponse(parsed)) return;
		const pending = this.pending.get(parsed.id);
		if (!pending) return;
		this.pending.delete(parsed.id);
		if ("error" in parsed) {
			pending.reject(new Error(parsed.error.message ?? `MCP JSON-RPC error ${parsed.error.code ?? "unknown"}`));
			return;
		}
		pending.resolve(parsed.result);
	}

	private trackOutput(bytes: number): void {
		this.outputBytes += bytes;
		if (this.outputBytes > MAX_OUTPUT_BYTES) this.fail(new Error("MCP server output exceeded 1048576 bytes"));
	}

	private fail(error: Error): void {
		if (!this.closed) this.child.kill("SIGTERM");
		for (const [id, pending] of this.pending) {
			pending.reject(error);
			this.pending.delete(id);
		}
	}
}

async function withMcpClient<T>(
	input: {
		readonly projectRoot: string;
		readonly server: string;
		readonly timeoutMs?: number;
		readonly userRoot?: string;
	},
	operation: (client: StdioMcpClient) => Promise<T>,
): Promise<T> {
	const configuration = loadMcpServerConfiguration({
		projectRoot: input.projectRoot,
		id: input.server,
		...(input.userRoot ? { userRoot: input.userRoot } : {}),
	});
	if (!configuration) throw new Error(`MCP server is not configured: ${input.server}`);
	const child = spawn(configuration.command, configuration.args ?? [], {
		cwd: input.projectRoot,
		shell: false,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const client = new StdioMcpClient(child, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	try {
		await client.initialize();
		return await operation(client);
	} finally {
		await client.close();
	}
}

function isResponse(value: unknown): value is JsonRpcResponse {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as {
		readonly jsonrpc?: unknown;
		readonly id?: unknown;
		readonly result?: unknown;
		readonly error?: unknown;
	};
	return record.jsonrpc === "2.0" && typeof record.id === "number" && ("result" in record || "error" in record);
}

function objectField(value: unknown, field: string): unknown {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("MCP result must be an object");
	return (value as Record<string, unknown>)[field];
}

function parseTool(value: unknown): McpTool {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("MCP tool must be an object");
	const record = value as Record<string, unknown>;
	if (typeof record.name !== "string" || !record.name) throw new Error("MCP tool name must be a string");
	return {
		name: record.name,
		...(typeof record.description === "string" ? { description: record.description } : {}),
		...("inputSchema" in record ? { inputSchema: record.inputSchema } : {}),
	};
}
