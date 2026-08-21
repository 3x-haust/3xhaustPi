import { resolve } from "node:path";
import { runCacheTokenBenchmark } from "../src/cache-token-benchmark.ts";

const [projectArgument, artifactArgument, repetitionsArgument = "20", provider = "openai-codex", model = "gpt-5.4-mini"] =
	process.argv.slice(2);

if (!projectArgument || !artifactArgument) {
	throw new Error(
		"Usage: run-cache-token-benchmark <project> <artifact.json> [repetitions] [provider] [model]",
	);
}

const repetitions = Number(repetitionsArgument);
if (!Number.isSafeInteger(repetitions) || repetitions < 20) {
	throw new Error("repetitions must be an integer of at least 20");
}

const report = (await runCacheTokenBenchmark({
	projectRoot: resolve(projectArgument),
	artifactPath: resolve(artifactArgument),
	repetitions,
	warmups: 3,
	provider,
	model,
	onProgress: (message) => console.error(message),
})) as {
	readonly accepted: boolean;
	readonly summary: unknown;
};

console.log(JSON.stringify({ accepted: report.accepted, summary: report.summary }, null, 2));
