import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(import.meta.dirname, "..");

describe("CLI launcher isolation", () => {
	it("keeps sqlite/TUI imports out of the public launcher and builds a warning-suppressed TUI entry", () => {
		const launcher = readFileSync(resolve(packageRoot, "src/cli-launcher.ts"), "utf8");
		const build = readFileSync(resolve(packageRoot, "build.mjs"), "utf8");

		expect(launcher).not.toContain("./tui.ts");
		expect(launcher).not.toContain("./tui-runtime-client.ts");
		expect(launcher).toContain("cli-tui.js");
		expect(launcher).toContain("NODE_NO_WARNINGS");
		expect(build).toContain("cli-tui");
	});
});
