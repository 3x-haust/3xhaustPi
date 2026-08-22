import { ASSISTANT_DISPLAY_NAME } from "./product-identity.ts";
import {
	cellWidth,
	dim,
	emphasis,
	failure,
	italic,
	muted,
	promptSurfaceLine,
	sanitizeTerminalText,
	stripAnsi,
	text,
	warning,
} from "./tui-text.ts";

export type TuiTranscriptRole =
	| "you"
	| "threeXhaust"
	| "thought"
	| "metrics"
	| "tool"
	| "agent"
	| "system"
	| "error"
	| "approval";

export interface TuiTranscriptTemplate {
	readonly role: TuiTranscriptRole;
	readonly label: string;
	readonly content: string;
}

export function formatSubmittedPromptTurn(objective: string, inserted: boolean): string | undefined {
	return inserted ? `You ${objective}` : undefined;
}

export function formatTranscriptEntry(value: string): TuiTranscriptTemplate {
	const visible = stripAnsi(sanitizeTerminalText(value)).trimStart();
	const without = (pattern: RegExp) => visible.replace(pattern, "").trimStart();
	if (/^(You|User|사용자)\b/u.test(visible)) {
		return { role: "you", label: "", content: without(/^(You|User|사용자)\s*/u) };
	}
	const assistantPrefix = /^(3xhaustPi|3xhaustpi|3xhaust|Assistant)\b/u;
	if (assistantPrefix.test(visible)) {
		return {
			role: "threeXhaust",
			label: "",
			content: without(/^(3xhaustPi|3xhaustpi|3xhaust|Assistant)\s*/u),
		};
	}
	if (/^assistant\b/u.test(visible)) {
		return { role: "threeXhaust", label: "", content: without(/^assistant\s*/u) };
	}
	if (/^Thought:/u.test(visible)) return { role: "thought", label: "", content: visible };
	if (/^Stats:/u.test(visible)) return { role: "metrics", label: "", content: without(/^Stats:\s*/u) };
	if (/^TPS\b/u.test(visible)) return { role: "metrics", label: "", content: visible };
	if (
		/^(Patch ready|Press y|Computer action ready|✓ Patch approved|✓ Computer action approved|Patch rejected)\b/u.test(
			visible,
		)
	) {
		return { role: "approval", label: warning("review"), content: visible };
	}
	if (/^(?:Error:|Computer Use:|Unknown command:)/u.test(visible)) {
		return { role: "error", label: failure("error"), content: visible };
	}
	if (/^(?:tool|capability|◇ model)\b|^[✓×]/u.test(visible))
		return { role: "tool", label: muted("tool"), content: visible };
	if (/^(agent|chat|Intent →)\b/u.test(visible)) return { role: "agent", label: muted("agent"), content: visible };
	return { role: "system", label: dim("system"), content: visible };
}

export interface TranscriptFeedHooks {
	readonly push: (entry: string) => number;
	readonly replace: (index: number, entry: string) => void;
}

/**
 * Owns the assistant response flow in the transcript: streaming deltas update
 * one unlabeled prose entry in place. Runtime telemetry belongs in the status
 * rail rather than the conversation transcript.
 */
export class AssistantTranscriptFlow {
	readonly #hooks: TranscriptFeedHooks;
	#streamIndex: number | undefined;
	#streamed = "";

	constructor(push: TranscriptFeedHooks["push"], replace: TranscriptFeedHooks["replace"]) {
		this.#hooks = { push, replace };
	}

	delta(value: string): void {
		if (!value) return;
		this.#streamed += value;
		const entry = `${ASSISTANT_DISPLAY_NAME} ${this.#streamed}`;
		if (this.#streamIndex === undefined) this.#streamIndex = this.#hooks.push(entry);
		else this.#hooks.replace(this.#streamIndex, entry);
	}

	complete(text: string): void {
		const entry = `${ASSISTANT_DISPLAY_NAME} ${text}`;
		if (this.#streamIndex !== undefined) this.#hooks.replace(this.#streamIndex, entry);
		else this.#hooks.push(entry);
		this.#streamIndex = undefined;
		this.#streamed = "";
	}

	reset(): void {
		this.#streamIndex = undefined;
		this.#streamed = "";
	}
}

function wrapPlainLine(value: string, columns: number): string[] {
	const width = Math.max(1, columns);
	if (cellWidth(value) <= width) return [value];
	const lines: string[] = [];
	let line = "";
	let used = 0;
	const pushLine = () => {
		lines.push(line);
		line = "";
		used = 0;
	};
	for (const token of value.match(/\S+\s*|\s+/gu) ?? [value]) {
		const tokenWidth = cellWidth(token);
		if (tokenWidth <= width && used > 0 && used + tokenWidth > width) pushLine();
		if (tokenWidth <= width) {
			line += token;
			used += tokenWidth;
			continue;
		}
		for (const character of token) {
			const characterWidth = cellWidth(character);
			if (used > 0 && used + characterWidth > width) pushLine();
			line += character;
			used += characterWidth;
		}
	}
	lines.push(line);
	return lines;
}

function messageCard(value: string, columns: number): string[] {
	const { role, label, content } = formatTranscriptEntry(value);
	const source = content || stripAnsi(sanitizeTerminalText(value));
	const gutter = "  ";
	if (role === "you") {
		const bodyIndent = "  ";
		const contentWidth = Math.max(1, columns - cellWidth(bodyIndent) * 2);
		const rows = source
			.split("\n")
			.flatMap((physical) => wrapPlainLine(physical, contentWidth))
			.map((line) => promptSurfaceLine(`${bodyIndent}${line}`, columns));
		if (columns >= 80) return [promptSurfaceLine("", columns), ...rows, promptSurfaceLine("", columns)];
		if (columns >= 40) return [...rows, promptSurfaceLine("", columns)];
		return rows;
	}
	if (role === "threeXhaust") {
		const bodyIndent = gutter;
		const contentWidth = Math.max(1, Math.min(96, columns - cellWidth(bodyIndent)));
		const rows = source
			.split("\n")
			.flatMap((physical) => wrapPlainLine(physical, contentWidth))
			.map((line) => text(`${bodyIndent}${line}`));
		return columns >= 80 ? ["", ...rows, ""] : [...rows, ""];
	}
	if (role === "thought") {
		const contentWidth = Math.max(1, columns - cellWidth(gutter));
		return source
			.split("\n")
			.flatMap((physical) => wrapPlainLine(physical, contentWidth))
			.map((line) => muted(italic(`${gutter}${line}`)));
	}
	if (role === "metrics") {
		const contentWidth = Math.max(1, columns - cellWidth(gutter));
		const rows = source
			.split("\n")
			.flatMap((physical) => wrapPlainLine(physical, contentWidth))
			.map((line) => dim(`${gutter}${line}`));
		return [...rows, ""];
	}
	if (role === "system") {
		const prefix = `${gutter}• `;
		const continuation = `${gutter}  `;
		const contentWidth = Math.max(1, columns - cellWidth(prefix));
		const rows = source.split("\n").flatMap((physical) => wrapPlainLine(physical, contentWidth));
		return rows.map((line, index) => dim(`${index === 0 ? prefix : continuation}${line}`));
	}
	if (role === "agent" || role === "tool") {
		const prefix = gutter;
		const continuation = gutter;
		const contentWidth = Math.max(1, columns - cellWidth(gutter));
		const rows = source.split("\n").flatMap((physical) => wrapPlainLine(physical, contentWidth));
		return rows.map((line, index) =>
			role === "agent"
				? muted(emphasis(`${index === 0 ? prefix : continuation}${line}`))
				: muted(`${index === 0 ? prefix : continuation}${line}`),
		);
	}
	const prefix = `${gutter}${label} ${dim("│")} `;
	const continuation = `${gutter}${" ".repeat(cellWidth(stripAnsi(label)))} ${dim("│")} `;
	const contentWidth = Math.max(1, columns - cellWidth(stripAnsi(prefix)));
	const rows = source.split("\n").flatMap((physical) => wrapPlainLine(physical, contentWidth));
	return rows.map((line, index) => `${index === 0 ? prefix : continuation}${line}`);
}

function transcriptCards(entries: readonly string[], columns: number): string[][] {
	const templates = entries.map((entry) => formatTranscriptEntry(entry));
	const hasChat = templates.some(({ role }) => role === "you" || role === "threeXhaust");
	const cards: string[][] = [];
	let pendingActivity: string[][] = [];
	let activeAssistantCard: number | undefined;
	for (const [index, entry] of entries.entries()) {
		const template = templates[index];
		if (!template || (hasChat && template.role === "system")) continue;
		const card = messageCard(entry, columns);
		if (template.role === "agent" || template.role === "tool") {
			if (activeAssistantCard === undefined) {
				pendingActivity.push(card);
				continue;
			}
			const owner = cards[activeAssistantCard];
			if (!owner) continue;
			if (owner.at(-1) === "") owner.pop();
			owner.push(...card, "");
			continue;
		}
		if (template.role === "thought" && pendingActivity.length > 0) {
			cards.push(...pendingActivity);
			pendingActivity = [];
		}
		if (template.role === "metrics" && activeAssistantCard !== undefined) {
			const owner = cards[activeAssistantCard];
			if (!owner) continue;
			if (owner.at(-1) === "") owner.pop();
			owner.push("", ...card);
			continue;
		}
		if (template.role === "you" && pendingActivity.length > 0) {
			cards.push(...pendingActivity);
			pendingActivity = [];
		}
		const renderedCard =
			template.role === "threeXhaust" && pendingActivity.length > 0 ? [...pendingActivity.flat(), ...card] : card;
		if (template.role === "threeXhaust") pendingActivity = [];
		const previousCard = cards.at(-1);
		const previousGap = previousCard?.at(-1);
		const nextGap = renderedCard.at(0);
		if (
			previousCard &&
			previousGap !== undefined &&
			nextGap !== undefined &&
			stripAnsi(previousGap).trim().length === 0 &&
			stripAnsi(nextGap).trim().length === 0
		) {
			if (previousGap === "" && nextGap !== "") previousCard.pop();
			else renderedCard.shift();
		}
		cards.push(renderedCard);
		activeAssistantCard = template.role === "threeXhaust" ? cards.length - 1 : undefined;
	}
	if (pendingActivity.length > 0) {
		cards.push([...pendingActivity.flat(), ""]);
	}
	return cards;
}

export function fitTranscriptCards(entries: readonly string[], columns: number, budget: number): string[] {
	const visibleCards: string[][] = [];
	const cards = transcriptCards(entries, columns);
	let remaining = Math.max(0, budget);
	for (let index = cards.length - 1; index >= 0 && remaining > 0; index -= 1) {
		const card = cards[index];
		if (!card) continue;
		if (card.length <= remaining) {
			visibleCards.unshift(card);
			remaining -= card.length;
			continue;
		}
		if (visibleCards.length === 0) {
			const cardHasTrailingGap = stripAnsi(card.at(-1) ?? "").trim().length === 0;
			const hasTrailingGap = cardHasTrailingGap && remaining > 2;
			const contentEnd = cardHasTrailingGap ? card.length - 1 : card.length;
			const anchorIndex = card.findIndex((line, candidateIndex) => {
				return candidateIndex < contentEnd && stripAnsi(line).trim().length > 0;
			});
			const resolvedAnchorIndex = anchorIndex === -1 ? 0 : anchorIndex;
			const anchor = card[resolvedAnchorIndex] ?? "";
			const body = card.slice(resolvedAnchorIndex + 1, contentEnd);
			const bodyBudget = Math.max(0, remaining - 1 - (hasTrailingGap ? 1 : 0));
			const visibleBody = bodyBudget > 0 ? body.slice(-bodyBudget) : [];
			visibleCards.unshift([anchor, ...visibleBody, ...(hasTrailingGap ? [""] : [])]);
			remaining = 0;
		}
		break;
	}
	return visibleCards.flat();
}
