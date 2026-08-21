import { createHash } from "node:crypto";

/**
 * Context compaction ported from the omo beta harness techniques:
 *
 * - Conservative token estimation (chars/4) with a 4x weight on long
 *   base64-ish runs, which tokenize near one token per character.
 * - Threshold check against the context window minus a reserve budget.
 * - Deterministic cut-point selection that keeps the most recent content
 *   within the keep budget and replaces the dropped head with a
 *   content-addressed marker so repeated inputs compact identically and the
 *   provider prompt cache prefix stays stable across retries and turns.
 */

/** Long unbroken base64-ish runs (payloads, data URLs, hex dumps). */
const BASE64_RUN_RE = /[A-Za-z0-9+/=_-]{512,}/g;
const BASE64_CHAR_WEIGHT = 4;

export function estimateTokens(text: string): number {
	let chars = text.length;
	BASE64_RUN_RE.lastIndex = 0;
	for (const match of text.matchAll(BASE64_RUN_RE)) {
		chars += match[0].length * (BASE64_CHAR_WEIGHT - 1);
	}
	return Math.ceil(chars / 4);
}

export interface CompactionSettings {
	readonly enabled: boolean;
	readonly reserveTokens: number;
	readonly keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16_384,
	keepRecentTokens: 20_000,
};

export function shouldCompact(
	contextTokens: number,
	contextWindow: number,
	settings: CompactionSettings = DEFAULT_COMPACTION_SETTINGS,
): boolean {
	if (!settings.enabled) return false;
	return contextTokens > contextWindow - settings.reserveTokens;
}

/**
 * Compact oversized declared text to at most `maxTokens` estimated tokens.
 * The cut keeps the tail (most recent evidence) inside the keep budget and
 * prefixes a deterministic marker carrying the SHA-256 of everything removed,
 * so the same input always produces the same compacted prefix.
 */
export function compactContext(text: string, maxTokens: number): string {
	if (maxTokens < 1) throw new Error("Compaction budget must be at least one token");
	if (estimateTokens(text) <= maxTokens) return text;
	const keptCharsBudget = Math.max(0, maxTokens * 4 - 256);
	const tailStart = Math.max(0, text.length - keptCharsBudget);
	// Snap forward to a whitespace boundary so the kept tail starts cleanly.
	const boundary = text.slice(tailStart, tailStart + 64).search(/\s\S/u);
	const adjustedStart = boundary === -1 ? tailStart : tailStart + boundary + 1;
	const removed = text.slice(0, adjustedStart);
	const removedDigest = createHash("sha256").update(removed).digest("hex").slice(0, 24);
	const marker = `[compacted ${removed.length} chars · sha256:${removedDigest}]\n`;
	return `${marker}${text.slice(adjustedStart)}`;
}
