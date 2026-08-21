import { describe, expect, it } from "vitest";
import {
	cellWidth,
	footerSegmentOrder,
	formatHelpCommandLines,
	formatModelCommandLines,
	formatStatusFooter,
	formatSubmittedPromptTurn,
	formatTranscriptEntry,
	formatTuiActivityLine,
	formatTuiStatusLine,
	layoutTuiFrame,
	orderModelsForPicker,
	parseTuiCommand,
	renderTuiFrame,
	resolveCtrlCAction,
	resolveModelSelection,
	stripAnsi,
	TranscriptViewport,
	type TuiViewState,
	transcriptViewportRows,
} from "../src/tui.ts";

const state: TuiViewState = {
	projectRoot: "/tmp/project",
	provider: "openai-codex",
	model: "gpt-5.6-terra",
	thinkingLevel: "medium",
	contextTokens: 35_000,
	contextLimit: 400_000,
	gitStatus: "dirty",
	activeTasks: 1,
	providerConfigured: true,
	status: "ready",
	input: "로그인 오류를 조사해",
	messages: ["You 로그인 오류를 조사해", "3xhaust 인증 콜백에서 만료 세션 검증 순서를 확인했습니다."],
	queuedRequests: ["진단 결과도 확인해"],
	workspace: {
		projects: [{ path: "/tmp/project", createdAt: "2026-01-01", chatCount: 1, activeChatCount: 0 }],
		chats: [
			{
				id: "session_1234567890",
				status: "completed",
				updatedAt: "2026-01-01",
				objective: "로그인 오류 조사",
			},
		],
		requests: [{ id: "req_1234567890", status: "completed", position: 1 }],
		patches: [{ id: "patch_1234567890", state: "applied", updatedAt: "2026-01-01" }],
	},
};

function visibleLines(output: string): string[] {
	return output.split("\n").map((line) => stripAnsi(line));
}

function expectFrameWithin(output: string, columns: number, rows: number): void {
	const lines = visibleLines(output);
	expect(lines).toHaveLength(rows);
	for (const line of lines) expect(cellWidth(line)).toBeLessThanOrEqual(columns);
}

function expectNoDuplicateIdentity(output: string): void {
	const identity = visibleLines(output)[0] ?? "";
	expect(identity.match(/3xhaustPi/gu) ?? []).toHaveLength(1);
}

describe("Pi-native event-driven TUI renderer", () => {
	it("uses one pure responsive layout contract at required terminal sizes", () => {
		for (const [columns, rows, mode] of [
			[20, 8, "degraded"],
			[32, 10, "degraded"],
			[40, 12, "minimal"],
			[56, 22, "compact"],
			[72, 24, "compact"],
			[120, 32, "wide"],
		] as const) {
			const layout = layoutTuiFrame(columns, rows, { autocompleteRows: 5 });
			expect(layout.columns).toBe(columns);
			expect(layout.rows).toBe(rows);
			expect(layout.mode).toBe(mode);
			expect(layout.composerRows).toBe(3);
			expect(layout.transcriptRows).toBeGreaterThanOrEqual(1);
			expect(layout.totalRows).toBeLessThanOrEqual(rows);
			expect(layout.autocompleteRows).toBeLessThanOrEqual(Math.floor(rows * 0.4));
			expect(layout.transcriptRows + layout.chromeRows + layout.autocompleteRows).toBeLessThanOrEqual(rows);
			if (rows === 12) expect(layout.contextRows).toBe(0);
		}
	});

	it("renders physical bounds and density collapse without synthetic minimum overflow", () => {
		for (const [columns, rows] of [
			[20, 8],
			[32, 10],
			[40, 12],
			[56, 22],
			[72, 24],
			[120, 32],
		] as const) {
			const output = renderTuiFrame({ ...state, projectRoot: "/tmp/3xhaustpi" }, columns, rows, {
				autocompleteRows: 5,
			});
			expectFrameWithin(output, columns, rows);
			expectNoDuplicateIdentity(output);
			expect(output).toContain("›");
			expect(output).toMatch(/ready|working/u);
		}
	});

	it("uses shared chrome budgeting for static frames, live viewport, and autocomplete", () => {
		for (const [columns, rows] of [
			[40, 12],
			[56, 22],
			[72, 24],
			[120, 32],
		] as const) {
			const layout = layoutTuiFrame(columns, rows, { autocompleteRows: 6 });
			const viewport = new TranscriptViewport(
				["assistant ANSI \u001b[38;5;111m色\u001b[0m 한글安全"],
				() => rows,
				() => 6,
			);
			const rendered = viewport.render(columns);
			expect(rendered).toHaveLength(layout.transcriptRows);
			for (const line of rendered) expect(cellWidth(stripAnsi(line))).toBeLessThanOrEqual(columns);
		}
	});

	it("keeps one information authority per rail", () => {
		const output = renderTuiFrame({ ...state, activeTasks: 0 }, 120, 32);
		const lines = visibleLines(output);
		expect(lines[0]).toBe("3xhaustPi  project");
		expect(lines[0]).not.toMatch(/ready|gpt|openai|context|tasks/u);
		expect(lines).toContainEqual(expect.stringContaining("queued  1 waiting"));
		expect(output).toContain("gpt-5.6-terra:medium");
		expect(output).toContain("35K/400K (8.8%)");
		expect(lines.join("\n")).not.toContain("…/project");
		expect(lines.join("\n")).toContain("queue 1 · tasks 0");
	});

	it("uses a deterministic footer segment priority table", () => {
		expect(footerSegmentOrder()).toEqual(["model", "context", "provider", "tasks"]);
		const minimalFooter = visibleLines(renderTuiFrame(state, 40, 12)).at(-1) ?? "";
		expect(minimalFooter).toContain("gpt-5.6-terra:medium");
		expect(minimalFooter).not.toContain("openai-codex");
		const wideFooter = visibleLines(renderTuiFrame(state, 120, 12)).at(-1) ?? "";
		expect(wideFooter).toContain("35K/400K (8.8%)");
		expect(wideFooter).toContain("openai-codex auto");
		expect(wideFooter).not.toContain("…/project");
	});

	it("never admits a lower-priority footer segment after a higher one cannot fit", () => {
		const footer = stripAnsi(formatStatusFooter(state, 26));
		expect(footer).toContain("gpt-5.6-terra:medium");
		expect(footer).not.toContain("openai-codex");
		expect(footer).not.toContain("q1/t1");
	});

	it("has explicit tiny-terminal degradation without losing essential rails", () => {
		const layout = layoutTuiFrame(40, 12, { autocompleteRows: 8 });
		expect(layout.mode).toBe("minimal");
		expect(layout.contextRows).toBe(0);
		expect(layout.identityRows + layout.activityRows + layout.composerRows + layout.footerRows).toBe(6);
		expect(layout.transcriptRows).toBeGreaterThanOrEqual(1);
		expect(layout.autocompleteRows).toBeLessThanOrEqual(4);
	});

	it("formats semantic transcript templates for tool, agent, error, and approval rows", () => {
		expect(formatTranscriptEntry("✓ write_file  12.0 ms · done").role).toBe("tool");
		expect(formatTranscriptEntry("chat  abc123  openai/model").role).toBe("agent");
		expect(formatTranscriptEntry("Error: boom").role).toBe("error");
		expect(formatTranscriptEntry("Patch ready  src/a.ts").role).toBe("approval");
	});

	it("renders user and assistant as separated chat turns without prose rails", () => {
		const output = visibleLines(
			renderTuiFrame(
				{
					...state,
					messages: [
						"You Please inspect the authentication callback and explain why the persisted session is rejected.",
						"3xhaust The callback validates the old session before rotating its token, so expired records fail early.",
					],
					queuedRequests: [],
				},
				48,
				18,
			),
		);
		const userHeader = output.indexOf("you");
		const assistantHeader = output.indexOf("3xhaust", userHeader + 1);
		expect(userHeader).toBeGreaterThanOrEqual(0);
		expect(assistantHeader).toBeGreaterThan(userHeader);
		expect(output[userHeader + 1]).toMatch(/^ {2}Please inspect/u);
		expect(output[assistantHeader + 1]).toMatch(/^ {2}The callback/u);
		expect(output.slice(userHeader, assistantHeader + 2).join("\n")).not.toContain("│");
		expect(output.slice(userHeader + 1, assistantHeader)).toContain("");
	});

	it("never renders an orphaned conversation body when an older turn does not fit", () => {
		const output = visibleLines(
			renderTuiFrame(
				{
					...state,
					messages: ["You first line\nORPHAN_MARKER", "3xhaust latest answer"],
					queuedRequests: [],
				},
				40,
				12,
			),
		).join("\n");
		expect(output).toContain("3xhaust\n  latest answer");
		expect(output).not.toContain("ORPHAN_MARKER");
	});

	it("renders durable system notices as subdued bullets without repeated labels", () => {
		const output = visibleLines(
			renderTuiFrame(
				{
					...state,
					messages: ["A durable notice long enough to wrap cleanly across more than one terminal row."],
					queuedRequests: [],
				},
				36,
				14,
			),
		);
		const notice = output.findIndex((line) => line.startsWith("• A durable notice"));
		expect(notice).toBeGreaterThanOrEqual(0);
		expect(output[notice + 1]).toMatch(/^ {2}wrap cleanly/u);
		expect(output.join("\n")).not.toContain("system │");
	});

	it("nests tool and agent rows without diagnostic-log role rails", () => {
		const output = visibleLines(
			renderTuiFrame(
				{
					...state,
					messages: [
						"3xhaust I’ll inspect the callback.",
						"chat abc123 openai-codex/gpt-5.6-terra",
						"✓ readRanges  42.5 ms · src/tui.ts inspected",
					],
					queuedRequests: [],
				},
				72,
				18,
			),
		).join("\n");
		expect(output).toContain("  ├ chat abc123");
		expect(output).toContain("  └ ✓ readRanges");
		expect(output).not.toContain("agent │");
		expect(output).not.toContain("tool │");
	});

	it("shows a newly queued prompt as one user turn and suppresses an existing duplicate", () => {
		const turns = [
			formatSubmittedPromptTurn("Inspect the callback", true),
			formatSubmittedPromptTurn("Inspect the callback", false),
		].filter((turn): turn is string => turn !== undefined);
		expect(turns).toEqual(["You Inspect the callback"]);
	});

	it("keeps durable queued requests in status rather than duplicating them in the transcript", () => {
		const output = visibleLines(
			renderTuiFrame(
				{
					...state,
					messages: ["You First request"],
					queuedRequests: ["Follow-up request"],
					activeTasks: 0,
				},
				72,
				22,
			),
		).join("\n");
		expect(output).toContain("queued  1 waiting");
		expect(output).not.toContain("Follow-up request");
	});

	it("does not count persisted paused or queued chats as active executions", () => {
		const output = visibleLines(
			renderTuiFrame(
				{
					...state,
					activeTasks: 0,
					workspace: {
						...state.workspace,
						chats: [
							{ ...state.workspace.chats[0]!, status: "paused" },
							{ ...state.workspace.chats[0]!, id: "session_queued", status: "queued" },
						],
					},
				},
				72,
				22,
			),
		).join("\n");
		expect(output).toContain("paused  /resume to continue");
		expect(output).not.toContain("working  2 active");
	});

	it("arbitrates activity by review, failure, foreground work, active aggregate, queue, then ready", () => {
		expect(stripAnsi(formatTuiActivityLine({ status: "awaiting-approval", detail: "patch" }))).toContain(
			"review  patch",
		);
		expect(stripAnsi(formatTuiActivityLine({ status: "error", detail: "diagnostics failed" }))).toContain(
			"failed  diagnostics failed",
		);
		expect(
			stripAnsi(formatTuiActivityLine({ status: "running", detail: "write src/some/really-long-file-name.ts" }, 28)),
		).toMatch(/^working {2}write src\/som…$/u);
		expect(stripAnsi(formatTuiActivityLine({ status: "ready", activeCount: 2, queuedCount: 4 }))).toContain(
			"working  2 active",
		);
		expect(
			stripAnsi(formatTuiActivityLine({ status: "ready", activeCount: 0, queuedCount: 4, resumable: true })),
		).toContain("paused  /resume to continue · 4 queued");
		expect(stripAnsi(formatTuiActivityLine({ status: "ready", queuedCount: 4 }))).toContain("queued  4 waiting");
		expect(stripAnsi(formatTuiActivityLine({ status: "ready" }))).toContain("ready  type a message");
		expect(stripAnsi(formatTuiActivityLine({ status: "ready" }))).not.toContain("›");
	});

	it("defines Ctrl+C as active cancel, idle clear, then consecutive-key exit arm", () => {
		expect(resolveCtrlCAction("draft", true, false)).toBe("cancel-active");
		expect(resolveCtrlCAction("draft", false, false)).toBe("clear-input");
		expect(resolveCtrlCAction("", false, false)).toBe("arm-exit");
		expect(resolveCtrlCAction("", false, true)).toBe("exit");
	});

	it("renders a compact transcript, queue, prompt, and measured workspace status", () => {
		const output = renderTuiFrame(state, 120, 34);
		expect(output).toContain("3xhaustPi");
		expect(output).toContain("3xhaust");
		expect(output).toContain("로그인 오류를 조사해");
		expect(output).not.toContain("진단 결과도 확인해");
		expect(output).toContain("35K/400K (8.8%)");
		expect(output).toContain("auto");
		expect(output).toContain("openai-codex");
		expect(output).toContain("gpt-5.6-terra:medium");
		expect(output).toContain("tasks 1");
		expect(visibleLines(output).at(-1) ?? "").not.toContain("…/project");
		expect(visibleLines(output)[0]).not.toContain("ready");
		expect(output).not.toMatch(/3xhaustPi Native|😺|🤖/u);
	});

	it("keeps the same direct transcript hierarchy in a narrow terminal", () => {
		const output = renderTuiFrame(state, 56, 22);
		expect(output).toContain("인증 콜백에서");
		expect(output).toContain("8.8%");
		expect(output).toContain("3xhaust");
		expect(output).not.toMatch(/not implemented|excluded|skipped|구현하지|제외/u);
	});
	it("bounds the transcript viewport and keeps newest chat content above fixed chrome", () => {
		const noisy = {
			...state,
			messages: Array.from(
				{ length: 80 },
				(_, index) => `assistant ${index + 1} 한국어 응답 내용이 터미널 폭을 넘어가도 안전하게 줄바꿈됩니다`,
			),
		};
		const output = renderTuiFrame(noisy, 72, 24);
		expectFrameWithin(output, 72, 24);
		expect(output).toContain("  80 한국어 응답");
		expect(output).not.toContain("  1 한국어 응답");
		expect(output).toContain("/help");
		expect(output).toContain("/exit");
	});

	it("keeps responsive CJK-safe chrome within 56, 72, and 120 columns", () => {
		const cjkState = {
			...state,
			input: "안녕하세요世界 /model gpt-5.6-terra",
			messages: [
				"사용자 라벨과 assistant 라벨이 보이는 카드",
				"3xhaust 답변: 한글日本語中文 mixed text wraps safely without overflow",
			],
		};
		for (const [columns, rows] of [
			[56, 22],
			[72, 24],
			[120, 32],
		] as const) {
			expectFrameWithin(renderTuiFrame(cjkState, columns, rows), columns, rows);
		}
	});

	it("shows an empty-composer affordance in the reusable status row", () => {
		expect(stripAnsi(formatTuiStatusLine("ready", "", 0))).toContain("ready  type a message or /help");
		expect(formatTuiStatusLine("running", "planning…", 1)).not.toContain("type a message");
	});

	it("renders slash-command help without splitting command tokens at 56 columns", () => {
		for (const columns of [56, 72]) {
			const lines = formatHelpCommandLines(columns);
			for (const line of lines) expect(cellWidth(stripAnsi(line))).toBeLessThanOrEqual(columns - 2);
		}
		const lines = formatHelpCommandLines(56);
		const output = lines.join("\n");
		for (const token of ["/resources", "/clear", "/resume", "/chat <n>", "/mcp tools <server>"] as const) {
			expect(output).toContain(token);
			expect(output).not.toMatch(new RegExp(`${token.slice(0, -1)}\\n${token.slice(-1)}`));
		}
		for (const line of output.split("\n")) expect(cellWidth(stripAnsi(line))).toBeLessThanOrEqual(56);
	});

	it("parses /exit as a testable command", () => {
		expect(parseTuiCommand("/exit")).toEqual({ name: "exit", argument: "" });
		expect(parseTuiCommand("  /model gpt-5.6-terra  ")).toEqual({ name: "model", argument: "gpt-5.6-terra" });
		expect(parseTuiCommand("plain prompt")).toBeUndefined();
	});

	it("lists and selects current-provider models", () => {
		const models = [{ id: "gpt-5.6-terra" }, { id: "gpt-5.6-codex" }];
		expect(formatModelCommandLines(models, "gpt-5.6-terra").join("\n")).toContain("* gpt-5.6-terra");
		expect(resolveModelSelection(models, "gpt-5.6-codex")).toEqual({ ok: true, model: "gpt-5.6-codex" });
		expect(resolveModelSelection(models, "missing")).toEqual({ ok: false, message: "Unknown model: missing" });
	});

	it("orders the active model first in the searchable picker", () => {
		const models = [{ id: "gpt-5.6-luna" }, { id: "gpt-5.6-sol" }, { id: "gpt-5.6-terra" }];
		expect(orderModelsForPicker(models, "gpt-5.6-terra").map(({ id }) => id)).toEqual([
			"gpt-5.6-terra",
			"gpt-5.6-luna",
			"gpt-5.6-sol",
		]);
	});

	it("budgets the live transcript viewport against the actual fixed chrome", () => {
		for (const [columns, rows] of [
			[56, 22],
			[72, 24],
			[120, 32],
		] as const) {
			const entries = Array.from(
				{ length: 80 },
				(_, index) => `assistant ${index + 1} 한국어 응답 내용이 ${columns}열 터미널에서 안전하게 잘립니다`,
			);
			const viewport = new TranscriptViewport(entries, () => rows);
			const rendered = viewport.render(columns);
			const layout = layoutTuiFrame(columns, rows);
			expect(rendered.length + layout.chromeRows).toBeLessThanOrEqual(rows);
			expect(rendered.length).toBe(transcriptViewportRows(rows, 0, columns));
			expect(rendered.join("\n")).toContain("  80 한국어 응답");
			for (const line of rendered) expect(cellWidth(stripAnsi(line))).toBeLessThanOrEqual(columns);
		}
	});

	it("recomputes the live transcript viewport budget on resize without appending", () => {
		let rows = 32;
		const viewport = new TranscriptViewport(
			Array.from({ length: 60 }, (_, index) => `assistant ${index + 1} resize-safe transcript entry`),
			() => rows,
		);
		expect(viewport.render(72)).toHaveLength(transcriptViewportRows(32, 0, 72));
		rows = 24;
		expect(viewport.render(72)).toHaveLength(transcriptViewportRows(24, 0, 72));
	});

	it("keeps fixed chrome row positions unchanged when slash suggestions are overlaid", () => {
		for (const [columns, rows] of [
			[56, 22],
			[72, 24],
			[120, 32],
		] as const) {
			const closed = visibleLines(renderTuiFrame(state, columns, rows));
			const open = visibleLines(renderTuiFrame(state, columns, rows, { autocompleteRows: 6 }));
			for (const needle of ["3xhaustPi", "ready  type a message", "›", "gpt-5.6-terra"] as const) {
				expect(open.findIndex((line) => line.includes(needle))).toBe(
					closed.findIndex((line) => line.includes(needle)),
				);
			}
		}
	});
});
