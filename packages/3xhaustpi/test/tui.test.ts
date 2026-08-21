import { describe, expect, it } from "vitest";
import {
	cellWidth,
	footerSegmentOrder,
	formatHelpCommandLines,
	formatModelCommandLines,
	formatResponseMetrics,
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
	sanitizeTerminalText,
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
			expect(layout.contextRows).toBe(0);
			expect(layout.composerRows).toBe(2);
			expect(layout.footerRows).toBe(0);
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
			expect(output).toContain(">");
			expect(output).toMatch(/Ready|Working/u);
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
		expect(lines[0]).toBe("3xhaustPi: project (gpt-5.6-terra)");
		expect(lines[0]).not.toMatch(/ready|openai|context|tasks/u);
		expect(lines).toContainEqual(expect.stringContaining("• Queued (1 waiting)"));
		expect(lines.join("\n")).not.toContain("…/project");
		expect(lines.at(-2)).toMatch(/^─+$/u);
		expect(lines.at(-1)).toContain("> ");
	});

	it("keeps the model in the wide title instead of a permanent footer", () => {
		expect(footerSegmentOrder()).toEqual(["model", "context", "provider", "tasks"]);
		const minimal = visibleLines(renderTuiFrame(state, 40, 12));
		expect(minimal[0]).toBe("3xhaustPi");
		expect(minimal.at(-1)).toContain("> ");
		const wide = visibleLines(renderTuiFrame(state, 120, 12));
		expect(wide[0]).toContain("(gpt-5.6-terra)");
		expect(wide.at(-1)).toContain("> ");
		expect(wide.join("\n")).not.toContain("openai-codex auto");
	});

	it("removes command hints and provider metadata below sixty columns", () => {
		const output = visibleLines(renderTuiFrame(state, 56, 22));

		expect(output.join("\n")).not.toContain("/help  /model  /exit");
		expect(output[0]).toBe("3xhaustPi: project");
		expect(output.at(-1)).toContain("> ");
		expect(output.join("\n")).not.toContain("openai-codex");
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
		expect(layout.identityRows + layout.activityRows + layout.composerRows + layout.footerRows).toBe(4);
		expect(layout.transcriptRows).toBeGreaterThanOrEqual(1);
		expect(layout.autocompleteRows).toBeLessThanOrEqual(4);
	});

	it("formats semantic transcript templates for tool, agent, error, and approval rows", () => {
		expect(formatTranscriptEntry("✓ write_file  12.0 ms · done").role).toBe("tool");
		expect(formatTranscriptEntry("chat  abc123  openai/model").role).toBe("agent");
		expect(formatTranscriptEntry("Error: boom").role).toBe("error");
		expect(formatTranscriptEntry("Patch ready  src/a.ts").role).toBe("approval");
	});

	it("uses a full-width prompt band and never renders speaker labels", () => {
		const output = renderTuiFrame(
			{
				...state,
				messages: ["You 안녕", "3xhaust 안녕하세요. 무엇을 도와드릴까요?"],
				queuedRequests: [],
			},
			120,
			24,
		);
		const rawLines = output.split("\n");
		const visible = visibleLines(output);
		const promptLine = visible.findIndex((line) => line.includes("안녕"));
		const answerLine = visible.findIndex((line) => line.includes("안녕하세요."));

		expect(promptLine).toBeGreaterThanOrEqual(0);
		expect(rawLines[promptLine]).toContain("\u001b[48;5;238m");
		expect(cellWidth(visible[promptLine] ?? "")).toBe(120);
		expect(answerLine).toBeGreaterThan(promptLine);
		expect(visible[answerLine]).toMatch(/^ {2}안녕하세요/u);
		expect(visible.join("\n")).not.toMatch(/^\s*(?:You|3xhaust)\s*$/gmu);
	});

	it("renders thought work answer and measured metadata as one unlabeled flow", () => {
		const output = visibleLines(
			renderTuiFrame(
				{
					...state,
					messages: [
						"You 설정 파일을 확인해",
						"Thought: 1.2s",
						"✓ readRanges  84.0 ms · settings.json inspected",
						"3xhaust 설정 값은 유효합니다.",
						"Stats: TPS 15.8 tok/s · Cache hit 0.0% · 4.5s",
					],
					queuedRequests: [],
				},
				120,
				26,
			),
		);
		const thought = output.findIndex((line) => line.includes("Thought: 1.2s"));
		const work = output.findIndex((line) => line.includes("settings.json inspected"));
		const answer = output.findIndex((line) => line.includes("설정 값은 유효합니다."));
		const metrics = output.findIndex((line) => line.includes("TPS 15.8 tok/s"));

		expect(thought).toBeGreaterThanOrEqual(0);
		expect(work).toBeGreaterThan(thought);
		expect(answer).toBeGreaterThan(work);
		expect(metrics).toBeGreaterThan(answer);
		expect(output.join("\n")).not.toMatch(/^\s*(?:You|3xhaust)\s*$/gmu);
	});

	it("formats only measured response telemetry without inventing values", () => {
		expect(
			formatResponseMetrics({
				input: 1_000,
				output: 79,
				cacheRead: 250,
				durationMs: 5_000,
			}),
		).toBe("Stats: TPS 15.8 tok/s · Cache hit 25.0% · 5.0s");
		expect(formatResponseMetrics({ input: null, output: null, cacheRead: null, durationMs: 1_200 })).toBe(
			"Stats: 1.2s",
		);
	});

	it("keeps an oversized assistant answer visible when response metrics fit", () => {
		const output = visibleLines(
			renderTuiFrame(
				{
					...state,
					messages: [
						`3xhaust ANSWER_ANCHOR ${"long response content ".repeat(40)}`,
						"Stats: TPS 15.8 tok/s · Cache hit 25.0% · 5.0s",
					],
					queuedRequests: [],
				},
				56,
				10,
			),
		).join("\n");

		expect(output).toContain("ANSWER_ANCHOR");
		expect(output).toContain("TPS 15.8 tok/s");
	});

	it("keeps capability work between the thought phases that produced it", () => {
		const output = visibleLines(
			renderTuiFrame(
				{
					...state,
					messages: [
						"You inspect settings",
						"Thought: 1.0s",
						"✓ searchText  1.5 ms · settings inspected",
						"Thought: 0.8s",
						"3xhaust Settings are valid.",
						"Stats: TPS 12.0 tok/s · 0.8s",
					],
					queuedRequests: [],
				},
				72,
				20,
			),
		);
		const firstThought = output.findIndex((line) => line.includes("Thought: 1.0s"));
		const work = output.findIndex((line) => line.includes("settings inspected"));
		const secondThought = output.findIndex((line) => line.includes("Thought: 0.8s"));
		const answer = output.findIndex((line) => line.includes("Settings are valid."));
		const metrics = output.findIndex((line) => line.includes("TPS 12.0 tok/s"));

		expect(firstThought).toBeLessThan(work);
		expect(work).toBeLessThan(secondThought);
		expect(secondThought).toBeLessThan(answer);
		expect(answer).toBeLessThan(metrics);
	});

	it("shows prompt content instead of surface spacers in a one-row transcript budget", () => {
		const output = visibleLines(
			renderTuiFrame(
				{
					...state,
					messages: ["You VISIBLE_PROMPT"],
					queuedRequests: [],
				},
				120,
				5,
			),
		).join("\n");

		expect(output).toContain("VISIBLE_PROMPT");
	});

	it("removes terminal control sequences from untrusted transcript and activity text", () => {
		const malicious = "safe\u001b]52;c;Y2xpcGJvYXJk\u0007after\u001b[2J\u001b_payload\u001b\\done";

		expect(sanitizeTerminalText(malicious)).toBe("safeafterdone");
		const output = renderTuiFrame(
			{
				...state,
				status: "running",
				activeTasks: 0,
				messages: [`3xhaust ${malicious}`],
				queuedRequests: [],
			},
			72,
			16,
		);
		expect(output).not.toContain("\u001b]52");
		expect(output).not.toContain("\u001b[2J");
		expect(output).not.toContain("Y2xpcGJvYXJk");
		expect(visibleLines(output).join("\n")).toContain("safeafterdone");
		expect(stripAnsi(formatTuiActivityLine({ status: "running", detail: malicious }))).toContain("safeafterdone");
	});

	it("uses one activity row and a top-rule-only shell composer", () => {
		const layout = layoutTuiFrame(72, 24);
		const output = visibleLines(renderTuiFrame({ ...state, status: "running", activeTasks: 0 }, 72, 24));

		expect(layout.contextRows).toBe(0);
		expect(layout.activityRows).toBe(1);
		expect(layout.composerRows).toBe(2);
		expect(layout.footerRows).toBe(0);
		expect(output.at(-3)).toMatch(/^• Working \(/u);
		expect(output.at(-2)).toMatch(/^─+$/u);
		expect(output.at(-1)).toContain("> ");
		expect(output.at(-1)).not.toContain("Ask anything");
	});

	it("separates prompt surface and assistant prose without speaker rails", () => {
		const raw = renderTuiFrame(
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
		);
		const output = visibleLines(raw);
		const prompt = output.findIndex((line) => line.includes("Please inspect"));
		const answer = output.findIndex((line) => line.includes("The callback"));

		expect(prompt).toBeGreaterThanOrEqual(0);
		expect(raw.split("\n")[prompt]).toContain("\u001b[48;5;238m");
		expect(answer).toBeGreaterThan(prompt);
		expect(output[answer]).toMatch(/^ {2}The callback/u);
		expect(output.join("\n")).not.toMatch(/^\s*(?:You|3xhaust)\s*$/gmu);
		expect(output.slice(prompt, answer + 1).join("\n")).not.toContain("│");
	});

	it("keeps post-answer work attached in the same unlabeled flow", () => {
		// Given
		const output = visibleLines(
			renderTuiFrame(
				{
					...state,
					messages: [
						"You Inspect the authentication callback.",
						"3xhaust The expired session is rejected before token rotation.",
						"✓ readRanges  42.5 ms · src/auth.ts inspected",
					],
					queuedRequests: [],
				},
				72,
				18,
			),
		);

		// When
		const prompt = output.findIndex((line) => line.includes("Inspect the authentication callback."));
		const toolRow = output.findIndex((line) => line.includes("✓ readRanges"));
		const answer = output.findIndex((line) => line.includes("The expired session"));

		// Then
		expect(prompt).toBeGreaterThanOrEqual(0);
		expect(answer).toBeGreaterThan(prompt);
		expect(toolRow).toBeGreaterThan(answer);
		expect(output[toolRow]).toMatch(/^ {2}✓ readRanges/u);
		expect(output[answer]).toBe("  The expired session is rejected before token rotation.");
		expect(output.join("\n")).not.toMatch(/[├└]|^\s*(?:You|3xhaust)\s*$/gmu);
	});

	it("places pre-response work immediately before final assistant prose", () => {
		// Given
		const output = visibleLines(
			renderTuiFrame(
				{
					...state,
					messages: [
						"You Read the project summary.",
						"✓ readRanges  0.1 ms · Read 1 disclosed document",
						"3xhaust The project summary is available.",
					],
					queuedRequests: [],
				},
				72,
				18,
			),
		);

		// When
		const toolRow = output.findIndex((line) => line.includes("✓ readRanges"));
		const answer = output.findIndex((line) => line.includes("The project summary is available."));

		// Then
		expect(toolRow).toBeGreaterThanOrEqual(0);
		expect(answer).toBe(toolRow + 1);
		expect(output[answer]).toBe("  The project summary is available.");
		expect(output.join("\n")).not.toMatch(/^\s*3xhaust\s*$/gmu);
	});

	it("shows intermediate work without inventing an assistant label", () => {
		// Given
		const output = visibleLines(
			renderTuiFrame(
				{
					...state,
					messages: ["You Read the project summary.", "✓ readRanges  0.1 ms · Read 1 disclosed document"],
					queuedRequests: [],
				},
				72,
				18,
			),
		);

		// When
		const toolRow = output.findIndex((line) => line.includes("✓ readRanges"));

		// Then
		expect(toolRow).toBeGreaterThanOrEqual(0);
		expect(output[toolRow]).toMatch(/^ {2}✓ readRanges/u);
		expect(output.join("\n")).not.toMatch(/^\s*3xhaust\s*$/gmu);
	});

	it("keeps runtime notices out of the primary transcript when chat turns exist", () => {
		// Given
		const output = visibleLines(
			renderTuiFrame(
				{
					...state,
					messages: [
						"Background recovery completed",
						"You Continue the interrupted task.",
						"3xhaust I restored the last durable checkpoint.",
					],
					queuedRequests: [],
				},
				72,
				18,
			),
		).join("\n");

		// When / Then
		expect(output).toContain("Continue the interrupted task.");
		expect(output).toContain("I restored the last durable checkpoint.");
		expect(output).not.toContain("Background recovery completed");
	});

	it("caps wide chat prose while preserving the terminal gutter", () => {
		// Given
		const output = visibleLines(
			renderTuiFrame(
				{
					...state,
					messages: [`3xhaust ${"compact readable prose ".repeat(16)}`],
					queuedRequests: [],
				},
				120,
				20,
			),
		);

		// When
		const bodyRows = output.filter((line) => line.startsWith("  compact readable prose"));

		// Then
		expect(bodyRows.length).toBeGreaterThan(1);
		for (const line of bodyRows) expect(cellWidth(line)).toBeLessThanOrEqual(98);
		expect(output.join("\n")).not.toMatch(/^\s*3xhaust\s*$/gmu);
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
				8,
			),
		).join("\n");
		expect(output).toContain("  latest answer");
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
		const notice = output.findIndex((line) => line.startsWith("  • A durable notice"));
		expect(notice).toBeGreaterThanOrEqual(0);
		expect(output[notice + 1]).toMatch(/^ {4}wrap cleanly/u);
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
		expect(output).toContain("  chat abc123");
		expect(output).toContain("  ✓ readRanges");
		expect(output).not.toMatch(/[├└]/u);
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
		expect(output).toContain("• Queued (1 waiting)");
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
		expect(output).toContain("• Paused (/resume to continue)");
		expect(output).not.toContain("Working (2 active");
	});

	it("arbitrates activity by review, failure, foreground work, active aggregate, queue, then ready", () => {
		expect(stripAnsi(formatTuiActivityLine({ status: "awaiting-approval", detail: "patch" }))).toBe(
			"• Review (patch)",
		);
		expect(stripAnsi(formatTuiActivityLine({ status: "error", detail: "diagnostics failed" }))).toBe(
			"• Failed (diagnostics failed)",
		);
		expect(
			stripAnsi(formatTuiActivityLine({ status: "running", detail: "write src/some/really-long-file-name.ts" }, 28)),
		).toMatch(/^• Working \(write src\/som… · esc to interrupt\)$/u);
		expect(stripAnsi(formatTuiActivityLine({ status: "ready", activeCount: 2, queuedCount: 4 }))).toBe(
			"• Working (2 active · esc to interrupt)",
		);
		expect(
			stripAnsi(formatTuiActivityLine({ status: "ready", activeCount: 0, queuedCount: 4, resumable: true })),
		).toContain("• Paused (/resume to continue) · 4 queued");
		expect(stripAnsi(formatTuiActivityLine({ status: "ready", queuedCount: 4 }))).toBe("• Queued (4 waiting)");
		expect(stripAnsi(formatTuiActivityLine({ status: "ready" }))).toBe("• Ready");
	});

	it("defines Ctrl+C as active cancel, idle clear, then consecutive-key exit arm", () => {
		expect(resolveCtrlCAction("draft", true, false)).toBe("cancel-active");
		expect(resolveCtrlCAction("draft", false, false)).toBe("clear-input");
		expect(resolveCtrlCAction("", false, false)).toBe("arm-exit");
		expect(resolveCtrlCAction("", false, true)).toBe("exit");
	});

	it("renders the target prompt band, answer flow, title, activity, and composer", () => {
		const output = renderTuiFrame(state, 120, 34);
		expect(output).toContain("3xhaustPi");
		expect(output).toContain("로그인 오류를 조사해");
		expect(output).not.toContain("진단 결과도 확인해");
		expect(visibleLines(output)[0]).toBe("3xhaustPi: project (gpt-5.6-terra)");
		expect(output).toContain("\u001b[48;5;238m");
		expect(visibleLines(output)).toContain("• Working (esc to interrupt)");
		expect(visibleLines(output).at(-1)).toContain("> 로그인 오류를 조사해");
		expect(output).not.toContain("openai-codex");
		expect(output).not.toContain("35K/400K");
		expect(visibleLines(output).join("\n")).not.toMatch(/^\s*(?:You|3xhaust)\s*$/gmu);
		expect(output).not.toMatch(/3xhaustPi Native|😺|🤖/u);
	});

	it("keeps prompt tint and unlabeled answer hierarchy in a narrow terminal", () => {
		const output = renderTuiFrame(state, 56, 22);
		expect(output).toContain("인증 콜백에서");
		expect(output).toContain("\u001b[48;5;238m");
		expect(visibleLines(output).join("\n")).not.toMatch(/^\s*(?:You|3xhaust)\s*$/gmu);
		expect(visibleLines(output).at(-1)).toContain("> 로그인 오류를 조사해");
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
		expect(visibleLines(output).join("\n")).toContain("• Working");
		expect(visibleLines(output).at(-1)).toContain(">");
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

	it("keeps complete CJK chat cards across the full responsive matrix", () => {
		for (const [columns, rows] of [
			[20, 8],
			[32, 10],
			[40, 12],
			[56, 22],
			[72, 24],
			[80, 24],
			[120, 32],
		] as const) {
			// Given
			const output = visibleLines(
				renderTuiFrame(
					{
						...state,
						messages: [
							"You 오래된 요청은 헤더와 본문이 함께 보일 때만 유지됩니다.",
							"3xhaust 최신 응답은 한글日本語中文 혼합 문장을 셀 경계에서 안전하게 줄바꿈합니다.",
						],
						queuedRequests: [],
					},
					columns,
					rows,
				),
			);

			// When
			const rendered = output.join("\n");
			const promptLine = output.findIndex((line) => line.includes("오래된 요청"));
			const answerLine = output.findIndex((line) => line.includes("최신 응답"));
			const olderBodyVisible = rendered.includes("오래된 요청");

			// Then
			expectFrameWithin(output.join("\n"), columns, rows);
			expect(answerLine, `${columns}x${rows} must preserve the latest answer`).toBeGreaterThanOrEqual(0);
			expect(output[answerLine]).toMatch(/^ {2}/u);
			expect(rendered).not.toMatch(/^\s*(?:You|3xhaust)\s*$/gmu);
			if (olderBodyVisible) expect(promptLine).toBeGreaterThanOrEqual(0);
		}
	});

	it("keeps the status row quiet while the composer owns input affordance", () => {
		expect(stripAnsi(formatTuiStatusLine("ready", "", 0))).toBe("• Ready");
		expect(stripAnsi(formatTuiStatusLine("running", "planning…", 1))).toContain(
			"• Working (planning… · esc to interrupt)",
		);
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
			for (const needle of ["3xhaustPi", "• Working", "> 로그인 오류를 조사해"] as const) {
				expect(open.findIndex((line) => line.includes(needle))).toBe(
					closed.findIndex((line) => line.includes(needle)),
				);
			}
		}
	});

	it("reserves covered transcript rows for a bounded autocomplete overlay", () => {
		// Given
		const overlayState = {
			...state,
			messages: Array.from({ length: 20 }, (_, index) => `3xhaust turn ${index + 1}`),
			queuedRequests: [],
		};

		// When
		const closed = visibleLines(renderTuiFrame(overlayState, 72, 24));
		const open = visibleLines(renderTuiFrame(overlayState, 72, 24, { autocompleteRows: 6 }));

		// Then
		const closedTurns = closed.filter((line) => line.includes("turn "));
		const openTurns = open.filter((line) => line.includes("turn "));
		expect(closedTurns.length).toBeGreaterThan(openTurns.length);
		expect(open).toContain("  turn 20");
		for (const needle of ["3xhaustPi", "• Working", "> 로그인 오류를 조사해"] as const) {
			expect(open.findIndex((line) => line.includes(needle))).toBe(
				closed.findIndex((line) => line.includes(needle)),
			);
		}
	});
});
