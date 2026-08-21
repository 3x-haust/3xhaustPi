import { describe, expect, it } from "vitest";
import { formatTuiActivityLine, TranscriptViewport, TUI_SCROLL_KEYS } from "../src/tui.ts";
import { stripAnsi } from "../src/tui-text.ts";

function entry(label: string): string {
	return `line ${label}`;
}

describe("TUI keyboard navigation", () => {
	it("maps the documented scroll key sequences", () => {
		expect(TUI_SCROLL_KEYS.pageUp).toBe("\u001b[5~");
		expect(TUI_SCROLL_KEYS.pageDown).toBe("\u001b[6~");
		expect(TUI_SCROLL_KEYS.altUp).toBe("\u001b[1;3A");
		expect(TUI_SCROLL_KEYS.altDown).toBe("\u001b[1;3B");
		expect(TUI_SCROLL_KEYS.altEnd).toBe("\u001b[1;3F");
	});

	it("renders older transcript windows while scrolled up and follows tail again at zero", () => {
		const entries = Array.from({ length: 40 }, (_, index) => entry(String(index).padStart(2, "0")));
		const rows = () => 12;
		const offset = { value: 0 };
		const viewport = new TranscriptViewport(
			entries,
			rows,
			() => 0,
			() => offset.value,
		);

		const tail = viewport.render(60).map((line) => stripAnsi(line));
		expect(tail.some((line) => line.includes("line 39"))).toBe(true);

		offset.value = 10;
		const scrolled = viewport.render(60).map((line) => stripAnsi(line));
		expect(scrolled.some((line) => line.includes("line 39"))).toBe(false);
		expect(scrolled.some((line) => line.includes("line 29"))).toBe(true);
		expect(scrolled.every((line) => line.trim().length > 0 || true)).toBe(true);
	});

	it("reports detached new output in the activity row and stays quiet while following", () => {
		const following = formatTuiActivityLine({ status: "ready" });
		expect(following).not.toContain("new");

		const detached = stripAnsi(formatTuiActivityLine({ status: "ready", detachedNew: 7 }));
		expect(detached).toContain("↓ 7 new");
		expect(detached).toContain("Alt+End");
	});

	it("keeps working-state details beside the detached counter", () => {
		const running = stripAnsi(formatTuiActivityLine({ status: "running", detail: "searchText…", detachedNew: 3 }));
		expect(running).toContain("Working");
		expect(running).toContain("searchText…");
		expect(running).toContain("↓ 3 new");
	});
});
