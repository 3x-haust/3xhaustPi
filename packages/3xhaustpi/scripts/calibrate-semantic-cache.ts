import { cleanupSessionResources } from "@earendil-works/pi-ai";
import { parseSemanticTurnRequest } from "@3xhaust/semantic-contract";
import {
	createThreeXhaustPiAdapter,
	semanticProviderSessionId,
	X3HAUST_SEMANTIC_STABLE_PREFIX,
} from "../../pi-adapter/src/index.ts";
import { createStableProjectEvidence } from "../src/project-evidence.ts";
import { createProviderRuntime, resolveModel } from "../src/provider-runtime.ts";

const [projectRoot, ...characterArguments] = process.argv.slice(2);
if (!projectRoot) throw new Error("Usage: calibrate-semantic-cache <project> [evidence-character-count ...]");

const characterCounts = characterArguments.length
	? characterArguments.map(Number)
	: [14_000, 14_500, 15_000, 15_500, 16_000];
const provider = "openai-codex";
const modelIds = (process.env.X3HAUSTPI_CALIBRATION_MODELS ?? "gpt-5.6-terra")
	.split(",")
	.map((value) => value.trim())
	.filter(Boolean);
const attemptCount = Number(process.env.X3HAUSTPI_CALIBRATION_ATTEMPTS ?? "5");
if (!Number.isSafeInteger(attemptCount) || attemptCount < 2) throw new Error("Calibration attempts must be at least 2");
const objective =
	process.env.X3HAUSTPI_CALIBRATION_OBJECTIVE ??
	'Return inspect for {"kind":"symbol","hint":"X3HAUST_SEMANTIC_STABLE_PREFIX"}.';
const models = createProviderRuntime();
if (!(await models.checkAuth(provider))) throw new Error(`Provider is not authenticated: ${provider}`);

for (const modelId of modelIds) {
	const model = resolveModel(models, provider, modelId);
	for (const maximumCharacters of characterCounts) {
		const evidence = createStableProjectEvidence(projectRoot, maximumCharacters);
		const promptVersion = /cache-v(\d+)/.exec(X3HAUST_SEMANTIC_STABLE_PREFIX)?.[1] ?? "unknown";
		const sessionId = `cache-v${promptVersion}-${modelId.slice(-12)}-${evidence.sha256.slice(0, 16)}`;
		const adapter = createThreeXhaustPiAdapter({
			complete: (requestModel, context, options) => models.completeSimple(requestModel, context, options),
		});
		const usages: Array<{ input: number; cacheRead: number; cacheWrite: number }> = [];
		const errors: string[] = [];
		for (let attempt = 0; attempt < attemptCount; attempt += 1) {
			const session = adapter.open({
				connectionId: "connection_cache_calibration",
				model,
				sessionId,
				cacheRetention: "long",
				cacheUsageSupport: { read: "reported", write: "reported" },
				stableContext: evidence.text,
				maxTokens: 256,
			});
			try {
				const result = await session.submit(
					parseSemanticTurnRequest({
						protocolVersion: 2,
						mode: "prompt",
						objective,
						disclosed: { selectionIds: [], documentIds: [], observationIds: [] },
					}),
					AbortSignal.timeout(30_000),
				);
				usages.push({
					input: result.usage.input.status === "measured" ? result.usage.input.value : 0,
					cacheRead: result.usage.cacheRead.status === "measured" ? result.usage.cacheRead.value : 0,
					cacheWrite: result.usage.cacheWrite.status === "measured" ? result.usage.cacheWrite.value : 0,
				});
			} catch (error) {
				errors.push(error instanceof Error ? error.message : String(error));
			} finally {
				await session.close();
			}
		}
		const measured = usages.at(-1) ?? { input: 0, cacheRead: 0, cacheWrite: 0 };
		const total = measured.input + measured.cacheRead + measured.cacheWrite;
		console.log(JSON.stringify({
			model: modelId,
			maximumCharacters,
			evidenceCharacters: evidence.text.length,
			totalInputTokens: total,
			cacheReadTokens: measured.cacheRead,
			cachedTokenRatio: total === 0 ? 0 : measured.cacheRead / total,
			usages,
			errors,
		}));
		for (const phase of ["initial", "followup"] as const) {
			cleanupSessionResources(semanticProviderSessionId(sessionId, phase));
			cleanupSessionResources(semanticProviderSessionId(sessionId, phase, true));
		}
	}
}
