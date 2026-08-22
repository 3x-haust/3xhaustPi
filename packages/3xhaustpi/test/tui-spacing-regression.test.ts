import { describe, expect, it } from "vitest";
import { stripAnsi } from "../src/tui-text.ts";
import { fitTranscriptCards } from "../src/tui-transcript.ts";

describe("compact conversation spacing", () => {
	it("keeps one leading and trailing row around prompt and answer bodies", () => {
		for (const columns of [56, 72, 80, 120]) {
			const lines = fitTranscriptCards(["You 안녕", "3xhaustPi 안녕하세요."], columns, 12).map((line) =>
				stripAnsi(line),
			);
			const user = lines.findIndex((line) => line.includes("안녕") && !line.includes("안녕하세요"));
			const assistant = lines.findIndex((line) => line.includes("안녕하세요"));

			expect(user, `${columns}-column user leading padding`).toBeGreaterThan(0);
			expect(assistant - user, `${columns}-column card boundary`).toBe(2);
			expect(lines[user - 1]?.trim(), `${columns}-column user leading row`).toBe("");
			expect(lines[user + 1]?.trim(), `${columns}-column user trailing row`).toBe("");
			expect(lines[assistant - 1]?.trim(), `${columns}-column assistant leading row`).toBe("");
			expect(lines[assistant + 1]?.trim(), `${columns}-column assistant trailing row`).toBe("");
		}
	});
});
