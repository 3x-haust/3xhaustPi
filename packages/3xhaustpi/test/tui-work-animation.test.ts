import { describe, expect, it } from "vitest";
import {
	cellWidth,
	formatTuiActivityLine,
	retainTuiActivityDetail,
	stripAnsi,
	updateTuiCapabilityActivity,
} from "../src/tui.ts";

describe("active work shimmer", () => {
	it("moves a grayscale luminance sweep without changing text or width", () => {
		const first = formatTuiActivityLine({
			status: "running",
			detail: "searchText",
			animationFrame: 0,
		});
		const second = formatTuiActivityLine({
			status: "running",
			detail: "searchText",
			animationFrame: 1,
		});

		expect(stripAnsi(first)).toBe("• Working (searchText · esc to interrupt)");
		expect(stripAnsi(second)).toBe(stripAnsi(first));
		expect(second).not.toBe(first);
		expect(cellWidth(stripAnsi(second))).toBe(cellWidth(stripAnsi(first)));
		for (const frame of [first, second]) {
			const whiteGlyphs = Array.from(frame.matchAll(/\u001b\[38;5;255m(.)\u001b\[0m/gu), (match) => match[1] ?? "");
			expect(whiteGlyphs).toHaveLength(1);
			expect(whiteGlyphs[0]?.trim()).not.toBe("");
			expect(frame).not.toMatch(/\u001b\[38;5;(245|250)m/gu);
		}
	});

	it("retains capability detail across timer-only redraws", () => {
		expect(retainTuiActivityDetail("read…", undefined)).toBe("read…");
		expect(retainTuiActivityDetail("read…", "")).toBe("");
	});

	it("keeps a concurrent sibling active when another capability completes", () => {
		let active: readonly string[] = [];
		active = updateTuiCapabilityActivity(active, "read", "started");
		active = updateTuiCapabilityActivity(active, "searchText", "started");
		active = updateTuiCapabilityActivity(active, "searchText", "completed");
		expect(active).toEqual(["read"]);
		active = updateTuiCapabilityActivity(active, "read", "completed");
		expect(active).toEqual([]);
	});
});
