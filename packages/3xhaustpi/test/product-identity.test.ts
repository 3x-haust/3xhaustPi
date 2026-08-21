import { describe, expect, it } from "vitest";
import { ASSISTANT_DISPLAY_NAME, PRODUCT_DISPLAY_NAME, PRODUCT_MACHINE_NAME } from "../src/product-identity.ts";
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

	it("renders polished product chrome and assistant labels without exposing the machine name", () => {
		const output = renderTuiFrame(state, 72, 24)
			.split("\n")
			.map((line) => stripAnsi(line));
		expect(output[0]).toBe(PRODUCT_DISPLAY_NAME);
		expect(output).toContain(ASSISTANT_DISPLAY_NAME);
		expect(output.join("\n")).not.toContain(PRODUCT_MACHINE_NAME);
	});

	it("normalizes machine and generic assistant transcript prefixes to the assistant display name", () => {
		for (const prefix of ["3xhaustpi", "3xhaustPi", "Assistant"] as const) {
			expect(stripAnsi(formatTranscriptEntry(`${prefix} hello`).label)).toBe(ASSISTANT_DISPLAY_NAME);
		}
	});
});
