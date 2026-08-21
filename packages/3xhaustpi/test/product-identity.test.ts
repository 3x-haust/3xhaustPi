import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	ASSISTANT_DISPLAY_NAME,
	PRODUCT_DISPLAY_NAME,
	PRODUCT_MACHINE_NAME,
	PRODUCT_VERSION,
} from "../src/product-identity.ts";
import { formatTranscriptEntry, renderTuiFrame, stripAnsi, type TuiViewState } from "../src/tui.ts";

const state: TuiViewState = {
	projectRoot: "/tmp/3xhaustpi",
	provider: "openai-codex",
	model: "gpt-5.6-terra",
	thinkingLevel: "medium",
	contextTokens: 0,
	contextLimit: 400_000,
	gitStatus: "clean",
	activeTasks: 0,
	providerConfigured: true,
	status: "ready",
	input: "",
	messages: ["Assistant Identity check"],
	queuedRequests: [],
	workspace: { projects: [], chats: [], requests: [], patches: [] },
};

describe("product identity surfaces", () => {
	it("keeps display, assistant, and machine names distinct", () => {
		expect(PRODUCT_DISPLAY_NAME).toBe("3xhaustPi");
		expect(ASSISTANT_DISPLAY_NAME).toBe("3xhaust");
		expect(PRODUCT_MACHINE_NAME).toBe("3xhaustpi");
	});

	it("matches the shipped package version", () => {
		const manifest: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		const version =
			typeof manifest === "object" && manifest !== null && "version" in manifest ? manifest.version : undefined;
		expect(version).toBe(PRODUCT_VERSION);
	});

	it("renders polished product chrome and unlabeled assistant prose without exposing the machine name", () => {
		const output = renderTuiFrame(state, 72, 24)
			.split("\n")
			.map((line) => stripAnsi(line));
		expect(output[0]).toBe(PRODUCT_DISPLAY_NAME);
		expect(output.some((line) => line.trim() === ASSISTANT_DISPLAY_NAME)).toBe(false);
		expect(output.some((line) => line.trim() === "Identity check")).toBe(true);
		expect(output.join("\n")).not.toContain(PRODUCT_MACHINE_NAME);
	});

	it("normalizes machine and generic assistant transcript prefixes without rendering a label", () => {
		for (const prefix of ["3xhaustpi", "3xhaustPi", "Assistant"] as const) {
			const entry = formatTranscriptEntry(`${prefix} hello`);
			expect(entry.role).toBe("threeXhaust");
			expect(entry.content).toBe("hello");
			expect(stripAnsi(entry.label)).toBe("");
		}
	});
});
