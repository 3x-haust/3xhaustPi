import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename } from "node:path";
import {
	CombinedAutocompleteProvider,
	type Component,
	Editor,
	ProcessTerminal,
	type SlashCommand,
	Text,
	TUI,
} from "@earendil-works/pi-tui";
import type { CodingTaskEvent, CodingTaskPatchProposal } from "./coding-runtime.ts";
import { collectConnections, renderConnections, useAsideAccount } from "./connections.ts";
import {
	DesktopAccessibilityHost,
	type DesktopAccessibilityObservation,
	type DesktopActionResult,
	type DesktopApplication,
	type DesktopComputerAction,
} from "./desktop-runtime.ts";
import { callMcpTool, listMcpTools } from "./mcp-client.ts";
import { ASSISTANT_DISPLAY_NAME, PRODUCT_DISPLAY_NAME, PRODUCT_MACHINE_NAME } from "./product-identity.ts";
import { createProviderRuntime } from "./provider-runtime.ts";
import { addMcpServer, loadMcpResources, renderResourceHub } from "./resource-hub.ts";
import { ThreeXhaustState, type TuiRequest, type WorkspaceSnapshot } from "./state.ts";
import {
	accent,
	cellWidth,
	dim,
	ellipsizeCells,
	failure,
	frameLine,
	grayscaleShimmer,
	muted,
	sanitizeTerminalText,
	stripAnsi,
	success,
	text,
	warning,
} from "./tui-text.ts";
import { AssistantTranscriptFlow, fitTranscriptCards, formatSubmittedPromptTurn } from "./tui-transcript.ts";

export { cellWidth, sanitizeTerminalText, stripAnsi } from "./tui-text.ts";
export type { TuiTranscriptRole, TuiTranscriptTemplate } from "./tui-transcript.ts";
export { formatSubmittedPromptTurn, formatTranscriptEntry } from "./tui-transcript.ts";

const DEFAULT_PROVIDER = "openai-codex";
const DEFAULT_MODEL = "gpt-5.6-terra";

export interface TuiViewState {
	readonly projectRoot: string;
	readonly model: string;
	readonly provider: string;
	readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	readonly contextTokens?: number;
	readonly contextLimit?: number;
	readonly cacheHitRatio?: number;
	readonly gitStatus?: "clean" | "dirty" | "unavailable";
	readonly activeTasks?: number;
	readonly providerConfigured: boolean;
	readonly status: "ready" | "running" | "awaiting-approval" | "success" | "error";
	readonly input: string;
	readonly messages: readonly string[];
	readonly queuedRequests: readonly string[];
	readonly workspace: WorkspaceSnapshot;
}

export type TuiDensityMode = "degraded" | "minimal" | "compact" | "full" | "wide";

export interface TuiLayoutContract {
	readonly columns: number;
	readonly rows: number;
	readonly mode: TuiDensityMode;
	readonly identityRows: 2;
	readonly contextRows: 0;
	readonly activityRows: 1;
	readonly composerRows: 3;
	readonly footerRows: 0;
	readonly autocompleteRows: number;
	readonly chromeRows: number;
	readonly transcriptRows: number;
	readonly totalRows: number;
}

function densityMode(columns: number): TuiDensityMode {
	if (columns < 40) return "degraded";
	if (columns < 56) return "minimal";
	if (columns < 80) return "compact";
	if (columns < 120) return "full";
	return "wide";
}

export function layoutTuiFrame(
	columns: number,
	rows: number,
	options: { readonly autocompleteRows?: number } = {},
): TuiLayoutContract {
	const width = Math.max(1, Math.floor(columns));
	const height = Math.max(1, Math.floor(rows));
	const mode = densityMode(width);
	const requestedAutocompleteRows = Math.max(0, Math.floor(options.autocompleteRows ?? 0));
	const boundedAutocompleteRows = Math.min(requestedAutocompleteRows, Math.floor(height * 0.4));
	const essentialChromeRows = 6;
	const contextRows = 0;
	const chromeRows = essentialChromeRows;
	const autocompleteRows = Math.min(boundedAutocompleteRows, Math.max(0, height - chromeRows - 1));
	const transcriptRows = Math.max(1, height - chromeRows - autocompleteRows);
	return {
		columns: width,
		rows: height,
		mode,
		identityRows: 2,
		contextRows,
		activityRows: 1,
		composerRows: 3,
		footerRows: 0,
		autocompleteRows,
		chromeRows,
		transcriptRows,
		totalRows: chromeRows + transcriptRows + autocompleteRows,
	};
}

export interface TuiDesktopHost {
	listApplications(signal?: AbortSignal): Promise<{
		readonly trusted: boolean;
		readonly applications: readonly DesktopApplication[];
	}>;
	observe(
		target: { readonly pid: number },
		options?: { readonly signal?: AbortSignal; readonly maxElements?: number },
	): Promise<DesktopAccessibilityObservation>;
	act(
		target: { readonly pid: number },
		action: DesktopComputerAction,
		options?: { readonly signal?: AbortSignal },
	): Promise<DesktopActionResult>;
}

function compactTokens(value: number): string {
	if (value < 1_000) return String(value);
	const thousands = value / 1_000;
	return `${thousands >= 100 || Number.isInteger(thousands) ? thousands.toFixed(0) : thousands.toFixed(1)}K`;
}

export interface TuiResponseMetrics {
	readonly input: number | null;
	readonly output: number | null;
	readonly cacheRead: number | null;
	readonly cacheWrite?: number | null;
	readonly cacheReadHighWater?: number;
	readonly durationMs: number;
}

function seconds(value: number): string {
	return `${(Math.max(0, value) / 1_000).toFixed(1)}s`;
}

export function formatResponseMetrics(metrics: TuiResponseMetrics): string {
	let throughput: string | undefined;
	if (metrics.output !== null && metrics.durationMs > 0) {
		throughput = `TPS ${(metrics.output / (metrics.durationMs / 1_000)).toFixed(1)} tok/s`;
	}
	let cache: string | undefined;
	if (metrics.input !== null && metrics.cacheRead !== null && metrics.cacheRead > 0) {
		const denominator =
			metrics.cacheReadHighWater && metrics.cacheReadHighWater > 0
				? metrics.cacheReadHighWater
				: metrics.input + metrics.cacheRead + (metrics.cacheWrite ?? 0);
		if (denominator > 0) {
			const ratio = Math.min(1, Math.max(0, metrics.cacheRead / denominator));
			cache = `Cache hit ${(ratio * 100).toFixed(1)}%`;
		}
	}
	const duration = seconds(metrics.durationMs);
	if (throughput && cache) return `${throughput}. ${cache}, ${duration}`;
	if (throughput) return `${throughput}, ${duration}`;
	if (cache) return `${cache}, ${duration}`;
	return duration;
}

export interface TuiCommand {
	readonly name: string;
	readonly argument: string;
}

export interface TuiModelLike {
	readonly id: string;
}

export function parseTuiCommand(value: string): TuiCommand | undefined {
	const trimmed = value.trim();
	if (!trimmed.startsWith("/")) return undefined;
	const separator = trimmed.indexOf(" ");
	return {
		name: trimmed.slice(1, separator === -1 ? undefined : separator).toLowerCase(),
		argument: separator === -1 ? "" : trimmed.slice(separator + 1).trim(),
	};
}

export function formatModelCommandLines(models: readonly TuiModelLike[], currentModel: string): string[] {
	if (models.length === 0) return ["No models are available for the current provider."];
	return models.map((candidate) => `${candidate.id === currentModel ? "*" : " "} ${candidate.id}`);
}

export function orderModelsForPicker<T extends TuiModelLike>(models: readonly T[], currentModel: string): T[] {
	return [...models].sort((left, right) => Number(right.id === currentModel) - Number(left.id === currentModel));
}

export function resolveModelSelection(
	models: readonly TuiModelLike[],
	requestedModel: string,
): { readonly ok: true; readonly model: string } | { readonly ok: false; readonly message: string } {
	const selected = models.find((candidate) => candidate.id === requestedModel);
	return selected ? { ok: true, model: selected.id } : { ok: false, message: `Unknown model: ${requestedModel}` };
}

export type TuiFooterSegmentId = "model" | "context" | "tasks" | "provider";

export const TUI_FOOTER_SEGMENT_PRIORITY: readonly {
	readonly id: TuiFooterSegmentId;
	readonly priority: number;
}[] = [
	{ id: "model", priority: 1 },
	{ id: "context", priority: 2 },
	{ id: "provider", priority: 3 },
	{ id: "tasks", priority: 4 },
] as const;

interface FooterSegmentRender {
	readonly id: TuiFooterSegmentId;
	readonly compact: string;
	readonly ideal: string;
}

function footerSegmentRender(id: TuiFooterSegmentId, state: TuiViewState): FooterSegmentRender {
	const used = state.contextTokens ?? 0;
	const limit = state.contextLimit ?? 0;
	const percent = limit > 0 ? `${((used / limit) * 100).toFixed(1)}%` : "ctx —";
	const thinking = state.thinkingLevel ? `:${state.thinkingLevel}` : "";
	if (id === "model") {
		const model = `${state.model}${thinking}`;
		return { id, compact: text(model), ideal: text(model) };
	}
	if (id === "context") {
		return {
			id,
			compact: muted(percent),
			ideal: muted(limit > 0 ? `${compactTokens(used)}/${compactTokens(limit)} (${percent})` : "context —"),
		};
	}
	if (id === "tasks") {
		const tasks = state.activeTasks ?? 0;
		const queue = state.queuedRequests.length;
		return { id, compact: muted(`q${queue}/t${tasks}`), ideal: muted(`queue ${queue} · tasks ${tasks}`) };
	}
	return { id, compact: dim(state.provider), ideal: dim(`${state.provider} auto`) };
}

export function footerSegmentOrder(): readonly TuiFooterSegmentId[] {
	return TUI_FOOTER_SEGMENT_PRIORITY.map((segment) => segment.id);
}

function orderedFooterSegments(state: TuiViewState): readonly FooterSegmentRender[] {
	return [...TUI_FOOTER_SEGMENT_PRIORITY]
		.filter((segment) => segment.id !== "tasks" || (state.activeTasks ?? 0) > 0 || state.queuedRequests.length > 0)
		.sort((left, right) => left.priority - right.priority)
		.map((segment) => footerSegmentRender(segment.id, state));
}

function joinSegments(segments: readonly string[]): string {
	return segments.join(`  ${dim("•")} `);
}

function segmentLineWidth(segments: readonly string[]): number {
	return cellWidth(stripAnsi(joinSegments(segments)));
}

export function formatStatusFooter(state: TuiViewState, columns = 120): string {
	const ordered = orderedFooterSegments(state).filter((segment) => columns >= 60 || segment.id !== "provider");
	const admitted: string[] = [];
	for (const segment of ordered) {
		const next = [...admitted, segment.compact];
		if (segmentLineWidth(next) <= columns || admitted.length === 0) {
			admitted.push(segment.compact);
		} else {
			break;
		}
	}
	const promoted = [...admitted];
	for (const [index, segment] of ordered.entries()) {
		if (index >= promoted.length) break;
		const next = [...promoted];
		next[index] = segment.ideal;
		if (segmentLineWidth(next) <= columns) promoted[index] = segment.ideal;
	}
	return ellipsizeCells(joinSegments(promoted), columns);
}

/**
 * Static renderer used by tests and evidence conversion. The live TUI below uses
 * Pi's differential renderer with the same bounded transcript budgeting.
 */
function compactPath(value: string): string {
	const home = homedir();
	return value.startsWith(home) ? `~${value.slice(home.length)}` : sanitizeTerminalText(value);
}

/**
 * Top status rail: working context on the left (path, cache health, context
 * budget), provider and model identity right-aligned, per the product chrome.
 */
function contextHeaderRail(state: TuiViewState, layout: TuiLayoutContract): string {
	const thinking = state.thinkingLevel ? `:${state.thinkingLevel}` : "";
	if (layout.mode === "degraded" || layout.mode === "minimal") {
		return frameLine(dim(`${sanitizeTerminalText(state.model)}${thinking}`), layout.columns);
	}
	const thinkingSuffix = state.thinkingLevel ? `:${state.thinkingLevel}` : "";
	const right = `${dim(`(${sanitizeTerminalText(state.provider)})`)} ${text(sanitizeTerminalText(state.model))}${dim(thinkingSuffix)}`;
	const path = compactPath(state.projectRoot);
	const pathBudget = Math.max(1, layout.columns - cellWidth(stripAnsi(right)) - 2);
	const compactedPath =
		cellWidth(path) <= pathBudget
			? path
			: `…/${ellipsizeCells(sanitizeTerminalText(basename(state.projectRoot)), Math.max(1, pathBudget - 2))}`;
	const left: string[] = [muted(compactedPath)];
	const used = state.contextTokens;
	const limit = state.contextLimit ?? 0;
	if (used !== undefined && limit > 0) {
		left.push(text(`${compactTokens(used)}/${compactTokens(limit)} (${((used / limit) * 100).toFixed(1)}%)`));
	} else if (limit > 0) {
		left.push(muted(`0/${compactTokens(limit)} (0.0%)`));
	}
	// Adaptive fit: keep the mandatory anchors (path + provider/model), then admit
	// optional segments only while the single-line budget holds.
	let body = "";
	for (const extra of [left.slice(1), []]) {
		body = joinSegments([left[0], ...extra]);
		if (cellWidth(stripAnsi(body)) + cellWidth(stripAnsi(right)) + 2 <= layout.columns) break;
	}
	const gap = Math.max(2, layout.columns - cellWidth(stripAnsi(body)) - cellWidth(stripAnsi(right)));
	return frameLine(`${body}${" ".repeat(gap)}${right}`, layout.columns);
}

/** Brand rail under the status rail: product identity with workspace anchor. */
function identityRail(state: TuiViewState, layout: TuiLayoutContract): string {
	const project = sanitizeTerminalText(basename(state.projectRoot));
	const parts = [`(${accent("😺")} ${text(`${PRODUCT_DISPLAY_NAME} Native`)})`];
	if (project !== PRODUCT_MACHINE_NAME && layout.mode !== "degraded" && layout.mode !== "minimal")
		parts.push(dim(project));
	return frameLine(parts.join(" "), layout.columns);
}

function composerRail(state: TuiViewState, layout: TuiLayoutContract): readonly string[] {
	const rule = accent("─".repeat(layout.columns));
	return [rule, frameLine(`${accent(">")} ${state.input}`, layout.columns), rule];
}

export function transcriptViewportRows(
	rows: number,
	reservedRows = 0,
	columns = process.stdout.columns || 120,
): number {
	return layoutTuiFrame(columns, rows, { autocompleteRows: reservedRows }).transcriptRows;
}

export const TUI_SCROLL_KEYS = {
	pageUp: "\u001b[5~",
	pageDown: "\u001b[6~",
	altUp: "\u001b[1;3A",
	altDown: "\u001b[1;3B",
	altEnd: "\u001b[1;3F",
} as const;

export class TranscriptViewport implements Component {
	private readonly entries: readonly string[];
	private readonly rowsProvider: () => number;
	private readonly reservedRowsProvider: () => number;
	private readonly offsetProvider: () => number;

	constructor(
		entries: readonly string[],
		rowsProvider: () => number = () => process.stdout.rows || 36,
		reservedRowsProvider: () => number = () => 0,
		offsetProvider: () => number = () => 0,
	) {
		this.entries = entries;
		this.rowsProvider = rowsProvider;
		this.reservedRowsProvider = reservedRowsProvider;
		this.offsetProvider = offsetProvider;
	}

	render(width: number): string[] {
		const columns = Math.max(1, width);
		const budget = transcriptViewportRows(this.rowsProvider(), this.reservedRowsProvider(), columns);
		const offset = Math.max(0, Math.floor(this.offsetProvider()));
		let visibleLines: string[];
		if (offset === 0) {
			visibleLines = fitTranscriptCards(this.entries, columns, budget);
		} else {
			const extended = fitTranscriptCards(this.entries, columns, budget + offset);
			const end = Math.max(0, extended.length - offset);
			visibleLines = extended.slice(Math.max(0, end - budget), end);
		}
		return [...Array.from({ length: Math.max(0, budget - visibleLines.length) }, () => ""), ...visibleLines].map(
			(line) => frameLine(line, columns),
		);
	}

	invalidate(): void {}
}

export function renderTuiFrame(
	state: TuiViewState,
	columns = 120,
	rows = 36,
	options: { readonly autocompleteRows?: number } = {},
): string {
	const layout = layoutTuiFrame(columns, rows, options);
	const activity = frameLine(
		formatTuiActivityLine({
			status: state.status,
			queuedCount: state.queuedRequests.length,
			activeCount: state.activeTasks ?? 0,
			resumable: state.workspace.chats.some(
				(chat) => chat.status === "running" || chat.status === "paused" || chat.status === "queued",
			),
		}),
		layout.columns,
	);
	const visibleTranscript = fitTranscriptCards(state.messages, layout.columns, layout.transcriptRows);
	const paddedTranscript = [
		...Array.from({ length: Math.max(0, layout.transcriptRows - visibleTranscript.length) }, () => ""),
		...visibleTranscript,
	];
	const lines = [
		...paddedTranscript,
		...Array.from({ length: layout.autocompleteRows }, () => ""),
		activity,
		...composerRail(state, layout),
		contextHeaderRail(state, layout),
		identityRail(state, layout),
	];
	return lines
		.slice(0, layout.rows)
		.map((line) => frameLine(line, layout.columns))
		.join("\n");
}

function editorTheme() {
	return {
		borderColor: (value: string) => dim(value),
		selectList: {
			selectedPrefix: accent,
			selectedText: (value: string) => `\u001b[7m${value}\u001b[0m`,
			description: muted,
			scrollInfo: muted,
			noMatch: muted,
		},
	};
}

export interface TuiActivityState {
	readonly status: TuiViewState["status"];
	readonly detail?: string;
	readonly animationFrame?: number;
	readonly activeCount?: number;
	readonly queuedCount?: number;
	readonly resumable?: boolean;
	readonly canceled?: boolean;
	readonly detachedNew?: number;
	readonly metrics?: string;
}

function activityDetail(value: string, columns: number): string {
	return ellipsizeCells(sanitizeTerminalText(value).replace(/\s+/gu, " ").trim(), Math.max(1, columns));
}

export function formatTuiActivityLine(state: TuiActivityState, columns = 120): string {
	const line = baseTuiActivityLine(state, columns);
	const detachedNew = state.detachedNew ?? 0;
	if (detachedNew > 0) return `${line} ${dim(`· ↓ ${detachedNew} new · Alt+End latest`)}`;
	return line;
}

function baseTuiActivityLine(state: TuiActivityState, columns: number): string {
	const queuedCount = state.queuedCount ?? 0;
	const activeCount = state.activeCount ?? 0;
	const detail = state.detail ? activityDetail(state.detail, Math.max(8, columns - 14)) : "";
	const bullet = dim("•");
	if (state.status === "awaiting-approval") {
		return `${bullet} ${warning("Review")} ${dim(`(${detail || "approval required"})`)}`;
	}
	if (state.canceled) return `${bullet} ${warning("Canceled")}`;
	if (state.status === "error") return `${bullet} ${failure("Failed")} ${dim(`(${detail || "ready"})`)}`;
	if (state.status === "running" || activeCount > 0) {
		const target = detail || (activeCount > 1 ? `${activeCount} active` : "");
		const suffix = target ? `${target} ${dim("·")} esc to interrupt` : "esc to interrupt";
		if (state.animationFrame !== undefined) {
			return `${bullet} ${grayscaleShimmer(`Working (${stripAnsi(suffix)})`, state.animationFrame)}`;
		}
		return `${bullet} ${text("Working")} ${dim(`(${suffix})`)}`;
	}
	if (state.resumable) {
		const queue = queuedCount > 0 ? ` ${dim("·")} ${queuedCount} queued` : "";
		return `${bullet} ${warning("Paused")} ${dim("(/resume to continue)")}${queue}`;
	}
	if (queuedCount > 0) return `${bullet} ${muted("Queued")} ${dim(`(${queuedCount} waiting)`)}`;
	return state.metrics ? muted(activityDetail(state.metrics, columns)) : "";
}

export function formatTuiStatusLine(
	status: TuiViewState["status"],
	detail: string,
	queuedCount: number,
	activeCount = 0,
): string {
	return formatTuiActivityLine({ status, detail, queuedCount, activeCount });
}

export type TuiCtrlCAction = "clear-input" | "exit";

export function resolveCtrlCAction(inputText: string): TuiCtrlCAction {
	if (inputText) return "clear-input";
	return "exit";
}

const HELP_COMMAND_GROUPS = [
	["/new", "/model [id]", "/resume [n]", "/exit"],
	["/projects", "/project <n>", "/chats", "/chat <n>", "/queue"],
	["/accounts", "/resources", "/clear"],
	["/skill create <name>"],
	["/mcp add <name> <command>", "/mcp tools <server>", "/mcp call <server> <tool> [json]"],
	["/computer apps", "/computer observe <app>", "/computer click <element>"],
] as const;

export function formatHelpCommandLines(columns = 120): string[] {
	const width = Math.max(1, columns - cellWidth("• "));
	const lines = [text("Commands")];
	for (const group of HELP_COMMAND_GROUPS) {
		let line = "";
		for (const token of group) {
			const next = line ? `${line}  ${dim("•")} ${token}` : token;
			if (cellWidth(stripAnsi(next)) > width && line) {
				lines.push(dim(line));
				line = token;
			} else {
				line = next;
			}
		}
		if (line) lines.push(dim(line));
	}
	return lines.map((line) => frameLine(line, width));
}

export async function runTui(input: {
	readonly projectRoot: string;
	readonly statePath?: string;
	readonly provider?: string;
	readonly model?: string;
	readonly thinkingLevel?: TuiViewState["thinkingLevel"];
	readonly contextLimit?: number;
	readonly providerConfigured?: boolean;
	readonly desktopHost?: TuiDesktopHost;
	readonly runTask: (
		projectRoot: string,
		objective: string,
		hooks: {
			readonly onEvent: (event: CodingTaskEvent) => void;
			readonly requestApproval: (proposal: CodingTaskPatchProposal) => Promise<boolean>;
			readonly signal: AbortSignal;
		},
		selectedModel: { readonly provider: string; readonly model: string; readonly sessionId?: string },
	) => Promise<unknown>;
	readonly resumeTask: (
		projectRoot: string,
		sessionId: string | undefined,
		hooks: {
			readonly onEvent: (event: CodingTaskEvent) => void;
			readonly requestApproval: (proposal: CodingTaskPatchProposal) => Promise<boolean>;
			readonly signal: AbortSignal;
		},
	) => Promise<unknown | undefined>;
}): Promise<void> {
	let provider = input.provider ?? DEFAULT_PROVIDER;
	let model = input.model ?? DEFAULT_MODEL;
	const thinkingLevel = input.thinkingLevel;
	const desktopHost = input.desktopHost ?? new DesktopAccessibilityHost();
	let projectRoot = input.projectRoot;
	const database = new ThreeXhaustState(input.statePath);
	database.recoverInterruptedTuiRequests(projectRoot);
	let workspace: WorkspaceSnapshot = { projects: [], chats: [], requests: [], patches: [] };
	const refreshWorkspace = () => {
		workspace = database.inspectWorkspace(projectRoot);
	};
	refreshWorkspace();
	const providerConfigured = input.providerConfigured ?? false;
	const ui = new TUI(new ProcessTerminal());
	const transcriptEntries: string[] = [];
	const status = new Text("", 0, 0);
	const editor = new Editor(ui, editorTheme(), {
		paddingX: 1,
		autocompletePresentation: "overlay",
		promptPrefix: `${accent(">")} `,
		bottomBorder: false,
		maxVisibleLines: 1,
		submitSlashArgumentCompletions: true,
	});
	const scrollOffset = { value: 0 };
	let detachedNewCount = 0;
	const transcript = new TranscriptViewport(
		transcriptEntries,
		() => process.stdout.rows || 36,
		() => 0,
		() => scrollOffset.value,
	);
	let queuedRequests: readonly TuiRequest[] = database
		.listTuiRequests(projectRoot)
		.filter((request) => request.status === "queued");
	let phase: TuiViewState["status"] = "ready";
	let approvalResolve: ((approved: boolean) => void) | undefined;
	let approvalKind: "patch" | "computer" | undefined;
	let activeController: AbortController | undefined;
	let activeExecution: Promise<void> | undefined;
	let desktopController: AbortController | undefined;
	let desktopOperation: Promise<void> | undefined;
	let desktopApplications: readonly DesktopApplication[] = [];
	let desktopObservation: DesktopAccessibilityObservation | undefined;
	let activeTuiRequestId: string | undefined;
	let activeTuiRequestHandedOff = false;
	let active = true;
	let canceledActive = false;
	const agentSessionIds = new Map<string, string>();
	let finish!: () => void;
	const closed = new Promise<void>((resolve) => {
		finish = resolve;
	});

	let latestContextTokens: number | undefined;
	let latestCacheHitRatio: number | undefined;
	let latestMetricsLine: string | undefined;
	let metricsScope: string | undefined;
	let cacheReadHighWater = 0;
	let workAnimationFrame = 0;
	const workMotionEnabled =
		process.env.NO_COLOR === undefined && process.env.TERM !== "dumb" && process.env.REDUCE_MOTION !== "1";
	const chromeState = (): TuiViewState => ({
		projectRoot,
		provider,
		model,
		thinkingLevel,
		contextTokens: latestContextTokens,
		contextLimit: input.contextLimit,
		cacheHitRatio: latestCacheHitRatio,
		providerConfigured,
		status: phase,
		input: editor.getText(),
		messages: [],
		queuedRequests: queuedRequests.map(({ objective }) => objective),
		workspace,
	});

	const header = new Text("", 0, 0);
	const brand = new Text("", 0, 0);
	const divider = new Text("", 0, 0);
	const updateHeader = () => {
		const layout = layoutTuiFrame(process.stdout.columns || 120, process.stdout.rows || 36);
		header.setText(contextHeaderRail(chromeState(), layout));
		brand.setText(identityRail(chromeState(), layout));
		divider.setText(accent("─".repeat(layout.columns)));
	};
	updateHeader();
	ui.addChild(transcript);
	ui.addChild(status);
	ui.addChild(editor);
	ui.addChild(divider);
	ui.addChild(header);
	ui.addChild(brand);

	const viewportHeight = () => transcriptViewportRows(process.stdout.rows || 36, 0, process.stdout.columns || 120);
	const followTranscript = () => {
		scrollOffset.value = 0;
		detachedNewCount = 0;
	};
	const baseEditorHandleInput = editor.handleInput.bind(editor);
	editor.handleInput = (data: string) => {
		if (data === TUI_SCROLL_KEYS.pageUp) {
			scrollOffset.value += viewportHeight();
		} else if (data === TUI_SCROLL_KEYS.altUp) {
			scrollOffset.value += 1;
		} else if (data === TUI_SCROLL_KEYS.pageDown || data === TUI_SCROLL_KEYS.altDown) {
			scrollOffset.value = Math.max(
				0,
				scrollOffset.value - (data === TUI_SCROLL_KEYS.pageDown ? viewportHeight() : 1),
			);
		} else if (data === TUI_SCROLL_KEYS.altEnd) {
			followTranscript();
		} else {
			baseEditorHandleInput(data);
			return;
		}
		updateChrome();
	};
	const activeTaskCount = () => (activeExecution ? 1 : 0) + (desktopOperation ? 1 : 0);
	const hasResumableChat = () =>
		workspace.chats.some((chat) => chat.status === "running" || chat.status === "paused" || chat.status === "queued");
	const updateChrome = (detail = "") => {
		status.setText(
			formatTuiActivityLine(
				{
					status: phase,
					detail,
					queuedCount: queuedRequests.length,
					activeCount: activeTaskCount(),
					resumable: hasResumableChat(),
					canceled: canceledActive,
					detachedNew: detachedNewCount,
					metrics: latestMetricsLine,
					...(workMotionEnabled && (phase === "running" || activeTaskCount() > 0)
						? { animationFrame: workAnimationFrame }
						: {}),
				},
				process.stdout.columns || 120,
			),
		);
		updateHeader();
		ui.requestRender();
	};
	const workAnimationTimer = workMotionEnabled
		? setInterval(() => {
				if (phase !== "running" && activeTaskCount() === 0) return;
				workAnimationFrame = (workAnimationFrame + 1) % 8;
				updateChrome();
			}, 120)
		: undefined;
	workAnimationTimer?.unref();
	const refreshQueue = () => {
		queuedRequests = database.listTuiRequests(projectRoot).filter((request) => request.status === "queued");
		updateChrome();
	};
	const appendText = (value: string) => {
		if (scrollOffset.value > 0) detachedNewCount += 1;
		transcriptEntries.push(value);
		while (transcriptEntries.length > 180) transcriptEntries.shift();
		ui.requestRender();
	};
	const appendUser = (objective: string, inserted = true) => {
		const turn = formatSubmittedPromptTurn(objective, inserted);
		if (turn) appendText(turn);
	};
	const appendPatch = (proposal: CodingTaskPatchProposal) => {
		appendText(`${warning("Patch ready")} ${proposal.files.join(", ")}`);
		for (const line of proposal.diff.split("\n").slice(0, 16)) appendText(line);
		appendText(warning("Press y to apply · n to reject"));
	};
	const assistantFlow = new AssistantTranscriptFlow(
		(entry) => {
			appendText(entry);
			return transcriptEntries.length - 1;
		},
		(index, entry) => {
			const current = transcriptEntries[index];
			if (current === undefined || !current.startsWith(`${ASSISTANT_DISPLAY_NAME} `)) {
				appendText(entry);
				return;
			}
			transcriptEntries[index] = entry;
			ui.requestRender();
		},
	);

	updateChrome();

	const onTaskEvent = (event: CodingTaskEvent) => {
		if (event.type === "session.started") {
			const nextMetricsScope = `${event.sessionId}\u0000${event.provider}\u0000${event.model}`;
			if (metricsScope !== nextMetricsScope) {
				metricsScope = nextMetricsScope;
				cacheReadHighWater = 0;
				latestCacheHitRatio = undefined;
			}
			provider = event.provider;
			model = event.model;
			agentSessionIds.set(projectRoot, event.sessionId);
			updateChrome();
			if (activeTuiRequestId && !activeTuiRequestHandedOff) {
				database.completeTuiRequest(activeTuiRequestId, "completed");
				activeTuiRequestHandedOff = true;
				refreshQueue();
			}
		} else if (event.type === "model.completed") {
			if (event.usage.input !== null) latestContextTokens = event.usage.input;
			cacheReadHighWater = Math.max(cacheReadHighWater, event.usage.cacheRead ?? 0);
			latestMetricsLine = formatResponseMetrics({
				...event.usage,
				cacheReadHighWater,
				durationMs: event.durationMs,
			});
			if (event.usage.input !== null && event.usage.cacheRead !== null && event.usage.cacheRead > 0) {
				if (cacheReadHighWater > 0) {
					latestCacheHitRatio = Math.min(1, Math.max(0, event.usage.cacheRead / cacheReadHighWater));
				}
			} else {
				latestCacheHitRatio = undefined;
			}
		} else if (event.type === "capability.started") {
			updateChrome(`${event.capability}…`);
		} else if (event.type === "capability.completed") {
			appendText(
				`${event.success ? success("✓") : failure("×")} ${text(event.capability)}  ${muted(
					`${event.durationMs.toFixed(1)} ms · ${event.summary}`,
				)}`,
			);
		} else if (event.type === "patch.proposed") {
			refreshWorkspace();
			phase = "awaiting-approval";
			appendPatch(event);
			updateChrome(`${event.files.length} file${event.files.length === 1 ? "" : "s"}`);
		} else if (event.type === "diagnostics.completed") {
			appendText(
				`${event.success ? success("✓") : failure("×")} ${text(event.command)}  ${muted(
					`${event.durationMs.toFixed(1)} ms`,
				)}`,
			);
		} else if (event.type === "assistant.delta") {
			assistantFlow.delta(event.text);
		} else if (event.type === "assistant.message") {
			assistantFlow.complete(event.text);
		}
	};
	const requestApproval = (_proposal: CodingTaskPatchProposal): Promise<boolean> =>
		new Promise((resolve) => {
			approvalResolve = resolve;
			approvalKind = "patch";
			phase = "awaiting-approval";
			updateChrome("y apply · n reject");
		});

	const execute = async (request: TuiRequest | undefined, resumeSessionId: string | undefined) => {
		const resume = resumeSessionId !== undefined;
		const previousPatchId = workspace.patches[0]?.id;
		phase = "running";
		canceledActive = false;
		latestMetricsLine = undefined;
		activeTuiRequestId = request?.id;
		activeTuiRequestHandedOff = false;
		assistantFlow.reset();
		activeController = new AbortController();
		if (resume) appendUser(`/resume ${resumeSessionId === "" ? "" : resumeSessionId.slice(-8)}`.trim());
		updateChrome(resume ? "recovering…" : "planning…");
		try {
			const hooks = {
				onEvent: onTaskEvent,
				requestApproval,
				signal: activeController.signal,
			};
			const result = resume
				? await input.resumeTask(projectRoot, resumeSessionId || undefined, hooks)
				: await input.runTask(projectRoot, request?.objective ?? "", hooks, {
						provider,
						model,
						...(agentSessionIds.get(projectRoot) ? { sessionId: agentSessionIds.get(projectRoot) } : {}),
					});
			if (resume && result === undefined) {
				phase = "ready";
				appendText(muted("No durable checkpoint is available."));
				return;
			}
			refreshWorkspace();
			const applied = workspace.patches[0]?.id !== previousPatchId && workspace.patches[0]?.state === "applied";
			phase = applied ? "success" : "ready";
			if (applied) appendText(success("✓ Patch applied and diagnostics passed"));
		} catch (error) {
			if (request && !activeTuiRequestHandedOff) {
				database.completeTuiRequest(request.id, "failed");
			}
			refreshWorkspace();
			if (!canceledActive) appendText(failure(`Error: ${error instanceof Error ? error.message : String(error)}`));
			phase = "ready";
		} finally {
			activeController = undefined;
			activeTuiRequestId = undefined;
			activeTuiRequestHandedOff = false;
			approvalResolve = undefined;
			approvalKind = undefined;
			canceledActive = false;
			refreshQueue();
			updateChrome();
		}
	};

	const drainQueue = () => {
		if (!active || activeExecution || (phase !== "ready" && phase !== "success")) return;
		refreshWorkspace();
		if (hasResumableChat()) {
			updateChrome();
			return;
		}
		const next = database.claimNextTuiRequest(projectRoot);
		if (!next) {
			refreshQueue();
			return;
		}
		refreshQueue();
		const execution = execute(next, undefined);
		activeExecution = execution;
		void execution.finally(() => {
			if (activeExecution === execution) activeExecution = undefined;
			updateChrome();
			if (!active) finish();
			else drainQueue();
		});
	};
	const startResume = (sessionId?: string) => {
		if (!active || activeExecution) return;
		const execution = execute(undefined, sessionId ?? "");
		activeExecution = execution;
		void execution.finally(() => {
			if (activeExecution === execution) activeExecution = undefined;
			updateChrome();
			if (!active) finish();
			else drainQueue();
		});
	};
	const projectEntries = () => [
		{
			path: projectRoot,
			createdAt: "",
			chatCount: workspace.chats.length,
			activeChatCount: workspace.chats.filter(
				(chat) => chat.status === "running" || chat.status === "paused" || chat.status === "queued",
			).length,
		},
		...workspace.projects.filter((project) => project.path !== projectRoot),
	];
	const resolveProject = (selector: string) => {
		const projects = projectEntries();
		const numeric = Number.parseInt(selector, 10);
		if (String(numeric) === selector && numeric >= 1) return projects[numeric - 1];
		const normalized = selector.toLowerCase();
		const matches = projects.filter(
			(project) =>
				project.path.toLowerCase() === normalized ||
				basename(project.path).toLowerCase() === normalized ||
				project.path.toLowerCase().endsWith(normalized),
		);
		return matches.length === 1 ? matches[0] : undefined;
	};
	const resolveChat = (selector: string) => {
		const numeric = Number.parseInt(selector, 10);
		if (String(numeric) === selector && numeric >= 1) return workspace.chats[numeric - 1];
		const normalized = selector.toLowerCase();
		const matches = workspace.chats.filter(
			(chat) =>
				chat.id.toLowerCase() === normalized ||
				chat.id.toLowerCase().endsWith(normalized) ||
				chat.objective.toLowerCase().includes(normalized),
		);
		return matches.length === 1 ? matches[0] : undefined;
	};
	const showProjects = () => {
		refreshWorkspace();
		appendText(text("Projects"));
		for (const [index, project] of projectEntries().entries()) {
			const current = project.path === projectRoot ? accent("●") : dim("○");
			appendText(
				`${current} ${index + 1}  ${text(basename(project.path))}  ${muted(
					`${project.chatCount} chats${project.activeChatCount ? ` · ${project.activeChatCount} active` : ""}`,
				)}`,
			);
		}
		appendText(dim("Use /project <number or name> to switch."));
	};
	const showChats = () => {
		refreshWorkspace();
		appendText(`${text("Chats")}  ${muted(basename(projectRoot))}`);
		if (workspace.chats.length === 0) {
			appendText(dim("No chats yet. Send a prompt to start one."));
			return;
		}
		for (const [index, chat] of workspace.chats.entries()) {
			const state =
				chat.status === "completed"
					? success(chat.status)
					: chat.status === "failed"
						? failure(chat.status)
						: warning(chat.status);
			appendText(`${index + 1}  ${state}  ${text(chat.objective)}  ${dim(chat.id.slice(-8))}`);
		}
		appendText(dim("Use /chat <number> to inspect or /resume <number> to recover."));
	};
	const showConnections = async (argument = "") => {
		const use = /^use\s+(u\d+)$/u.exec(argument);
		if (use?.[1]) useAsideAccount(use[1]);
		const inventory = await collectConnections();
		for (const line of renderConnections(inventory).split("\n")) appendText(line || " ");
		appendText(dim("Use /accounts use <id> to select the default Aside account."));
	};
	const showResources = async () => {
		const { loadHarnessResources } = await import("./resource-loader.ts");
		const resources = loadHarnessResources({ projectRoot });
		const output = renderResourceHub({
			skills: resources.skills.map((skill) => ({
				id: skill.id,
				label: skill.name,
				scope: skill.scope,
				state: "enabled",
			})),
			mcpServers: loadMcpResources({ projectRoot }),
			hooks: resources.entries
				.filter((entry) => entry.kind === "hook")
				.map((entry) => ({
					id: entry.id,
					label: entry.reason ?? entry.sourcePath,
					scope: entry.scope,
					state: entry.state,
				})),
		});
		for (const line of output.split("\n")) appendText(line || " ");
		appendText(
			dim(
				"Add: /skill create <name>  ·  /mcp add <name> <command> [args...]  ·  /mcp tools <server>  ·  /mcp call <server> <tool> [json]",
			),
		);
	};
	const resolveDesktopApplication = (selector: string) => {
		const numeric = Number.parseInt(selector, 10);
		if (String(numeric) === selector && numeric >= 1) return desktopApplications[numeric - 1];
		const normalized = selector.toLowerCase();
		const matches = desktopApplications.filter(
			(application) =>
				application.name.toLowerCase() === normalized || application.bundleId.toLowerCase() === normalized,
		);
		return matches.length === 1 ? matches[0] : undefined;
	};
	const refreshDesktopApplications = async (signal: AbortSignal) => {
		const result = await desktopHost.listApplications(signal);
		if (!result.trusted) throw new Error("macOS Accessibility permission is required for Computer Use.");
		desktopApplications = result.applications;
		appendText(text("Computer Use"));
		if (desktopApplications.length === 0) appendText(dim("No accessible GUI applications are running."));
		for (const [index, application] of desktopApplications.entries()) {
			appendText(
				`${application.active ? success("●") : dim("○")} ${index + 1}  ${text(application.name)}  ${dim(
					application.bundleId,
				)}`,
			);
		}
		appendText(dim("Use /computer observe <number> to inspect accessibility elements."));
	};
	const runComputerCommand = async (argument: string, signal: AbortSignal) => {
		const [operation = "apps", selector = ""] = argument.split(/\s+/u).filter(Boolean);
		if (operation === "apps") {
			await refreshDesktopApplications(signal);
			return;
		}
		if (operation === "observe") {
			if (desktopApplications.length === 0) await refreshDesktopApplications(signal);
			const application = resolveDesktopApplication(selector);
			if (!application) throw new Error(`Desktop application not found or ambiguous: ${selector || "(empty)"}`);
			const observation = await desktopHost.observe({ pid: application.pid }, { signal, maxElements: 96 });
			desktopObservation = observation;
			appendText(
				`${text(observation.application.name)}  ${muted(
					`${observation.elements.length} elements · ${observation.durationMs.toFixed(0)} ms`,
				)}`,
			);
			for (const [index, element] of observation.elements.slice(0, 40).entries()) {
				appendText(`${index + 1}  ${dim(element.role)}  ${text(element.name)}`);
			}
			if (observation.elements.length > 40) {
				appendText(dim(`${observation.elements.length - 40} more elements omitted from the transcript.`));
			}
			appendText(dim("Use /computer click <element number> for a reviewed semantic action."));
			return;
		}
		if (operation !== "click") {
			throw new Error("Use /computer, /computer observe <app>, or /computer click <element>.");
		}
		if (!desktopObservation) throw new Error("Observe an application before selecting an element.");
		const elementIndex = Number.parseInt(selector, 10);
		const element =
			String(elementIndex) === selector && elementIndex >= 1
				? desktopObservation.elements[elementIndex - 1]
				: undefined;
		if (!element) throw new Error(`Accessibility element not found: ${selector || "(empty)"}`);
		if (element.role !== "button" && element.role !== "link" && element.role !== "menu-item") {
			throw new Error(`${element.role} does not support a reviewed semantic click.`);
		}
		phase = "awaiting-approval";
		appendText(warning(`Computer action ready  ·  click ${element.role} “${element.name}”`));
		appendText(warning("Press y to run · n to reject"));
		updateChrome("review Computer Use action");
		const approved = await new Promise<boolean>((resolve) => {
			approvalResolve = resolve;
			approvalKind = "computer";
		});
		if (!approved) {
			phase = "ready";
			appendText(warning("Computer action rejected"));
			return;
		}
		phase = "running";
		updateChrome("running semantic action…");
		const result = await desktopHost.act(
			{ pid: desktopObservation.application.pid },
			{
				action: "click",
				target: { ...element, observationDigest: desktopObservation.digest },
				button: "left",
			},
			{ signal },
		);
		phase = "ready";
		appendText(`${success("✓")} Computer action completed  ${muted(`${result.durationMs.toFixed(1)} ms`)}`);
	};
	const startComputerCommand = (argument: string) => {
		if (desktopOperation) {
			appendText(warning("A Computer Use operation is already active."));
			return;
		}
		if (activeExecution) {
			appendText(warning("Finish the active coding task before using Computer Use."));
			return;
		}
		desktopController = new AbortController();
		const operation = runComputerCommand(argument, desktopController.signal)
			.catch((cause) => {
				phase = "error";
				appendText(failure(`Computer Use: ${cause instanceof Error ? cause.message : String(cause)}`));
			})
			.finally(() => {
				desktopController = undefined;
				desktopOperation = undefined;
				if (phase === "error") phase = "ready";
				updateChrome();
				if (!active && !activeExecution) finish();
			});
		desktopOperation = operation;
	};
	const requestExit = () => {
		active = false;
		activeController?.abort();
		desktopController?.abort();
		if (approvalResolve) {
			const resolve = approvalResolve;
			approvalResolve = undefined;
			approvalKind = undefined;
			resolve(false);
		}
		ui.stop();
		process.exitCode = 0;
		if (!activeExecution && !desktopOperation) finish();
	};
	const currentProviderModels = () => createProviderRuntime().getModels(provider);
	const installAutocomplete = () => {
		const commands: SlashCommand[] = [
			{ name: "new", description: "Start a new chat" },
			{
				name: "model",
				argumentHint: "[id]",
				description: "List or select current-provider models",
				getArgumentCompletions: () =>
					orderModelsForPicker(currentProviderModels(), model).map((candidate) => ({
						value: candidate.id,
						label: candidate.id,
						description: candidate.id === model ? "current" : provider,
					})),
			},
			{ name: "exit", description: "Abort active work and quit" },
			{ name: "projects", description: "List known projects" },
			{
				name: "project",
				argumentHint: "<project>",
				description: "Switch project",
				getArgumentCompletions: () =>
					projectEntries().map((project, index) => ({
						value: String(index + 1),
						label: `${index + 1}  ${basename(project.path)}`,
						description: `${project.chatCount} chats`,
					})),
			},
			{ name: "chats", description: "List chats in this project" },
			{
				name: "chat",
				argumentHint: "<chat>",
				description: "Inspect a chat",
				getArgumentCompletions: () =>
					workspace.chats.map((chat, index) => ({
						value: String(index + 1),
						label: `${index + 1}  ${chat.objective}`,
						description: `${chat.status} · ${chat.id.slice(-8)}`,
					})),
			},
			{
				name: "resume",
				argumentHint: "[chat]",
				description: "Resume the latest or selected interrupted chat",
				getArgumentCompletions: () =>
					workspace.chats
						.filter((chat) => chat.status === "paused" || chat.status === "failed" || chat.status === "queued")
						.map((chat) => ({
							value: chat.id,
							label: chat.objective,
							description: `${chat.status} · ${chat.id.slice(-8)}`,
						})),
			},
			{ name: "queue", description: "Show durable follow-ups" },
			{ name: "accounts", argumentHint: "[use <id>]", description: "Show and select connected accounts" },
			{ name: "resources", description: "Show Skills, MCP servers, and Hooks" },
			{ name: "skill", argumentHint: "create <name>", description: "Create a project skill template" },
			{
				name: "mcp",
				argumentHint: "add <name> <command> [args...] | tools <server> | call <server> <tool> [json]",
				description: "Use MCP servers",
			},
			{
				name: "computer",
				argumentHint: "[apps | observe <app> | click <element>]",
				description: "Observe or run a reviewed semantic desktop action",
			},
			{ name: "clear", description: "Clear the visible transcript" },
			{ name: "help", description: "Show TUI commands" },
		];
		editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, projectRoot));
	};
	installAutocomplete();
	editor.onSubmit = async (value) => {
		const objective = value.trim();
		if (!objective) return;
		followTranscript();
		editor.addToHistory(objective);
		editor.setText("");
		const parsedCommand = parseTuiCommand(objective);
		if (parsedCommand) {
			const { name: command, argument } = parsedCommand;
			if (command === "exit") {
				appendText(muted("Exiting."));
				requestExit();
				return;
			}
			if (command === "model") {
				if (!argument) {
					editor.setText("/model ");
					editor.handleInput("\t");
					return;
				}
				const selection = resolveModelSelection(currentProviderModels(), argument);
				if (!selection.ok) {
					appendText(warning(selection.message));
					return;
				}
				model = selection.model;
				updateChrome(`model ${model}`);
				installAutocomplete();
				appendText(`${success("✓")} model ${text(model)}`);
				return;
			}
			if (command === "help") {
				appendText(formatHelpCommandLines(process.stdout.columns || 120).join("\n"));
				return;
			}
			if (command === "accounts") {
				void showConnections(argument).catch((cause) =>
					appendText(failure(cause instanceof Error ? cause.message : String(cause))),
				);
				return;
			}
			if (command === "resources") {
				void showResources().catch((cause) =>
					appendText(failure(cause instanceof Error ? cause.message : String(cause))),
				);
				return;
			}
			if (command === "skill") {
				const match = /^create\s+([a-z0-9][a-z0-9._-]{0,63})$/u.exec(argument);
				if (!match?.[1]) {
					appendText(warning("Usage: /skill create <name>"));
					return;
				}
				try {
					const { createSkillTemplate } = await import("./resource-loader.ts");
					const created = createSkillTemplate({ projectRoot, name: match[1], scope: "project" });
					appendText(`${success("✓")} Created ${text(created.path)}`);
				} catch (cause) {
					appendText(failure(cause instanceof Error ? cause.message : String(cause)));
				}
				return;
			}
			if (command === "mcp") {
				const parts = argument.split(/\s+/u).filter(Boolean);
				try {
					if (parts[0] === "add" && parts[1] && parts[2]) {
						const path = addMcpServer({
							projectRoot,
							id: parts[1],
							command: parts[2],
							args: parts.slice(3),
							scope: "project",
						});
						appendText(`${success("✓")} Added ${text(parts[1])} to ${muted(path)}`);
						return;
					}
					if (parts[0] === "tools" && parts[1] && parts.length === 2) {
						const tools = await listMcpTools({ projectRoot, server: parts[1] });
						appendText(text(`MCP tools ${parts[1]}`));
						if (tools.length === 0) appendText(dim("No tools."));
						for (const tool of tools) appendText(`${text(tool.name)}  ${muted(tool.description ?? "")}`);
						return;
					}
					if (parts[0] === "call" && parts[1] && parts[2] && parts.length <= 4) {
						const result = await callMcpTool({
							projectRoot,
							server: parts[1],
							tool: parts[2],
							arguments: parts[3] ? JSON.parse(parts[3]) : {},
						});
						appendText(JSON.stringify(result, null, 2));
						return;
					}
					appendText(
						warning(
							"Usage: /mcp add <name> <command> [args...] | /mcp tools <server> | /mcp call <server> <tool> [json-args]",
						),
					);
				} catch (cause) {
					appendText(failure(cause instanceof Error ? cause.message : String(cause)));
				}
				return;
			}
			if (command === "computer") {
				startComputerCommand(argument);
				return;
			}
			if (command === "projects" || (command === "project" && !argument)) {
				showProjects();
				return;
			}
			if (command === "project") {
				if (activeExecution) {
					appendText(warning("Finish the active task before switching projects."));
					return;
				}
				const project = resolveProject(argument);
				if (!project) {
					appendText(warning(`Project not found or ambiguous: ${argument}`));
					return;
				}
				projectRoot = project.path;
				refreshWorkspace();
				refreshQueue();
				updateHeader();
				installAutocomplete();
				appendText(`${success("●")} Switched to ${text(basename(projectRoot))}`);
				return;
			}
			if (command === "chats") {
				showChats();
				return;
			}
			if (command === "chat") {
				refreshWorkspace();
				const chat = resolveChat(argument);
				if (!chat) {
					appendText(warning(`Chat not found or ambiguous: ${argument || "(empty)"}`));
					return;
				}
				appendText(`${text(chat.objective)}  ${muted(chat.status)}`);
				appendText(`${dim("session")}  ${chat.id}`);
				appendText(`${dim("updated")}  ${chat.updatedAt}`);
				return;
			}
			if (command === "queue") {
				refreshQueue();
				appendText(text("Durable queue"));
				if (queuedRequests.length === 0) appendText(dim("No queued follow-ups."));
				for (const request of queuedRequests) {
					appendText(`${request.position}  ${muted(request.status)}  ${text(request.objective)}`);
				}
				return;
			}
			if (command === "clear") {
				transcriptEntries.splice(0);
				updateChrome();
				return;
			}
			if (command === "new") {
				agentSessionIds.delete(projectRoot);
				updateChrome();
				return;
			}
			if (command !== "resume") {
				appendText(warning(`Unknown command: /${command}. Type /help.`));
				return;
			}
			if (activeExecution) {
				appendText(warning("A task is already active."));
				return;
			}
			refreshWorkspace();
			const chat = argument ? resolveChat(argument) : undefined;
			if (argument && !chat) {
				appendText(warning(`Chat not found or ambiguous: ${argument}`));
				return;
			}
			startResume(chat?.id);
			return;
		}
		const enqueued = database.enqueueTuiRequest({
			requestId: `tui_${randomUUID()}`,
			projectPath: projectRoot,
			fingerprint: createHash("sha256").update(`${projectRoot}\0${objective}`).digest("hex"),
			objective,
		});
		refreshQueue();
		appendUser(objective, enqueued.inserted);
		if (!enqueued.inserted) appendText(warning(`already queued ${enqueued.request.position}  ${objective}`));
		drainQueue();
	};
	ui.addInputListener((value) => {
		if (value === "\u0003") {
			const action = resolveCtrlCAction(editor.getText());
			if (action === "clear-input") {
				editor.setText("");
				updateChrome();
			} else {
				requestExit();
			}
			return { consume: true };
		}
		if (approvalResolve && (value.toLowerCase() === "y" || value.toLowerCase() === "n")) {
			const resolve = approvalResolve;
			const kind = approvalKind;
			approvalResolve = undefined;
			approvalKind = undefined;
			const approved = value.toLowerCase() === "y";
			phase = approved ? "running" : "ready";
			if (kind === "patch") {
				appendText(approved ? success("✓ Patch approved") : warning("Patch rejected"));
			} else if (approved) {
				appendText(success("✓ Computer action approved"));
			}
			updateChrome();
			resolve(approved);
			return { consume: true };
		}
		return undefined;
	});
	ui.setFocus(editor);
	ui.start();
	drainQueue();
	await closed;
	if (workAnimationTimer) clearInterval(workAnimationTimer);
	database.close();
}
