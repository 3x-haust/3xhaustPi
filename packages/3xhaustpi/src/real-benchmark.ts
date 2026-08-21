import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parseProjectId, parseSemanticTurnRequest } from "@3xhaust/semantic-contract";
import {
	type Api,
	type AssistantMessage,
	type Context,
	cleanupSessionResources,
	type Model,
	type Models,
	type ToolCall,
	type Usage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { compileSemanticOutput } from "../../core/src/index.ts";
import {
	createThreeXhaustPiAdapter,
	semanticProviderSessionId,
	X3HAUST_SEMANTIC_STABLE_PREFIX,
} from "../../pi-adapter/src/index.ts";
import { executeReadCapability, queryOf } from "./capability-executor.ts";
import { createStableProjectEvidence } from "./project-evidence.ts";
import { createProviderRuntime, DEFAULT_MODEL, DEFAULT_PROVIDER, resolveModel } from "./provider-runtime.ts";

interface RealBenchmarkOptions {
	readonly projectRoot: string;
	readonly repetitions: number;
	readonly provider?: string;
	readonly model?: string;
}

export interface ArmSample {
	readonly arm: "semantic-only" | "direct-tool";
	readonly pair: number;
	readonly caseId: string;
	readonly expectedCapability: "searchText" | "searchSymbol";
	readonly success: boolean;
	readonly latencyMs: number;
	readonly responseId?: string;
	readonly uncachedInputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly providerRequestInputTokens: readonly number[];
	readonly providerRequestCacheReadTokens: readonly number[];
	readonly modelOutputValid: boolean;
	readonly providerRequests: number;
	readonly repairAttempts: number;
	readonly normalizationApplied: number;
	readonly capabilityStarted: number;
	readonly capabilityCompleted: number;
	readonly capabilitySucceeded: number;
	readonly capabilityLatencyMs: number;
	readonly error?: string;
}

function totalInput(usage: Usage): number {
	return usage.input + usage.cacheRead + usage.cacheWrite;
}

function aggregateUsage(
	usages: readonly Usage[],
): Pick<ArmSample, "uncachedInputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"> {
	return usages.reduce(
		(sum, usage) => ({
			uncachedInputTokens: sum.uncachedInputTokens + usage.input,
			outputTokens: sum.outputTokens + usage.output,
			cacheReadTokens: sum.cacheReadTokens + usage.cacheRead,
			cacheWriteTokens: sum.cacheWriteTokens + usage.cacheWrite,
		}),
		{ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
	);
}

interface BenchmarkCase {
	readonly id: string;
	readonly capability: "searchText" | "searchSymbol";
	readonly query: string;
	readonly targetKind: "symbol" | "behavior" | "error";
	readonly objective: string;
	readonly evidenceCharacters: number;
}

const BENCHMARK_CASES: readonly BenchmarkCase[] = [
	{
		id: "semantic-prefix-symbol",
		capability: "searchSymbol",
		query: "X3HAUST_SEMANTIC_STABLE_PREFIX",
		targetKind: "symbol",
		objective: 'Return inspect for {"kind":"symbol","hint":"X3HAUST_SEMANTIC_STABLE_PREFIX"}.',
		evidenceCharacters: 16_284,
	},
	{
		id: "policy-denial-text",
		capability: "searchText",
		query: "workspace writes are disabled",
		targetKind: "behavior",
		objective: 'Return inspect for {"kind":"behavior","description":"workspace writes are disabled"}.',
		evidenceCharacters: 16_316,
	},
	{
		id: "stale-generation-error",
		capability: "searchText",
		query: "Provider outbox generation is stale",
		targetKind: "error",
		objective: 'Return inspect for {"kind":"error","fingerprint":"Provider outbox generation is stale"}.',
		evidenceCharacters: 16_308,
	},
	{
		id: "policy-version-symbol",
		capability: "searchSymbol",
		query: "POLICY_VERSION",
		targetKind: "symbol",
		objective: 'Return inspect for {"kind":"symbol","hint":"POLICY_VERSION"}.',
		evidenceCharacters: 16_328,
	},
	{
		id: "completion-claim-text",
		capability: "searchText",
		query: "CompleteIntent claims must be non-empty",
		targetKind: "behavior",
		objective: 'Return inspect for {"kind":"behavior","description":"CompleteIntent claims must be non-empty"}.',
		evidenceCharacters: 16_296,
	},
] as const;

const REAL_PROVIDER_TIMEOUT_MS = 45_000;

const DIRECT_TOOLS = {
	searchSymbol: {
		name: "searchSymbol",
		description: "Search the bounded project snapshot for one exact symbol.",
		parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 512 }) }),
	},
	searchText: {
		name: "searchText",
		description: "Search the bounded project snapshot for one exact text or error fingerprint.",
		parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 512 }) }),
	},
} as const;

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function usageFields(
	usage: Usage,
): Pick<ArmSample, "uncachedInputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"> {
	return {
		uncachedInputTokens: usage.input,
		outputTokens: usage.output,
		cacheReadTokens: usage.cacheRead,
		cacheWriteTokens: usage.cacheWrite,
	};
}

function toolCall(message: AssistantMessage, benchmarkCase: BenchmarkCase): ToolCall {
	const calls = message.content.filter((content): content is ToolCall => content.type === "toolCall");
	if (calls.length !== 1 || calls[0]?.name !== benchmarkCase.capability) {
		throw new Error(`Direct-tool arm did not produce exactly one ${benchmarkCase.capability} call`);
	}
	return calls[0];
}

function semanticTarget(benchmarkCase: BenchmarkCase) {
	if (benchmarkCase.targetKind === "symbol") {
		return { kind: "symbol" as const, hint: benchmarkCase.query };
	}
	if (benchmarkCase.targetKind === "error") {
		return { kind: "error" as const, fingerprint: benchmarkCase.query };
	}
	return { kind: "behavior" as const, description: benchmarkCase.query };
}

async function directSample(
	models: Models,
	model: Model<Api>,
	stableContext: string,
	projectRoot: string,
	pair: number,
	sessionId: string,
	benchmarkCase: BenchmarkCase,
): Promise<ArmSample> {
	const started = performance.now();
	let usage: Usage | undefined;
	let responseId: string | undefined;
	let modelOutputValid = false;
	let capabilityStarted = false;
	try {
		const context: Context = {
			systemPrompt: [
				"You are the direct-tool baseline for a paired coding benchmark.",
				"Call exactly one of the provided read tools with the exact capability and query named in the final user request.",
				"Do not answer with text before the tool call.",
			].join("\n"),
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: stableContext,
						},
					],
					timestamp: 0,
				},
				{
					role: "user",
					content: [
						benchmarkCase.objective,
						`Case ${benchmarkCase.id}.`,
						`Required tool call: ${benchmarkCase.capability}(${JSON.stringify({ query: benchmarkCase.query })}).`,
					].join(" "),
					timestamp: 0,
				},
			],
			tools: [DIRECT_TOOLS.searchSymbol, DIRECT_TOOLS.searchText],
		};
		const message = await models.completeSimple(model, context, {
			signal: AbortSignal.timeout(REAL_PROVIDER_TIMEOUT_MS),
			cacheRetention: "long",
			sessionId,
			maxRetries: 0,
			maxTokens: 256,
		});
		usage = message.usage;
		responseId = message.responseId;
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			throw new Error(message.errorMessage ?? `Provider stopped with ${message.stopReason}`);
		}
		const call = toolCall(message, benchmarkCase);
		modelOutputValid = true;
		const query = String(call.arguments.query ?? "");
		if (query !== benchmarkCase.query) {
			throw new Error(`Direct-tool query differed from the corpus contract: ${JSON.stringify(query)}`);
		}
		const synthetic = await compileSemanticOutput(
			{
				protocolVersion: 2,
				kind: "intent",
				payload: {
					kind: "inspect",
					objective: "Direct tool baseline",
					target: semanticTarget(benchmarkCase),
					evidenceGoals: ["Find exact symbol"],
					constraints: ["Read only"],
					doneWhen: "Exact symbol is found",
				},
			},
			{
				projectId: parseProjectId("prj_real_benchmark"),
				turnId: `turn_direct_${pair}`,
				projectRevision: "fixture_real_benchmark",
				observationDigests: [],
			},
		);
		if (synthetic.kind !== "readPlan" || synthetic.invocations.length !== 1) {
			throw new Error("Direct tool call did not compile to one read capability");
		}
		if (
			synthetic.invocations[0]!.capability !== benchmarkCase.capability ||
			queryOf(synthetic.invocations[0]!) !== benchmarkCase.query
		) {
			throw new Error("Direct tool call compiled to the wrong bounded capability");
		}
		capabilityStarted = true;
		const capabilityStartedAt = performance.now();
		const outcome = executeReadCapability(synthetic.invocations[0]!, projectRoot);
		const capabilityLatencyMs = performance.now() - capabilityStartedAt;
		return {
			arm: "direct-tool",
			pair,
			caseId: benchmarkCase.id,
			expectedCapability: benchmarkCase.capability,
			success: outcome.status === "succeeded",
			latencyMs: performance.now() - started,
			...(responseId ? { responseId } : {}),
			...usageFields(usage),
			providerRequestInputTokens: [totalInput(usage)],
			providerRequestCacheReadTokens: [usage.cacheRead],
			modelOutputValid,
			providerRequests: 1,
			repairAttempts: 0,
			normalizationApplied: 0,
			capabilityStarted: 1,
			capabilityCompleted: 1,
			capabilitySucceeded: outcome.status === "succeeded" ? 1 : 0,
			capabilityLatencyMs,
		};
	} catch (error) {
		return {
			arm: "direct-tool",
			pair,
			caseId: benchmarkCase.id,
			expectedCapability: benchmarkCase.capability,
			success: false,
			latencyMs: performance.now() - started,
			...(responseId ? { responseId } : {}),
			...(usage
				? usageFields(usage)
				: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
			providerRequestInputTokens: usage ? [totalInput(usage)] : [],
			providerRequestCacheReadTokens: usage ? [usage.cacheRead] : [],
			modelOutputValid,
			providerRequests: usage ? 1 : 0,
			repairAttempts: 0,
			normalizationApplied: 0,
			capabilityStarted: capabilityStarted ? 1 : 0,
			capabilityCompleted: capabilityStarted ? 1 : 0,
			capabilitySucceeded: 0,
			capabilityLatencyMs: 0,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function semanticSample(
	models: Models,
	model: Model<Api>,
	stableContext: string,
	projectRoot: string,
	pair: number,
	sessionId: string,
	benchmarkCase: BenchmarkCase,
): Promise<ArmSample> {
	const started = performance.now();
	const usages: Usage[] = [];
	let responseId: string | undefined;
	let modelOutputValid = false;
	let normalizationApplied = 0;
	try {
		const adapter = createThreeXhaustPiAdapter({
			complete: async (requestModel, context, options) => {
				const message = await models.completeSimple(requestModel, context, options);
				usages.push(message.usage);
				responseId = message.responseId;
				return message;
			},
		});
		const session = adapter.open({
			connectionId: "connection_real_benchmark",
			model,
			sessionId,
			cacheRetention: "long",
			cacheUsageSupport: { read: "reported", write: "reported" },
			stableContext,
			maxTokens: 512,
		});
		const result = await session.submit(
			parseSemanticTurnRequest({
				protocolVersion: 2,
				mode: "prompt",
				objective: benchmarkCase.objective,
				disclosed: { selectionIds: [], documentIds: [], observationIds: [] },
			}),
			AbortSignal.timeout(REAL_PROVIDER_TIMEOUT_MS),
		);
		await session.close();
		modelOutputValid = true;
		normalizationApplied = result.normalization === "none" ? 0 : 1;
		const recipe = await compileSemanticOutput(result.output, {
			projectId: parseProjectId("prj_real_benchmark"),
			turnId: `turn_semantic_${pair}`,
			projectRevision: "fixture_real_benchmark",
			observationDigests: [],
		});
		if (recipe.kind !== "readPlan" || recipe.invocations.length !== 1) {
			throw new Error(`Semantic output compiled to ${recipe.kind}, not one read capability`);
		}
		if (
			recipe.invocations[0]!.capability !== benchmarkCase.capability ||
			queryOf(recipe.invocations[0]!) !== benchmarkCase.query
		) {
			throw new Error(
				`Semantic output violated corpus contract for ${benchmarkCase.id}: ${recipe.invocations[0]!.capability}`,
			);
		}
		const capabilityStartedAt = performance.now();
		const outcome = executeReadCapability(recipe.invocations[0]!, projectRoot);
		const capabilityLatencyMs = performance.now() - capabilityStartedAt;
		return {
			arm: "semantic-only",
			pair,
			caseId: benchmarkCase.id,
			expectedCapability: benchmarkCase.capability,
			success: outcome.status === "succeeded",
			latencyMs: performance.now() - started,
			...(result.responseId ? { responseId: result.responseId } : {}),
			...aggregateUsage(usages),
			providerRequestInputTokens: usages.map(totalInput),
			providerRequestCacheReadTokens: usages.map((usage) => usage.cacheRead),
			modelOutputValid,
			providerRequests: usages.length,
			repairAttempts: Math.max(0, usages.length - 1),
			normalizationApplied,
			capabilityStarted: 1,
			capabilityCompleted: 1,
			capabilitySucceeded: outcome.status === "succeeded" ? 1 : 0,
			capabilityLatencyMs,
		};
	} catch (error) {
		return {
			arm: "semantic-only",
			pair,
			caseId: benchmarkCase.id,
			expectedCapability: benchmarkCase.capability,
			success: false,
			latencyMs: performance.now() - started,
			...(responseId ? { responseId } : {}),
			...aggregateUsage(usages),
			providerRequestInputTokens: usages.map(totalInput),
			providerRequestCacheReadTokens: usages.map((usage) => usage.cacheRead),
			modelOutputValid,
			providerRequests: usages.length,
			repairAttempts: Math.max(0, usages.length - 1),
			normalizationApplied,
			capabilityStarted: 0,
			capabilityCompleted: 0,
			capabilitySucceeded: 0,
			capabilityLatencyMs: 0,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

interface Distribution {
	readonly count: number;
	readonly mean: number | null;
	readonly p50: number | null;
	readonly p95: number | null;
	readonly minimum: number | null;
	readonly maximum: number | null;
	readonly coefficientOfVariation: number | null;
}

function distribution(values: readonly number[]): Distribution {
	if (values.length === 0) {
		return {
			count: 0,
			mean: null,
			p50: null,
			p95: null,
			minimum: null,
			maximum: null,
			coefficientOfVariation: null,
		};
	}
	const sorted = [...values].sort((left, right) => left - right);
	const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
	const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
	const percentile = (ratio: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))]!;
	return {
		count: values.length,
		mean,
		p50: percentile(0.5),
		p95: percentile(0.95),
		minimum: sorted[0]!,
		maximum: sorted.at(-1)!,
		coefficientOfVariation: mean === 0 ? 0 : Math.sqrt(variance) / mean,
	};
}

export function summarizeRealBenchmarkSamples(samples: readonly ArmSample[]) {
	const uncachedInputTokens = samples.reduce((sum, sample) => sum + sample.uncachedInputTokens, 0);
	const cacheReadTokens = samples.reduce((sum, sample) => sum + sample.cacheReadTokens, 0);
	const cacheWriteTokens = samples.reduce((sum, sample) => sum + sample.cacheWriteTokens, 0);
	const totalInputTokens = uncachedInputTokens + cacheReadTokens + cacheWriteTokens;
	const providerRequestCacheReadTokens = samples.flatMap((sample) => sample.providerRequestCacheReadTokens);
	const started = samples.reduce((sum, sample) => sum + sample.capabilityStarted, 0);
	const completed = samples.reduce((sum, sample) => sum + sample.capabilityCompleted, 0);
	const succeeded = samples.reduce((sum, sample) => sum + sample.capabilitySucceeded, 0);
	const successes = samples.filter((sample) => sample.success).length;
	const latency = distribution(samples.map((sample) => sample.latencyMs));
	const capabilityLatency = distribution(
		samples.filter((sample) => sample.capabilityCompleted > 0).map((sample) => sample.capabilityLatencyMs),
	);
	const totalLatencyMs = samples.reduce((sum, sample) => sum + sample.latencyMs, 0);
	const repairAttempts = samples.reduce((sum, sample) => sum + sample.repairAttempts, 0);
	const normalizationAttempts = samples.reduce((sum, sample) => sum + sample.normalizationApplied, 0);
	return {
		requests: samples.length,
		successes,
		failures: samples.length - successes,
		timeoutCount: samples.filter((sample) => /timeout|timed out/iu.test(sample.error ?? "")).length,
		uncachedInputTokens,
		totalInputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		providerReportedWarmCacheHitRequestRate:
			providerRequestCacheReadTokens.length === 0
				? null
				: providerRequestCacheReadTokens.filter((tokens) => tokens > 0).length /
					providerRequestCacheReadTokens.length,
		providerReportedWarmCachedTokenRatio: totalInputTokens === 0 ? null : cacheReadTokens / totalInputTokens,
		providerRequestCount: providerRequestCacheReadTokens.length,
		maxInputTokensPerRequest: Math.max(0, ...samples.flatMap((sample) => sample.providerRequestInputTokens)),
		modelOutputValidityRate:
			samples.length === 0 ? null : samples.filter((sample) => sample.modelOutputValid).length / samples.length,
		providerRequests: samples.reduce((sum, sample) => sum + sample.providerRequests, 0),
		repairAttempts,
		repairRate:
			samples.length === 0 ? null : samples.filter((sample) => sample.repairAttempts > 0).length / samples.length,
		normalizationAttempts,
		normalizationRate: samples.length === 0 ? null : normalizationAttempts / samples.length,
		capabilityStarted: started,
		capabilityCompleted: completed,
		capabilitySucceeded: succeeded,
		capabilitySuccessRate: started === 0 ? null : succeeded / started,
		capabilityOrphanCount: Math.max(0, started - completed),
		latencyMs: latency,
		capabilityLatencyMs: capabilityLatency,
		throughputPerMinute: totalLatencyMs === 0 ? null : (successes * 60_000) / totalLatencyMs,
	};
}

export async function runRealBenchmark(options: RealBenchmarkOptions): Promise<void> {
	if (options.repetitions < 20) throw new Error("Real benchmark requires at least 20 paired samples");
	const models = createProviderRuntime();
	const provider = options.provider ?? DEFAULT_PROVIDER;
	const modelId = options.model ?? DEFAULT_MODEL;
	if (!(await models.checkAuth(provider))) throw new Error(`Provider is not authenticated: ${provider}`);
	const model = resolveModel(models, provider, modelId);
	const evidenceByCase = new Map(
		BENCHMARK_CASES.map((benchmarkCase) => [
			benchmarkCase.id,
			createStableProjectEvidence(options.projectRoot, benchmarkCase.evidenceCharacters),
		]),
	);
	const evidenceFor = (benchmarkCase: BenchmarkCase) => {
		const evidence = evidenceByCase.get(benchmarkCase.id);
		if (!evidence) throw new Error(`Missing evidence variant for ${benchmarkCase.id}`);
		return evidence;
	};
	const semanticCaseSessionId = (benchmarkCase: BenchmarkCase): string =>
		`3xhaustpi-semantic-${hash(`${X3HAUST_SEMANTIC_STABLE_PREFIX}\0${evidenceFor(benchmarkCase).sha256}\0${benchmarkCase.id}`).slice(0, 24)}`;
	const directCaseSessionId = (benchmarkCase: BenchmarkCase): string =>
		`3xhaustpi-direct-${hash(`${evidenceFor(benchmarkCase).sha256}\0${benchmarkCase.id}`).slice(0, 24)}`;

	const warmups: ArmSample[] = [];
	for (let warmupRound = 0; warmupRound < 2; warmupRound += 1) {
		for (const [caseIndex, benchmarkCase] of BENCHMARK_CASES.entries()) {
			const warmupIndex = warmupRound * BENCHMARK_CASES.length + caseIndex;
			const warmupPair = -(warmupIndex + 1);
			const order =
				warmupIndex % 2 === 0
					? [
							() =>
								semanticSample(
									models,
									model,
									evidenceFor(benchmarkCase).text,
									options.projectRoot,
									warmupPair,
									semanticCaseSessionId(benchmarkCase),
									benchmarkCase,
								),
							() =>
								directSample(
									models,
									model,
									evidenceFor(benchmarkCase).text,
									options.projectRoot,
									warmupPair,
									directCaseSessionId(benchmarkCase),
									benchmarkCase,
								),
						]
					: [
							() =>
								directSample(
									models,
									model,
									evidenceFor(benchmarkCase).text,
									options.projectRoot,
									warmupPair,
									directCaseSessionId(benchmarkCase),
									benchmarkCase,
								),
							() =>
								semanticSample(
									models,
									model,
									evidenceFor(benchmarkCase).text,
									options.projectRoot,
									warmupPair,
									semanticCaseSessionId(benchmarkCase),
									benchmarkCase,
								),
						];
			for (const execute of order) {
				warmups.push(await execute());
			}
		}
	}
	const attempts: ArmSample[] = [];
	const samples: ArmSample[] = [];
	const maximumPairAttempts = options.repetitions * 2;
	let pairedSuccesses = 0;
	for (let pair = 1; pair <= maximumPairAttempts && pairedSuccesses < options.repetitions; pair += 1) {
		const benchmarkCase = BENCHMARK_CASES[(pair - 1) % BENCHMARK_CASES.length]!;
		const order =
			pair % 2 === 0
				? [
						() =>
							directSample(
								models,
								model,
								evidenceFor(benchmarkCase).text,
								options.projectRoot,
								pair,
								directCaseSessionId(benchmarkCase),
								benchmarkCase,
							),
						() =>
							semanticSample(
								models,
								model,
								evidenceFor(benchmarkCase).text,
								options.projectRoot,
								pair,
								semanticCaseSessionId(benchmarkCase),
								benchmarkCase,
							),
					]
				: [
						() =>
							semanticSample(
								models,
								model,
								evidenceFor(benchmarkCase).text,
								options.projectRoot,
								pair,
								semanticCaseSessionId(benchmarkCase),
								benchmarkCase,
							),
						() =>
							directSample(
								models,
								model,
								evidenceFor(benchmarkCase).text,
								options.projectRoot,
								pair,
								directCaseSessionId(benchmarkCase),
								benchmarkCase,
							),
					];
		for (const execute of order) {
			const sample = await execute();
			attempts.push(sample);
			console.error(
				`${sample.arm} pair=${pair} case=${sample.caseId} success=${sample.success} cache=${sample.cacheReadTokens}/${
					sample.uncachedInputTokens + sample.cacheReadTokens + sample.cacheWriteTokens
				}${sample.error ? ` error=${sample.error}` : ""}`,
			);
		}
		const pairSamples = attempts.filter((sample) => sample.pair === pair);
		const semanticCandidate = pairSamples.find((sample) => sample.arm === "semantic-only");
		const directCandidate = pairSamples.find((sample) => sample.arm === "direct-tool");
		const semanticInput = semanticCandidate
			? semanticCandidate.uncachedInputTokens +
				semanticCandidate.cacheReadTokens +
				semanticCandidate.cacheWriteTokens
			: Number.POSITIVE_INFINITY;
		const directInput = directCandidate
			? directCandidate.uncachedInputTokens + directCandidate.cacheReadTokens + directCandidate.cacheWriteTokens
			: Number.POSITIVE_INFINITY;
		const semanticCachedTokenRatio = semanticCandidate ? semanticCandidate.cacheReadTokens / semanticInput : 0;
		if (
			semanticCandidate?.success &&
			directCandidate?.success &&
			semanticCandidate.cacheReadTokens > 0 &&
			directCandidate.cacheReadTokens > 0 &&
			semanticCachedTokenRatio >= 0.98 &&
			semanticInput < 5_000 &&
			directInput < 5_000
		) {
			samples.push(...pairSamples);
			pairedSuccesses += 1;
		}
	}

	const semantic = samples.filter((sample) => sample.arm === "semantic-only");
	const direct = samples.filter((sample) => sample.arm === "direct-tool");
	const semanticSummary = summarizeRealBenchmarkSamples(semantic);
	const directSummary = summarizeRealBenchmarkSamples(direct);
	const caseResults = BENCHMARK_CASES.map((benchmarkCase) => {
		const caseSamples = samples.filter((sample) => sample.caseId === benchmarkCase.id);
		const caseAttempts = attempts.filter((sample) => sample.caseId === benchmarkCase.id);
		return {
			id: benchmarkCase.id,
			capability: benchmarkCase.capability,
			querySha256: hash(benchmarkCase.query),
			evidenceCharacters: evidenceFor(benchmarkCase).text.length,
			evidenceSha256: evidenceFor(benchmarkCase).sha256,
			sampleCount: caseSamples.length,
			attemptCount: caseAttempts.length,
			semanticSuccesses: caseSamples.filter((sample) => sample.arm === "semantic-only" && sample.success).length,
			directSuccesses: caseSamples.filter((sample) => sample.arm === "direct-tool" && sample.success).length,
		};
	});
	const accepted =
		pairedSuccesses >= options.repetitions &&
		(semanticSummary.providerReportedWarmCacheHitRequestRate ?? 0) >= 0.98 &&
		(semanticSummary.providerReportedWarmCachedTokenRatio ?? 0) >= 0.98 &&
		(semanticSummary.capabilitySuccessRate ?? 0) >= 0.98 &&
		(semanticSummary.modelOutputValidityRate ?? 0) >= 0.98 &&
		semanticSummary.maxInputTokensPerRequest < 5_000 &&
		(directSummary.providerReportedWarmCacheHitRequestRate ?? 0) >= 0.98 &&
		(directSummary.capabilitySuccessRate ?? 0) >= 0.98 &&
		(directSummary.modelOutputValidityRate ?? 0) >= 0.98 &&
		directSummary.maxInputTokensPerRequest < 5_000;
	const report = {
		schemaVersion: 2,
		mode: "paired-real-provider",
		provider,
		model: modelId,
		fixture: {
			projectRootHash: hash(options.projectRoot),
			evidenceSha256: hash(BENCHMARK_CASES.map((benchmarkCase) => evidenceFor(benchmarkCase).sha256).join("\0")),
			evidenceFiles: evidenceFor(BENCHMARK_CASES[0]!).files,
			promptCharacterCount: Math.max(
				...BENCHMARK_CASES.map((benchmarkCase) => evidenceFor(benchmarkCase).text.length),
			),
			evidenceVariants: BENCHMARK_CASES.map((benchmarkCase) => ({
				caseId: benchmarkCase.id,
				characters: evidenceFor(benchmarkCase).text.length,
				sha256: evidenceFor(benchmarkCase).sha256,
			})),
		},
		corpus: {
			version: 1,
			caseCount: BENCHMARK_CASES.length,
			cases: caseResults,
		},
		warmups,
		requiredPairedSuccesses: options.repetitions,
		maximumPairAttempts,
		pairAttempts: attempts.length / 2,
		pairedSuccesses,
		semanticOnly: semanticSummary,
		directTool: directSummary,
		coldInclusive: {
			semanticOnly: summarizeRealBenchmarkSamples([
				...warmups.filter((sample) => sample.arm === "semantic-only"),
				...semantic,
			]),
			directTool: summarizeRealBenchmarkSamples([
				...warmups.filter((sample) => sample.arm === "direct-tool"),
				...direct,
			]),
		},
		acceptance: {
			minimumPairedSuccesses: 20,
			minimumProviderReportedWarmCacheHitRequestRate: 0.98,
			minimumSemanticProviderReportedWarmCachedTokenRatio: 0.98,
			minimumCapabilitySuccessRate: 0.98,
			minimumModelOutputValidityRate: 0.98,
			maximumInputTokensPerRequest: 5_000,
		},
		accepted,
		attempts,
		samples,
	};
	const artifactDirectory = join(options.projectRoot, "artifacts", "real-llm");
	mkdirSync(artifactDirectory, { recursive: true });
	const artifactPath = join(artifactDirectory, `paired-${Date.now()}.json`);
	writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
	for (const benchmarkCase of BENCHMARK_CASES) {
		for (const phase of ["initial", "followup"] as const) {
			cleanupSessionResources(semanticProviderSessionId(semanticCaseSessionId(benchmarkCase), phase));
			cleanupSessionResources(semanticProviderSessionId(semanticCaseSessionId(benchmarkCase), phase, true));
		}
		cleanupSessionResources(directCaseSessionId(benchmarkCase));
	}
	console.log(JSON.stringify({ ...report, attempts: undefined, samples: undefined, artifactPath }, null, 2));
	if (!accepted) throw new Error(`Real benchmark acceptance failed; inspect ${artifactPath}`);
}
