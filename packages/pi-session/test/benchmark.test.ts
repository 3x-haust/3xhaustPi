import { describe, expect, it } from "vitest";
import { summarizeThreeXhaustBenchmark, type ThreeXhaustSessionMetrics } from "../src/index.ts";

function metrics(input: {
	readonly uncachedInputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
}): ThreeXhaustSessionMetrics {
	const eligibleTokens = input.uncachedInputTokens + input.cacheReadTokens + input.cacheWriteTokens;
	return {
		providerRequests: 16,
		modelTurns: 16,
		uncachedInputTokens: input.uncachedInputTokens,
		outputTokens: 128,
		cache: {
			readTokens: input.cacheReadTokens,
			writeTokens: input.cacheWriteTokens,
			eligibleTokens,
			hitRate: eligibleTokens === 0 ? 0 : input.cacheReadTokens / eligibleTokens,
		},
		tools: {
			calls: 8,
			succeeded: 8,
			failed: 0,
			successRate: 1,
		},
	};
}

describe("3xhaustpi benchmark integrity", () => {
	it("compares identical fixtures and reports cache gains without inventing provider claims", () => {
		const report = summarizeThreeXhaustBenchmark({
			repetitions: 8,
			baseline: {
				metrics: metrics({
					uncachedInputTokens: 80_000,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
				}),
				durationsMs: [8, 7, 9, 8, 8, 7, 9, 8],
			},
			optimized: {
				metrics: metrics({
					uncachedInputTokens: 12_000,
					cacheReadTokens: 68_000,
					cacheWriteTokens: 10_000,
				}),
				durationsMs: [7, 7, 8, 7, 8, 7, 8, 7],
			},
		});

		expect(report.fixture).toEqual({
			repetitions: 8,
			providerRequests: 16,
			toolCalls: 8,
		});
		expect(report.improvement.uncachedInputReduction).toBeCloseTo(0.85);
		expect(report.improvement.cacheHitRateDelta).toBeGreaterThan(0.7);
		expect(report.improvement.speed.meanLatencyReduction).toBeGreaterThan(0);
		expect(report.improvement.speed.p50LatencyReduction).toBeGreaterThan(0);
		expect(report.improvement.speed.p95LatencyReduction).toBeGreaterThan(0);
		expect(Number.isFinite(report.improvement.speed.stabilityDelta)).toBe(true);
		expect(report.optimized.tools.successRate).toBe(1);
		expect(report.externalProvider).toEqual({
			latency: "unmeasured",
			cost: "unmeasured",
			cacheHitRate: "unmeasured",
		});
	});

	it("rejects unequal or unhealthy benchmark scenarios", () => {
		const healthy = metrics({
			uncachedInputTokens: 10_000,
			cacheReadTokens: 70_000,
			cacheWriteTokens: 10_000,
		});
		expect(() =>
			summarizeThreeXhaustBenchmark({
				repetitions: 8,
				baseline: {
					metrics: metrics({
						uncachedInputTokens: 80_000,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
					}),
					durationsMs: [1, 1, 1, 1, 1, 1, 1, 1],
				},
				optimized: {
					metrics: { ...healthy, providerRequests: 15 },
					durationsMs: [1, 1, 1, 1, 1, 1, 1, 1],
				},
			}),
		).toThrow("identical provider-request counts");

		expect(() =>
			summarizeThreeXhaustBenchmark({
				repetitions: 8,
				baseline: { metrics: healthy, durationsMs: [1] },
				optimized: {
					metrics: { ...healthy, tools: { calls: 8, succeeded: 7, failed: 1, successRate: 0.875 } },
					durationsMs: [1],
				},
			}),
		).toThrow("tool calls must succeed");
	});
});
