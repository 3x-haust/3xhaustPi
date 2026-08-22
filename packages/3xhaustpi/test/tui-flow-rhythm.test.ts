import { describe, expect, it } from "vitest";
import { formatTuiActivityLine, stripAnsi } from "../src/tui.ts";
import { fitTranscriptCards } from "../src/tui-transcript.ts";

describe("TUI response flow rhythm", () => {
	it("uses one blank row between work, answer, and response metrics", () => {
		for (const columns of [56, 80, 120]) {
			const lines = [
				...fitTranscriptCards(["You 질문", "✓ searchText  1.5 ms · source inspected", "3xhaust 답변"], columns, 16),
				formatTuiActivityLine({
					status: "ready",
					metrics: "TPS 10.1 tok/s. Cache hit 100.0%, 1.5s",
				}),
			].map((line) => stripAnsi(line));
			const work = lines.findIndex((line) => line.includes("source inspected"));
			const answer = lines.findIndex((line) => line.includes("답변"));
			const metrics = lines.findIndex((line) => line.includes("TPS 10.1 tok/s"));

			expect(answer - work, `${columns}-column work→answer`).toBe(2);
			expect(metrics - answer, `${columns}-column answer→metrics`).toBe(2);
			expect(lines[work + 1]).toBe("");
			expect(lines[answer + 1]).toBe("");
		}
	});
});
