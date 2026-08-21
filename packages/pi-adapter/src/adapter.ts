import { parseSemanticOutput, type SemanticOutput, type SemanticTurnRequest } from "@3xhaust/semantic-contract";
import type { AssistantMessage, ImageContent, Models, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import { PiAdapterError } from "./errors.ts";
import { summarizeUsage } from "./metrics.ts";
import { createSemanticContext, X3HAUST_SEMANTIC_STABLE_PREFIX } from "./prompt.ts";
import type {
	CreateThreeXhaustPiAdapterInput,
	PiSemanticConnectionBinding,
	PiSemanticModelPort,
	PiSemanticModelSession,
	SemanticTurnResult,
} from "./types.ts";

function responseText(message: AssistantMessage): string {
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		const detail = message.errorMessage?.trim();
		throw new PiAdapterError(
			"PROVIDER_ERROR",
			`Semantic provider request ${message.stopReason}${detail ? `: ${detail}` : ""}`,
		);
	}
	if (message.content.some((content) => content.type === "toolCall")) {
		throw new PiAdapterError("INVALID_SEMANTIC_OUTPUT", "Semantic provider returned a tool call");
	}
	const text = message.content
		.filter((content) => content.type === "text")
		.map((content) => content.text)
		.join("");
	if (text.length === 0) {
		throw new PiAdapterError("INVALID_SEMANTIC_OUTPUT", "Semantic provider returned no text");
	}
	return text;
}

function parseResponse(message: AssistantMessage): {
	readonly output: SemanticOutput;
	readonly text: string;
	readonly normalization: "none" | "trailing-delimiter";
} {
	const text = responseText(message).trim();
	let parsed: unknown;
	let normalization: "none" | "trailing-delimiter" = "none";
	try {
		parsed = JSON.parse(text) as unknown;
	} catch (initialError) {
		const candidate = text.endsWith("}") || text.endsWith("]") ? text.slice(0, -1) : undefined;
		if (candidate !== undefined) {
			try {
				parsed = JSON.parse(candidate) as unknown;
				normalization = "trailing-delimiter";
			} catch {
				// Preserve the original parse failure below.
			}
		}
		if (parsed === undefined) {
			const detail = initialError instanceof Error ? initialError.message : String(initialError);
			throw new PiAdapterError(
				"INVALID_SEMANTIC_OUTPUT",
				`Semantic provider returned invalid JSON (${detail}): ${JSON.stringify(text.slice(0, 1_000))}`,
			);
		}
	}
	try {
		return { output: parseSemanticOutput(parsed), text, normalization };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new PiAdapterError(
			"INVALID_SEMANTIC_OUTPUT",
			`Semantic provider violated protocol v2 (${detail}): ${text.slice(0, 1_000)}`,
		);
	}
}

function validateDisclosedReferences(output: SemanticOutput, turn: SemanticTurnRequest): SemanticOutput {
	const documents = new Set(turn.disclosed.documentIds);
	const selections = new Set(turn.disclosed.selectionIds);
	const observations = new Set(turn.disclosed.observationIds);
	if (output.kind === "patchProposal") {
		for (const edit of output.payload.edits) {
			if (!documents.has(edit.documentId)) {
				throw new PiAdapterError(
					"INVALID_SEMANTIC_OUTPUT",
					`Patch references undisclosed document ${edit.documentId}`,
				);
			}
		}
		return output;
	}
	if (output.payload.kind === "complete") {
		for (const claim of output.payload.claims) {
			if (!observations.has(claim.observationRef)) {
				throw new PiAdapterError(
					"INVALID_SEMANTIC_OUTPUT",
					`Completion claim references undisclosed observation ${claim.observationRef}`,
				);
			}
		}
		return output;
	}
	if (output.payload.kind === "clarify") return output;
	const target = output.payload.target;
	if (target.kind === "selection" && !selections.has(target.selectionId)) {
		throw new PiAdapterError(
			"INVALID_SEMANTIC_OUTPUT",
			`Intent references undisclosed selection ${target.selectionId}`,
		);
	}
	if (target.kind === "documents") {
		for (const documentId of target.documentIds) {
			if (!documents.has(documentId)) {
				throw new PiAdapterError("INVALID_SEMANTIC_OUTPUT", `Intent references undisclosed document ${documentId}`);
			}
		}
	}
	return output;
}

export function semanticProviderSessionId(
	baseSessionId: string,
	phase: "initial" | "followup",
	repair = false,
): string {
	return `${baseSessionId}-${phase}${repair ? "-repair" : ""}`;
}

class ThreeXhaustPiSemanticSession implements PiSemanticModelSession {
	readonly #binding: PiSemanticConnectionBinding;
	readonly #complete: CreateThreeXhaustPiAdapterInput["complete"];
	readonly #now: () => number;
	#closed = false;

	constructor(
		binding: PiSemanticConnectionBinding,
		complete: CreateThreeXhaustPiAdapterInput["complete"],
		now: () => number,
	) {
		this.#binding = binding;
		this.#complete = complete;
		this.#now = now;
	}

	async submit(
		turn: SemanticTurnRequest,
		signal: AbortSignal,
		images: readonly ImageContent[] = [],
	): Promise<SemanticTurnResult> {
		if (this.#closed) throw new PiAdapterError("CLOSED", "Semantic model session is closed");
		const startedAt = this.#now();
		const usages: Usage[] = [];
		const phase = turn.mode === "followUp" ? "followup" : "initial";
		const phaseCacheKey = semanticProviderSessionId(this.#binding.sessionId, phase);
		const options: SimpleStreamOptions = {
			signal,
			cacheRetention: this.#binding.cacheRetention,
			sessionId: phaseCacheKey,
			promptCacheKey: phaseCacheKey,
			...(this.#binding.model.api === "openai-codex-responses" ? { transport: "websocket" as const } : {}),
			maxRetries: 0,
			maxTokens: this.#binding.maxTokens ?? 4_096,
		};
		const first = await this.#complete(
			this.#binding.model,
			createSemanticContext(turn, undefined, this.#binding.stableContext, undefined, images),
			options,
		);
		usages.push(first.usage);
		let finalMessage = first;
		let output: SemanticOutput;
		let normalization: SemanticTurnResult["normalization"] = "none";
		let attempts: 1 | 2 = 1;
		try {
			const parsed = parseResponse(first);
			output = validateDisclosedReferences(parsed.output, turn);
			normalization = parsed.normalization;
		} catch (error) {
			if (error instanceof PiAdapterError && error.code === "PROVIDER_ERROR") throw error;
			attempts = 2;
			const repairReason = error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000);
			const invalidText = first.content
				.filter((content) => content.type === "text")
				.map((content) => content.text)
				.join("");
			finalMessage = await this.#complete(
				this.#binding.model,
				createSemanticContext(turn, invalidText, this.#binding.stableContext, repairReason, images),
				{
					...options,
					sessionId: semanticProviderSessionId(this.#binding.sessionId, phase, true),
					promptCacheKey: semanticProviderSessionId(this.#binding.sessionId, phase, true),
				},
			);
			usages.push(finalMessage.usage);
			try {
				const parsed = parseResponse(finalMessage);
				output = validateDisclosedReferences(parsed.output, turn);
				normalization = parsed.normalization;
			} catch (error) {
				if (error instanceof PiAdapterError && error.code === "PROVIDER_ERROR") throw error;
				const detail = error instanceof Error ? error.message : String(error);
				throw new PiAdapterError(
					"INVALID_SEMANTIC_OUTPUT",
					`Semantic provider output remained invalid after one repair: ${detail}`,
				);
			}
		}
		return {
			output,
			attempts,
			normalization,
			latencyMs: Math.max(0, this.#now() - startedAt),
			provider: finalMessage.provider,
			model: finalMessage.model,
			...(finalMessage.responseId === undefined ? {} : { responseId: finalMessage.responseId }),
			usage: summarizeUsage(usages, this.#binding.cacheUsageSupport),
		};
	}

	async close(): Promise<void> {
		this.#closed = true;
	}
}

export const createModelsPiComplete =
	(models: Models): CreateThreeXhaustPiAdapterInput["complete"] =>
	(model, context, options) =>
		models.completeSimple(model, context, options);

export function createThreeXhaustPiAdapter(input: CreateThreeXhaustPiAdapterInput): PiSemanticModelPort {
	const now = input.now ?? Date.now;
	return {
		stablePrefix: X3HAUST_SEMANTIC_STABLE_PREFIX,
		open(binding) {
			return new ThreeXhaustPiSemanticSession(binding, input.complete, now);
		},
	};
}
