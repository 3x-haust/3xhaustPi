import { describe, expect, it } from "vitest";
import { ASSISTANT_DISPLAY_NAME } from "../src/product-identity.ts";
import { stripAnsi } from "../src/tui-text.ts";
import { AssistantTranscriptFlow, fitTranscriptCards, formatSubmittedPromptTurn } from "../src/tui-transcript.ts";

function visibleLines(entries: readonly string[], columns = 72, budget = 24): string[] {
	return fitTranscriptCards(entries, columns, budget).map((line) => stripAnsi(line).trim());
}

function feed(entries: string[]): AssistantTranscriptFlow {
	return new AssistantTranscriptFlow(
		(entry) => {
			entries.push(entry);
			return entries.length - 1;
		},
		(index, entry) => {
			entries[index] = entry;
		},
		(index, entry) => {
			entries.splice(index, 0, entry);
		},
	);
}

describe("AssistantTranscriptFlow", () => {
	it("streams unlabeled assistant prose in place as deltas arrive", () => {
		const entries: string[] = [];
		const flow = feed(entries);
		flow.delta("안녕하세요,");
		let lines = visibleLines(entries);
		expect(lines.join("\n")).not.toContain(ASSISTANT_DISPLAY_NAME);
		expect(lines.join("\n")).toContain("안녕하세요,");
		flow.delta(" 무엇을 도와드릴까요?");
		lines = visibleLines(entries);
		expect(lines.join("\n")).toContain("무엇을 도와드릴까요?");
		expect(lines.filter((line) => line.includes("안녕하세요,"))).toHaveLength(1);
	});

	it("places muted thought above the streamed answer and metrics below it without labels", () => {
		const entries: string[] = [];
		const userTurn = formatSubmittedPromptTurn("안녕", true);
		if (userTurn) entries.push(userTurn);
		const flow = feed(entries);
		flow.delta("무엇을 도와드릴까요?");
		flow.noteThought("Thought: 5.3s");
		flow.noteMetrics("TPS 21.1 tok/s · Cache hit 0.0% · 5.3s");
		flow.complete("무엇을 도와드릴까요?");
		const rendered = visibleLines(entries).filter((line) => line.trim().length > 0);
		expect(rendered[0]).toBe("안녕");
		expect(rendered[1]).toContain("Thought: 5.3s");
		expect(rendered[2]).toBe("무엇을 도와드릴까요?");
		expect(rendered[3]).toContain("TPS 21.1 tok/s");
		expect(rendered.join("\n")).not.toContain(ASSISTANT_DISPLAY_NAME);
	});

	it("keeps the legacy non-streaming order when no delta arrived", () => {
		const entries: string[] = [];
		const flow = feed(entries);
		flow.noteThought("Thought: 1.0s");
		flow.noteMetrics("Stats: 4.5s");
		flow.complete("직접 답변");
		const rendered = visibleLines(entries).filter((line) => line.trim().length > 0);
		expect(rendered).toEqual(["Thought: 1.0s", "직접 답변", "4.5s"]);
	});
});
