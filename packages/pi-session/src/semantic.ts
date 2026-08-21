import {
	parseSemanticOutput,
	type SemanticOutput,
	type SemanticTurnMode,
	type SemanticTurnRequest,
} from "@3xhaust/semantic-contract";

const NO_TOOLS: readonly never[] = Object.freeze([]);
const EMPTY_DISCLOSED = Object.freeze({
	selectionIds: Object.freeze([]),
	documentIds: Object.freeze([]),
	observationIds: Object.freeze([]),
});

export interface SemanticTurnInput {
	readonly objective: string;
	readonly disclosed?: SemanticTurnRequest["disclosed"];
}

export interface SemanticRequest {
	readonly mode: SemanticTurnMode;
	readonly prompt: string;
	readonly semanticTurn: SemanticTurnRequest;
	readonly repairOf?: string;
	readonly signal: AbortSignal;
	readonly tools: readonly never[];
}

export type SemanticEnvelope = SemanticOutput;

export interface CreateThreeXhaustSemanticSessionInput {
	readonly complete: (request: SemanticRequest) => Promise<string>;
}

function turnInput(value: string | SemanticTurnInput): SemanticTurnInput {
	return typeof value === "string" ? { objective: value } : value;
}

function createTurn(mode: SemanticTurnMode, input: SemanticTurnInput): SemanticTurnRequest {
	return {
		protocolVersion: 2,
		mode,
		objective: input.objective,
		disclosed: input.disclosed ?? EMPTY_DISCLOSED,
	};
}

export function parseSemanticEnvelope(serialized: string): SemanticEnvelope {
	let parsed: unknown;
	try {
		parsed = JSON.parse(serialized);
	} catch {
		throw new Error("Semantic response must be valid JSON");
	}
	try {
		return parseSemanticOutput(parsed);
	} catch (error) {
		const detail = error instanceof Error ? error.message : "unknown validation failure";
		throw new Error(`Semantic response violates protocol v2: ${detail}`);
	}
}

export class ThreeXhaustSemanticSession {
	readonly #complete: CreateThreeXhaustSemanticSessionInput["complete"];
	#activeController: AbortController | undefined;

	constructor(input: CreateThreeXhaustSemanticSessionInput) {
		this.#complete = input.complete;
	}

	async prompt(input: string | SemanticTurnInput): Promise<SemanticEnvelope> {
		return this.#run("prompt", input);
	}

	async steer(input: string | SemanticTurnInput): Promise<SemanticEnvelope> {
		return this.#run("steer", input);
	}

	async followUp(input: string | SemanticTurnInput): Promise<SemanticEnvelope> {
		return this.#run("followUp", input);
	}

	abort(): void {
		this.#activeController?.abort();
	}

	async #run(mode: SemanticTurnMode, value: string | SemanticTurnInput): Promise<SemanticEnvelope> {
		if (this.#activeController && !this.#activeController.signal.aborted) {
			throw new Error("Semantic session is already processing a turn");
		}
		const controller = new AbortController();
		const input = turnInput(value);
		const semanticTurn = createTurn(mode, input);
		this.#activeController = controller;
		try {
			const first = await this.#complete({
				mode,
				prompt: input.objective,
				semanticTurn,
				signal: controller.signal,
				tools: NO_TOOLS,
			});
			try {
				return parseSemanticEnvelope(first);
			} catch {
				const repaired = await this.#complete({
					mode,
					prompt: `${input.objective}\nReturn exactly one strict protocolVersion 2 semantic JSON envelope.`,
					semanticTurn,
					repairOf: first,
					signal: controller.signal,
					tools: NO_TOOLS,
				});
				try {
					return parseSemanticEnvelope(repaired);
				} catch (error) {
					const detail = error instanceof Error ? error.message : "unknown validation failure";
					throw new Error(`Semantic response remained invalid after one repair: ${detail}`);
				}
			}
		} finally {
			if (this.#activeController === controller) this.#activeController = undefined;
		}
	}
}

export function createThreeXhaustSemanticSession(
	input: CreateThreeXhaustSemanticSessionInput,
): ThreeXhaustSemanticSession {
	return new ThreeXhaustSemanticSession(input);
}
