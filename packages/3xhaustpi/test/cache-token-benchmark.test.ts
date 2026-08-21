import { describe, expect, it } from "vitest";
import { type CacheTokenSample, summarizeCacheTokenSamples } from "../src/cache-token-benchmark.ts";

function sample(index: number, success = true): CacheTokenSample {
	return {
		index,
		warmup: false,
		success,
		decision: "completionSuggestion",
		latencyMs: 100 + index,
		providerCalls: [
			{
				responseId: `response_${index}_initial`,
				uncachedInputTokens: 120,
				cacheReadTokens: 6_912,
				totalInputTokens: 7_032,
				cachedTokenRatio: 6_912 / 7_032,
				outputTokens: 80,
				latencyMs: 40,
			},
			{
				responseId: `response_${index}_followup`,
				uncachedInputTokens: 147,
				cacheReadTokens: 6_912,
				totalInputTokens: 7_059,
				cachedTokenRatio: 6_912 / 7_059,
				outputTokens: 80,
				latencyMs: 50,
			},
		],
		capabilityStarted: 1,
		capabilityCompleted: 1,
		capabilitySucceeded: success ? 1 : 0,
		capabilityLatencyMs: 5,
	};
}

describe("cache-token benchmark summary", () => {
	it("uses provider cacheRead tokens instead of request-level cache hits", () => {
		const summary = summarizeCacheTokenSamples(Array.from({ length: 20 }, (_, index) => sample(index + 1)));

		expect(summary.successfulSamples).toBe(20);
		expect(summary.providerCalls).toBe(40);
		expect(summary.providerReportedCacheHitRequestRate).toBe(1);
		expect(summary.providerReportedCachedTokenRatio).toBeGreaterThan(0.98);
		expect(summary.capabilitySuccessRate).toBe(1);
		expect(summary.capabilityOrphanCount).toBe(0);
	});

	it("keeps failed task attempts visible", () => {
		const summary = summarizeCacheTokenSamples([sample(1), sample(2, false)]);

		expect(summary.taskSuccessRate).toBe(0.5);
		expect(summary.capabilitySuccessRate).toBe(0.5);
	});
});
