#!/usr/bin/env node
import { createInterface } from "node:readline";

const readline = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

readline.on("line", (line) => {
	const request = JSON.parse(line);
	if (request.method === "initialize") {
		send({
			jsonrpc: "2.0",
			id: request.id,
			result: {
				protocolVersion: "2024-11-05",
				capabilities: { tools: {} },
				serverInfo: { name: "3xhaustpi-fixture", version: "1.0.0" },
			},
		});
		return;
	}
	if (request.method === "notifications/initialized") return;
	if (request.method === "tools/list") {
		send({
			jsonrpc: "2.0",
			id: request.id,
			result: {
				tools: [
					{
						name: "echo",
						description: "Echo fixture input",
						inputSchema: { type: "object", properties: { text: { type: "string" } } },
					},
				],
			},
		});
		return;
	}
	if (request.method === "tools/call") {
		send({
			jsonrpc: "2.0",
			id: request.id,
			result: {
				content: [
					{ type: "text", text: `echo:${request.params?.arguments?.text ?? ""}` },
					{ type: "text", text: JSON.stringify({ tool: request.params?.name, ok: true }) },
				],
			},
		});
		return;
	}
	send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `unknown method ${request.method}` } });
});
