import type { ThreeXhaustSessionMetrics } from "./metrics.ts";

export interface ThreeXhaustBenchmarkScenario {
	readonly metrics: ThreeXhaustSessionMetrics;
	readonly durationsMs: readonly number[];
}

export interface ThreeXhaustBenchmarkInput {
	readonly repetitions: number;
	readonly baseline: ThreeXhaustBenchmarkScenario;
	readonly optimized: ThreeXhaustBenchmarkScenario;
}

export interface ThreeXhaustBenchmarkReport {
	readonly schemaVersion: 1;
	readonly fixture: {
		readonly repetitions: number;
		readonly providerRequests: number;
		readonly toolCalls: number;
	};
	readonly baseline: ThreeXhaustSessionMetrics & { readonly latency: LatencySummary };
	readonly optimized: ThreeXhaustSessionMetrics & { readonly latency: LatencySummary };
	readonly improvement: {
		readonly uncachedInputReduction: number;
		readonly cacheHitRateDelta: number;
		readonly speed: {
			readonly meanLatencyReduction: number;
			readonly p50LatencyReduction: number;
			readonly p95LatencyReduction: number;
			readonly stabilityDelta: number;
		};
	};
	readonly externalProvider: {
		readonly latency: "unmeasured";
		readonly cost: "unmeasured";
		readonly cacheHitRate: "unmeasured";
	};
}

interface LatencySummary {
	readonly meanMs: number;
	readonly p50Ms: number;
	readonly p95Ms: number;
	readonly stability: number;
}

function summarizeLatency(values: readonly number[]): LatencySummary {
	if (values.length === 0 || values.some((value) => !Number.isFinite(value) || value < 0)) {
		throw new Error("Benchmark durations must be finite non-negative values");
	}
	const sorted = [...values].sort((left, right) => left - right);
	const meanMs = sorted.reduce((total, value) => total + value, 0) / sorted.length;
	const percentile = (ratio: number) => sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
	const variance = sorted.reduce((total, value) => total + (value - meanMs) ** 2, 0) / sorted.length;
	const stability = meanMs === 0 ? 1 : Math.max(0, 1 - Math.sqrt(variance) / meanMs);
	return {
		meanMs,
		p50Ms: percentile(0.5),
		p95Ms: percentile(0.95),
		stability,
	};
}

function validateScenario(
	label: "baseline" | "optimized",
	scenario: ThreeXhaustBenchmarkScenario,
	repetitions: number,
): void {
	if (scenario.metrics.providerRequests !== repetitions * 2) {
		throw new Error(`${label} must execute exactly two provider requests per fixture`);
	}
	if (scenario.metrics.modelTurns !== scenario.metrics.providerRequests) {
		throw new Error(`${label} model turns must match provider requests`);
	}
	if (scenario.metrics.tools.calls !== repetitions) {
		throw new Error(`${label} must execute exactly one tool call per fixture`);
	}
	if (
		scenario.metrics.tools.failed !== 0 ||
		scenario.metrics.tools.succeeded !== repetitions ||
		scenario.metrics.tools.successRate !== 1
	) {
		throw new Error(`${label} tool calls must succeed`);
	}
}

export function summarizeThreeXhaustBenchmark(input: ThreeXhaustBenchmarkInput): ThreeXhaustBenchmarkReport {
	if (!Number.isInteger(input.repetitions) || input.repetitions < 2) {
		throw new Error("Benchmark repetitions must be an integer of at least two");
	}
	if (input.baseline.metrics.providerRequests !== input.optimized.metrics.providerRequests) {
		throw new Error("Benchmark scenarios must have identical provider-request counts");
	}
	validateScenario("baseline", input.baseline, input.repetitions);
	validateScenario("optimized", input.optimized, input.repetitions);
	if (input.baseline.metrics.uncachedInputTokens <= 0) {
		throw new Error("Baseline must report uncached input tokens");
	}
	if (input.optimized.metrics.uncachedInputTokens >= input.baseline.metrics.uncachedInputTokens) {
		throw new Error("Optimized scenario must reduce uncached input tokens");
	}
	if (input.optimized.metrics.cache.readTokens <= input.baseline.metrics.cache.readTokens) {
		throw new Error("Optimized scenario must increase cache reads");
	}
	const baselineLatency = summarizeLatency(input.baseline.durationsMs);
	const optimizedLatency = summarizeLatency(input.optimized.durationsMs);
	const reduction = (baseline: number, optimized: number) => (baseline === 0 ? 0 : 1 - optimized / baseline);

	return {
		schemaVersion: 1,
		fixture: {
			repetitions: input.repetitions,
			providerRequests: input.baseline.metrics.providerRequests,
			toolCalls: input.baseline.metrics.tools.calls,
		},
		baseline: {
			...input.baseline.metrics,
			latency: baselineLatency,
		},
		optimized: {
			...input.optimized.metrics,
			latency: optimizedLatency,
		},
		improvement: {
			uncachedInputReduction:
				1 - input.optimized.metrics.uncachedInputTokens / input.baseline.metrics.uncachedInputTokens,
			cacheHitRateDelta: input.optimized.metrics.cache.hitRate - input.baseline.metrics.cache.hitRate,
			speed: {
				meanLatencyReduction: reduction(baselineLatency.meanMs, optimizedLatency.meanMs),
				p50LatencyReduction: reduction(baselineLatency.p50Ms, optimizedLatency.p50Ms),
				p95LatencyReduction: reduction(baselineLatency.p95Ms, optimizedLatency.p95Ms),
				stabilityDelta: optimizedLatency.stability - baselineLatency.stability,
			},
		},
		externalProvider: {
			latency: "unmeasured",
			cost: "unmeasured",
			cacheHitRate: "unmeasured",
		},
	};
}
