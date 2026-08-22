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

	it("keeps thought and metrics out of the conversation transcript", () => {
		const entries: string[] = [];
		const userTurn = formatSubmittedPromptTurn("안녕", true);
		if (userTurn) entries.push(userTurn);
		const flow = feed(entries);
		flow.delta("무엇을 도와드릴까요?");
		flow.complete("무엇을 도와드릴까요?");
		const rendered = visibleLines(entries).filter((line) => line.trim().length > 0);
		expect(rendered).toEqual(["안녕", "무엇을 도와드릴까요?"]);
		expect(rendered.join("\n")).not.toContain(ASSISTANT_DISPLAY_NAME);
	});

	it("keeps a non-streaming answer as the only assistant transcript entry", () => {
		const entries: string[] = [];
		const flow = feed(entries);
		flow.complete("직접 답변");
		const rendered = visibleLines(entries).filter((line) => line.trim().length > 0);
		expect(rendered).toEqual(["직접 답변"]);
	});
});
