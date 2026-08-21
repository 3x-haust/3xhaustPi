import type { Usage } from "@earendil-works/pi-ai";
import type { CacheUsageSupport, ProviderNumber, SemanticTurnUsage } from "./types.ts";

const measured = (value: number): ProviderNumber => ({ status: "measured", value, source: "provider-usage" });

function cacheMetric(kind: "read" | "write", value: number, support: CacheUsageSupport): ProviderNumber {
	if (support === "reported") return measured(value);
	if (support === "unsupported") {
		return { status: "unsupported", reason: `provider does not report cache ${kind}s` };
	}
	return { status: "unmeasured", reason: `cache ${kind} provenance is unknown` };
}

export function summarizeUsage(
	usages: readonly Usage[],
	support: { readonly read: CacheUsageSupport; readonly write: CacheUsageSupport },
): SemanticTurnUsage {
	const total = usages.reduce(
		(sum, usage) => ({
			input: sum.input + usage.input,
			output: sum.output + usage.output,
			cacheRead: sum.cacheRead + usage.cacheRead,
			cacheWrite: sum.cacheWrite + usage.cacheWrite,
		}),
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	);
	return {
		input: measured(total.input),
		output: measured(total.output),
		cacheRead: cacheMetric("read", total.cacheRead, support.read),
		cacheWrite: cacheMetric("write", total.cacheWrite, support.write),
	};
}
