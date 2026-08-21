import { describe, expect, it } from "vitest";
import { compactContext, DEFAULT_COMPACTION_SETTINGS, estimateTokens, shouldCompact } from "../src/compaction.ts";

describe("context compaction", () => {
	it("estimates prose near chars/4 and weights base64 runs heavier", () => {
		const prose = "word ".repeat(400);
		expect(estimateTokens(prose)).toBe(500);

		const blob = "A".repeat(1024);
		expect(estimateTokens(blob)).toBe(1024);
	});

	it("keeps content within budget verbatim", () => {
		expect(compactContext("compact me", 1_000)).toBe("compact me");
	});

	it("compacts deterministically, keeping the tail with a content-addressed marker", () => {
		const head = "ancient evidence ".repeat(2_000);
		const tail = "\nrecent finding: the root cause is X";
		const text = `${head}${tail}`;

		const first = compactContext(text, 600);
		const second = compactContext(text, 600);
		expect(first).toBe(second);
		expect(first).toContain("recent finding");
		expect(first.length).toBeLessThan(text.length);
		expect(first).toMatch(/^\[compacted \d+ chars · sha256:[0-9a-f]{24}\]/u);
	});

	it("flags contexts beyond window minus reserve", () => {
		expect(shouldCompact(190_000, 200_000)).toBe(true);
		expect(shouldCompact(100_000, 200_000)).toBe(false);
		expect(shouldCompact(500_000, 200_000, { ...DEFAULT_COMPACTION_SETTINGS, enabled: false })).toBe(false);
	});
});
