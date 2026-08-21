const ESC = "\u001b[";

const tone = (code: number, value: string) => `${ESC}38;5;${code}m${value}${ESC}0m`;

export const accent = (value: string) => tone(111, value);
export const text = (value: string) => tone(255, value);
export const muted = (value: string) => tone(245, value);
export const dim = (value: string) => tone(239, value);
export const success = (value: string) => tone(114, value);
export const warning = (value: string) => tone(214, value);
export const failure = (value: string) => tone(203, value);

function readAnsiSequence(value: string): string | undefined {
	if (!value.startsWith(ESC)) return undefined;
	const marker = value.indexOf("m", ESC.length);
	if (marker === -1) return undefined;
	const parameters = value.slice(ESC.length, marker);
	return [...parameters].every((character) => (character >= "0" && character <= "9") || character === ";")
		? value.slice(0, marker + 1)
		: undefined;
}

export function stripAnsi(value: string): string {
	let output = "";
	let index = 0;
	while (index < value.length) {
		const sequence = readAnsiSequence(value.slice(index));
		if (sequence) {
			index += sequence.length;
			continue;
		}
		const character = Array.from(value.slice(index))[0];
		if (!character) break;
		output += character;
		index += character.length;
	}
	return output;
}

export function cellWidth(value: string): number {
	let width = 0;
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (codePoint === 0 || codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) continue;
		if (
			(codePoint >= 0x0300 && codePoint <= 0x036f) ||
			(codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
			(codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
			(codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
			(codePoint >= 0xfe00 && codePoint <= 0xfe0f)
		) {
			continue;
		}
		width +=
			(codePoint >= 0x1100 && codePoint <= 0x115f) ||
			(codePoint >= 0x2329 && codePoint <= 0x232a) ||
			(codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
			(codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
			(codePoint >= 0xf900 && codePoint <= 0xfaff) ||
			(codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
			(codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
			(codePoint >= 0xff00 && codePoint <= 0xff60) ||
			(codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
			(codePoint >= 0x1f300 && codePoint <= 0x1faff)
				? 2
				: 1;
	}
	return width;
}

function clipAnsi(value: string, columns: number): string {
	if (columns <= 0) return "";
	let output = "";
	let width = 0;
	let index = 0;
	let styled = false;
	while (index < value.length) {
		const remaining = value.slice(index);
		const ansi = readAnsiSequence(remaining);
		if (ansi) {
			output += ansi;
			styled = true;
			index += ansi.length;
			continue;
		}
		const character = Array.from(remaining)[0];
		if (!character) break;
		const characterWidth = cellWidth(character);
		if (width + characterWidth > columns) break;
		output += character;
		width += characterWidth;
		index += character.length;
	}
	return styled && !output.endsWith(`${ESC}0m`) ? `${output}${ESC}0m` : output;
}

export function ellipsizeCells(value: string, columns: number): string {
	if (cellWidth(stripAnsi(value)) <= columns) return value;
	if (columns <= 1) return clipAnsi(value, columns);
	return `${clipAnsi(value, columns - 1)}…`;
}

export function frameLine(value: string, columns: number): string {
	return clipAnsi(value, columns);
}
