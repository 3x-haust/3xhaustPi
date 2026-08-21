import { describe, expect, it } from "vitest";
import { type ArmSample, summarizeRealBenchmarkSamples } from "../src/real-benchmark.ts";

function sample(overrides: Partial<ArmSample> = {}): ArmSample {
	return {
		arm: "semantic-only",
		pair: 1,
		caseId: "fixture-case",
		expectedCapability: "searchSymbol",
		success: true,
		latencyMs: 100,
		uncachedInputTokens: 10,
		outputTokens: 2,
		cacheReadTokens: 90,
		cacheWriteTokens: 0,
		providerRequestInputTokens: [100],
		providerRequestCacheReadTokens: [90],
		modelOutputValid: true,
		providerRequests: 1,
		repairAttempts: 0,
		normalizationApplied: 0,
		capabilityStarted: 1,
		capabilityCompleted: 1,
		capabilitySucceeded: 1,
		capabilityLatencyMs: 2,
		...overrides,
	};
}

describe("real benchmark summary", () => {
	it("separates provider latency, capability latency, cache provenance, repairs, and orphans", () => {
		const result = summarizeRealBenchmarkSamples([
			sample(),
			sample({
				pair: 2,
				latencyMs: 300,
				capabilityLatencyMs: 6,
				providerRequests: 2,
				repairAttempts: 1,
				normalizationApplied: 1,
				cacheReadTokens: 0,
				uncachedInputTokens: 100,
				providerRequestCacheReadTokens: [0, 0],
				providerRequestInputTokens: [100, 100],
			}),
		]);

		expect(result.successes).toBe(2);
		expect(result.providerReportedWarmCacheHitRequestRate).toBeCloseTo(1 / 3);
		expect(result.providerReportedWarmCachedTokenRatio).toBeCloseTo(90 / 200);
		expect(result.repairAttempts).toBe(1);
		expect(result.repairRate).toBe(0.5);
		expect(result.normalizationAttempts).toBe(1);
		expect(result.normalizationRate).toBe(0.5);
		expect(result.capabilityOrphanCount).toBe(0);
		expect(result.latencyMs).toMatchObject({ mean: 200, p50: 100, p95: 100 });
		expect(result.capabilityLatencyMs).toMatchObject({ mean: 4, p50: 2, p95: 2 });
		expect(result.throughputPerMinute).toBe(300);
	});

	it("reports a started but incomplete capability as an orphan", () => {
		const result = summarizeRealBenchmarkSamples([
			sample({
				success: false,
				capabilityCompleted: 0,
				capabilitySucceeded: 0,
				capabilityLatencyMs: 0,
			}),
		]);
		expect(result.capabilityOrphanCount).toBe(1);
		expect(result.capabilityLatencyMs.count).toBe(0);
	});
});
