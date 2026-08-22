import { describe, expect, it } from "vitest";
import { cellWidth, formatTuiActivityLine, stripAnsi } from "../src/tui.ts";

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
	});
});
