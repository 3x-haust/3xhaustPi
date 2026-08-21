import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/args.ts";

describe("3xhaustpi CLI arguments", () => {
	it("routes the documented commands", () => {
		expect(parseCliArgs(["models"])).toEqual({ kind: "models" });
		expect(parseCliArgs(["doctor"])).toEqual({ kind: "doctor" });
		expect(parseCliArgs(["extension", "list"])).toEqual({ kind: "extension-list" });
		expect(parseCliArgs(["resource", "list"])).toEqual({ kind: "resource-list" });
		expect(parseCliArgs(["accounts"])).toEqual({ kind: "accounts-list" });
		expect(parseCliArgs(["npm", "login", "work"])).toEqual({
			kind: "npm-login",
			account: "work",
		});
		expect(parseCliArgs(["npm", "publish", "work"])).toEqual({
			kind: "npm-publish",
			account: "work",
		});
		expect(parseCliArgs(["skill", "create", "release-helper"])).toEqual({
			kind: "skill-create",
			name: "release-helper",
		});
		expect(parseCliArgs(["auth", "login", "openai-codex"])).toEqual({
			kind: "auth-login",
			provider: "openai-codex",
		});
		expect(parseCliArgs(["mcp", "tools", "fixture"])).toEqual({ kind: "mcp-tools", server: "fixture" });
		expect(parseCliArgs(["mcp", "call", "fixture", "echo", '{"text":"hello"}'])).toEqual({
			kind: "mcp-call",
			server: "fixture",
			tool: "echo",
			jsonArgs: '{"text":"hello"}',
		});
	});

	it("parses project, resume, and print inputs without swallowing values", () => {
		expect(parseCliArgs(["--project", "./demo", "--resume", "-p", "inspect"])).toEqual({
			kind: "run",
			project: "./demo",
			prompt: "inspect",
			resume: true,
			approve: false,
		});
		expect(parseCliArgs(["-p", "fix it", "--approve", "--provider", "openai-codex"])).toEqual({
			kind: "run",
			prompt: "fix it",
			resume: false,
			approve: true,
			provider: "openai-codex",
		});
		expect(parseCliArgs(["--allow-project-hooks", "-p", "inspect"])).toEqual({
			kind: "run",
			prompt: "inspect",
			resume: false,
			approve: false,
			allowProjectHooks: true,
		});
	});

	it("rejects unknown or ambiguous arguments", () => {
		expect(() => parseCliArgs(["--unknown"])).toThrow(/Unknown option/u);
		expect(() => parseCliArgs(["-p", "one", "two"])).toThrow(/either -p/u);
	});

	it("bounds benchmark repetitions", () => {
		expect(parseCliArgs(["benchmark", "--repetitions", "20"])).toEqual({
			kind: "benchmark",
			repetitions: 20,
			real: false,
		});
		expect(parseCliArgs(["benchmark", "--real", "--repetitions", "20", "--model", "gpt-5.6-terra"])).toEqual({
			kind: "benchmark",
			real: true,
			repetitions: 20,
			model: "gpt-5.6-terra",
		});
		expect(parseCliArgs(["benchmark", "--real"])).toEqual({
			kind: "benchmark",
			real: true,
			repetitions: 20,
		});
		expect(() => parseCliArgs(["benchmark", "--repetitions", "0"])).toThrow(/between 1 and 100000/u);
	});
});
