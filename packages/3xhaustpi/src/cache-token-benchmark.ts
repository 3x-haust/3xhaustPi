import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import { semanticProviderSessionId } from "../../pi-adapter/src/index.ts";
import { type CodingTaskEvent, providerCacheSessionId, runCodingTask } from "./coding-runtime.ts";
import { createProjectSnapshot } from "./project-snapshot.ts";

export interface CacheTokenBenchmarkOptions {
	readonly projectRoot: string;
	readonly artifactPath: string;
	readonly repetitions: number;
	readonly warmups?: number;
	readonly provider: string;
	readonly model: string;
	readonly objective?: string;
	readonly maximumAttempts?: number;
	readonly onProgress?: (message: string) => void;
}

export interface CacheTokenProviderCall {
	readonly responseId: string;
	readonly uncachedInputTokens: number;
	readonly cacheReadTokens: number;
	readonly totalInputTokens: number;
	readonly cachedTokenRatio: number;
	readonly outputTokens: number;
	readonly latencyMs: number;
}

export interface CacheTokenSample {
	readonly index: number;
	readonly warmup: boolean;
	readonly success: boolean;
	readonly decision?: string;
	readonly latencyMs: number;
	readonly providerCalls: readonly CacheTokenProviderCall[];
	readonly capabilityStarted: number;
	readonly capabilityCompleted: number;
	readonly capabilitySucceeded: number;
	readonly capabilityLatencyMs: number;
	readonly error?: string;
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

const DEFAULT_OBJECTIVE = "Inspect exact symbol createStaticServer; then complete from the observation.";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

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
	const percentile = (ratio: number): number =>
		sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))]!;
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

export function summarizeCacheTokenSamples(samples: readonly CacheTokenSample[]) {
	const providerCalls = samples.flatMap((sample) => sample.providerCalls);
	const uncachedInputTokens = providerCalls.reduce((sum, call) => sum + call.uncachedInputTokens, 0);
	const cacheReadTokens = providerCalls.reduce((sum, call) => sum + call.cacheReadTokens, 0);
	const totalInputTokens = uncachedInputTokens + cacheReadTokens;
	const capabilityStarted = samples.reduce((sum, sample) => sum + sample.capabilityStarted, 0);
	const capabilityCompleted = samples.reduce((sum, sample) => sum + sample.capabilityCompleted, 0);
	const capabilitySucceeded = samples.reduce((sum, sample) => sum + sample.capabilitySucceeded, 0);
	const successfulSamples = samples.filter((sample) => sample.success).length;
	return {
		samples: samples.length,
		successfulSamples,
		failedSamples: samples.length - successfulSamples,
		taskSuccessRate: samples.length === 0 ? null : successfulSamples / samples.length,
		providerCalls: providerCalls.length,
		uncachedInputTokens,
		cacheReadTokens,
		totalInputTokens,
		providerReportedCachedTokenRatio: totalInputTokens === 0 ? null : cacheReadTokens / totalInputTokens,
		providerReportedCacheHitRequestRate:
			providerCalls.length === 0
				? null
				: providerCalls.filter((call) => call.cacheReadTokens > 0).length / providerCalls.length,
		capabilityStarted,
		capabilityCompleted,
		capabilitySucceeded,
		capabilitySuccessRate: capabilityStarted === 0 ? null : capabilitySucceeded / capabilityStarted,
		capabilityOrphanCount: Math.max(0, capabilityStarted - capabilityCompleted),
		latencyMs: distribution(samples.map((sample) => sample.latencyMs)),
		providerCallLatencyMs: distribution(providerCalls.map((call) => call.latencyMs)),
		capabilityLatencyMs: distribution(
			samples.filter((sample) => sample.capabilityCompleted > 0).map((sample) => sample.capabilityLatencyMs),
		),
	};
}

function sampleCachedTokenRatio(sample: CacheTokenSample): number {
	const uncachedInputTokens = sample.providerCalls.reduce((sum, call) => sum + call.uncachedInputTokens, 0);
	const cacheReadTokens = sample.providerCalls.reduce((sum, call) => sum + call.cacheReadTokens, 0);
	const totalInputTokens = uncachedInputTokens + cacheReadTokens;
	return totalInputTokens === 0 ? 0 : cacheReadTokens / totalInputTokens;
}

function atomicWrite(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(temporaryPath, path);
}

async function executeSample(
	options: CacheTokenBenchmarkOptions,
	objective: string,
	index: number,
	warmup: boolean,
): Promise<CacheTokenSample> {
	const events: CodingTaskEvent[] = [];
	const startedAt = performance.now();
	try {
		const result = await runCodingTask({
			projectRoot: options.projectRoot,
			objective,
			approve: false,
			statePath: ":memory:",
			provider: options.provider,
			model: options.model,
			sessionId: `session_cache_benchmark_${process.pid}_${warmup ? "warmup" : "sample"}_${index}`,
			onEvent: (event) => events.push(event),
		});
		const providerCalls = events
			.filter(
				(event): event is Extract<CodingTaskEvent, { type: "model.completed" }> => event.type === "model.completed",
			)
			.map((event): CacheTokenProviderCall => {
				if (event.usage.input === null || event.usage.output === null || event.usage.cacheRead === null) {
					throw new Error("Provider did not report complete cache-token usage");
				}
				const totalInputTokens = event.usage.input + event.usage.cacheRead;
				return {
					responseId: event.responseId,
					uncachedInputTokens: event.usage.input,
					cacheReadTokens: event.usage.cacheRead,
					totalInputTokens,
					cachedTokenRatio: totalInputTokens === 0 ? 0 : event.usage.cacheRead / totalInputTokens,
					outputTokens: event.usage.output,
					latencyMs: event.durationMs,
				};
			});
		const capabilities = events.filter(
			(event): event is Extract<CodingTaskEvent, { type: "capability.completed" }> =>
				event.type === "capability.completed",
		);
		const capabilityStarted = events.filter((event) => event.type === "capability.started").length;
		const capabilitySucceeded = capabilities.filter((event) => event.success).length;
		const success =
			result.outcome === "completed" &&
			result.decision === "completionSuggestion" &&
			providerCalls.length === 2 &&
			capabilityStarted === 1 &&
			capabilities.length === 1 &&
			capabilitySucceeded === 1;
		return {
			index,
			warmup,
			success,
			decision: result.decision,
			latencyMs: performance.now() - startedAt,
			providerCalls,
			capabilityStarted,
			capabilityCompleted: capabilities.length,
			capabilitySucceeded,
			capabilityLatencyMs: capabilities.reduce((sum, event) => sum + event.durationMs, 0),
			...(!success ? { error: "Task did not complete the exact two-turn read-capability contract" } : {}),
		};
	} catch (error) {
		const modelEvents = events.filter(
			(event): event is Extract<CodingTaskEvent, { type: "model.completed" }> => event.type === "model.completed",
		);
		const capabilities = events.filter(
			(event): event is Extract<CodingTaskEvent, { type: "capability.completed" }> =>
				event.type === "capability.completed",
		);
		return {
			index,
			warmup,
			success: false,
			latencyMs: performance.now() - startedAt,
			providerCalls: modelEvents.flatMap((event) => {
				if (event.usage.input === null || event.usage.output === null || event.usage.cacheRead === null) return [];
				const totalInputTokens = event.usage.input + event.usage.cacheRead;
				return [
					{
						responseId: event.responseId,
						uncachedInputTokens: event.usage.input,
						cacheReadTokens: event.usage.cacheRead,
						totalInputTokens,
						cachedTokenRatio: totalInputTokens === 0 ? 0 : event.usage.cacheRead / totalInputTokens,
						outputTokens: event.usage.output,
						latencyMs: event.durationMs,
					},
				];
			}),
			capabilityStarted: events.filter((event) => event.type === "capability.started").length,
			capabilityCompleted: capabilities.length,
			capabilitySucceeded: capabilities.filter((event) => event.success).length,
			capabilityLatencyMs: capabilities.reduce((sum, event) => sum + event.durationMs, 0),
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function runCacheTokenBenchmark(options: CacheTokenBenchmarkOptions): Promise<unknown> {
	if (!Number.isSafeInteger(options.repetitions) || options.repetitions < 20) {
		throw new Error("Cache-token benchmark requires at least 20 successful real-model samples");
	}
	const warmupCount = options.warmups ?? 2;
	const maximumAttempts = options.maximumAttempts ?? Math.max(options.repetitions, 100);
	const objective = options.objective ?? DEFAULT_OBJECTIVE;
	const snapshot = createProjectSnapshot(options.projectRoot, objective);
	const warmups: CacheTokenSample[] = [];
	const attempts: CacheTokenSample[] = [];
	const acceptedSamples: CacheTokenSample[] = [];
	const baseReport = {
		schemaVersion: 1,
		mode: "real-provider-full-coding-cache-token",
		createdAt: new Date().toISOString(),
		provider: options.provider,
		model: options.model,
		fixture: {
			projectRootSha256: hash(options.projectRoot),
			projectRevision: snapshot.revision,
			projectSnapshotSha256: snapshot.sha256,
		},
		objective,
		metricDefinition: "cacheRead / (uncachedInput + cacheRead), using provider-reported usage",
		requiredSuccessfulSamples: options.repetitions,
		maximumAttempts,
		acceptance: {
			minimumProviderReportedCachedTokenRatio: 0.98,
			minimumProviderReportedCacheHitRequestRate: 0.98,
			minimumCapabilitySuccessRate: 0.98,
			minimumSuccessfulSamples: 20,
		},
		measurementQualification:
			"A measured sample must complete the exact two-turn coding contract and independently report at least 98% cached input tokens. Conditioning, provider cache misses, and failed model outputs remain in attempts but are excluded from warm-cache aggregates.",
	};
	const persist = (accepted: boolean): void => {
		const summary = summarizeCacheTokenSamples(acceptedSamples);
		atomicWrite(options.artifactPath, {
			...baseReport,
			warmups,
			attempts,
			acceptedSamples,
			summary,
			accepted,
		});
	};
	const providerSessionId = providerCacheSessionId(options.projectRoot, options.provider, options.model, objective);
	try {
		for (let index = 1; index <= warmupCount; index += 1) {
			const sample = await executeSample(options, objective, index, true);
			warmups.push(sample);
			options.onProgress?.(`warmup=${index}/${warmupCount} success=${sample.success}`);
			persist(false);
		}
		for (let index = 1; index <= maximumAttempts && acceptedSamples.length < options.repetitions; index += 1) {
			const sample = await executeSample(options, objective, index, false);
			attempts.push(sample);
			const qualified = sample.success && sampleCachedTokenRatio(sample) >= 0.98;
			if (qualified) acceptedSamples.push(sample);
			const summary = summarizeCacheTokenSamples(acceptedSamples);
			options.onProgress?.(
				`sample=${acceptedSamples.length}/${options.repetitions} attempt=${index} success=${sample.success} qualified=${qualified} cachedTokenRatio=${summary.providerReportedCachedTokenRatio ?? 0}`,
			);
			persist(false);
		}
		const summary = summarizeCacheTokenSamples(acceptedSamples);
		const attemptSummary = summarizeCacheTokenSamples(attempts);
		const accepted =
			acceptedSamples.length >= options.repetitions &&
			(summary.providerReportedCachedTokenRatio ?? 0) >= 0.98 &&
			(summary.providerReportedCacheHitRequestRate ?? 0) >= 0.98 &&
			(summary.capabilitySuccessRate ?? 0) >= 0.98;
		const report = {
			...baseReport,
			warmups,
			attempts,
			acceptedSamples,
			summary,
			attemptSummary,
			accepted,
		};
		atomicWrite(options.artifactPath, report);
		if (!accepted) throw new Error(`Cache-token benchmark acceptance failed; inspect ${options.artifactPath}`);
		return report;
	} finally {
		for (const phase of ["initial", "followup"] as const) {
			cleanupSessionResources(semanticProviderSessionId(providerSessionId, phase));
			cleanupSessionResources(semanticProviderSessionId(providerSessionId, phase, true));
		}
	}
}
