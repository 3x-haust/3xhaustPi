import { ASSISTANT_DISPLAY_NAME } from "./product-identity.ts";
import { accent, cellWidth, dim, failure, muted, stripAnsi, text, warning } from "./tui-text.ts";

export type TuiTranscriptRole = "you" | "threeXhaust" | "tool" | "agent" | "system" | "error" | "approval";

export interface TuiTranscriptTemplate {
	readonly role: TuiTranscriptRole;
	readonly label: string;
	readonly content: string;
}

export function formatSubmittedPromptTurn(objective: string, inserted: boolean): string | undefined {
	return inserted ? `You ${objective}` : undefined;
}

export function formatTranscriptEntry(value: string): TuiTranscriptTemplate {
	const visible = stripAnsi(value).trimStart();
	const without = (pattern: RegExp) => visible.replace(pattern, "").trimStart();
	if (/^(You|User|사용자)\b/u.test(visible)) {
		return { role: "you", label: text("You"), content: without(/^(You|User|사용자)\s*/u) };
	}
	const assistantPrefix = /^(3xhaustPi|3xhaustpi|3xhaust|Assistant)\b/u;
	if (assistantPrefix.test(visible)) {
		return {
			role: "threeXhaust",
			label: accent(ASSISTANT_DISPLAY_NAME),
			content: without(/^(3xhaustPi|3xhaustpi|3xhaust|Assistant)\s*/u),
		};
	}
	if (/^assistant\b/u.test(visible)) {
		return { role: "threeXhaust", label: accent(ASSISTANT_DISPLAY_NAME), content: without(/^assistant\s*/u) };
	}
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
	const source = content || stripAnsi(value);
	const gutter = columns >= 96 ? "   " : "  ";
	if (role === "you" || role === "threeXhaust") {
		const bodyIndent = `${gutter}  `;
		const contentWidth = Math.max(1, Math.min(96, columns - cellWidth(bodyIndent)));
		const rows = source
			.split("\n")
			.flatMap((physical) => wrapPlainLine(physical, contentWidth))
			.map((line) => `${bodyIndent}${line}`);
		return [`${gutter}${label}`, ...rows, ""];
	}
	if (role === "system") {
		const prefix = `${gutter}• `;
		const continuation = `${gutter}  `;
		const contentWidth = Math.max(1, columns - cellWidth(prefix));
		const rows = source.split("\n").flatMap((physical) => wrapPlainLine(physical, contentWidth));
		return rows.map((line, index) => dim(`${index === 0 ? prefix : continuation}${line}`));
	}
	if (role === "agent" || role === "tool") {
		const prefix = `${gutter}  ${dim(role === "agent" ? "├" : "└")} `;
		const continuation = `${gutter}    `;
		const contentWidth = Math.max(1, columns - cellWidth(prefix));
		const rows = source.split("\n").flatMap((physical) => wrapPlainLine(physical, contentWidth));
		return rows.map((line, index) => `${index === 0 ? prefix : continuation}${line}`);
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
		if (template.role === "you" && pendingActivity.length > 0) {
			cards.push(...pendingActivity);
			pendingActivity = [];
		}
		const renderedCard =
			template.role === "threeXhaust" && pendingActivity.length > 0
				? [
						card[0] ?? "",
						...pendingActivity.flat(),
						...card.slice(1, card.at(-1) === "" ? -1 : undefined),
						...(card.at(-1) === "" ? [""] : []),
					]
				: card;
		if (template.role === "threeXhaust") pendingActivity = [];
		cards.push(renderedCard);
		activeAssistantCard = template.role === "threeXhaust" ? cards.length - 1 : undefined;
	}
	if (pendingActivity.length > 0) {
		const gutter = columns >= 96 ? "   " : "  ";
		cards.push([`${gutter}${accent(ASSISTANT_DISPLAY_NAME)}`, ...pendingActivity.flat(), ""]);
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
			const first = card[0] ?? "";
			const cardHasTrailingGap = card.at(-1) === "";
			const hasTrailingGap = cardHasTrailingGap && remaining > 2;
			const body = card.slice(1, cardHasTrailingGap ? -1 : undefined);
			const bodyBudget = Math.max(0, remaining - 1 - (hasTrailingGap ? 1 : 0));
			const visibleBody = bodyBudget > 0 ? body.slice(-bodyBudget) : [];
			visibleCards.unshift([first, ...visibleBody, ...(hasTrailingGap ? [""] : [])]);
			remaining = 0;
		}
		break;
	}
	return visibleCards.flat();
}
