import {
	type ProjectId,
	parseProjectId,
	parseSemanticTurnRequest,
	type SemanticTurnRequest,
} from "@3xhaust/semantic-contract";
import { canonicalJson, sha256 } from "./canonical.ts";

export type ProviderOutboxState = "queued" | "dispatching" | "accepted" | "settled" | "indeterminate";

export interface CoordinatorTurn {
	readonly turnId: string;
	readonly fingerprint: string;
	readonly request: SemanticTurnRequest;
	readonly recipeCheckpoint?: Readonly<Record<string, unknown>>;
}

export interface ProviderOutboxRecord {
	readonly requestId: string;
	readonly turnId: string;
	readonly generation: number;
	readonly payloadDigest: string;
	readonly state: ProviderOutboxState;
	readonly dispatchAttempts: number;
	readonly providerRequestId?: string;
	readonly responseDigest?: string;
}

export interface CoordinatorState {
	readonly schemaVersion: 1;
	readonly sessionId: string;
	readonly projectId: ProjectId;
	readonly generation: number;
	readonly queue: readonly CoordinatorTurn[];
	readonly activeTurn?: CoordinatorTurn;
	readonly seen: Readonly<Record<string, string>>;
	readonly outbox: readonly ProviderOutboxRecord[];
}

interface CoordinatorIdentity {
	readonly sessionId: string;
	readonly projectId: ProjectId;
	readonly generation: number;
}

function assertIdentifier(value: string, label: string): void {
	if (!/^[A-Za-z0-9._:-]{3,128}$/u.test(value)) throw new Error(`${label} is invalid`);
}

function assertGeneration(value: number): void {
	if (!Number.isSafeInteger(value) || value < 1) throw new Error("Coordinator generation is invalid");
}

function updateOutbox(
	state: CoordinatorState,
	requestId: string,
	generation: number,
	update: (record: ProviderOutboxRecord) => ProviderOutboxRecord,
): CoordinatorState {
	assertGeneration(generation);
	const index = state.outbox.findIndex((record) => record.requestId === requestId);
	if (index < 0) throw new Error("Provider outbox request is unavailable");
	const current = state.outbox[index]!;
	if (generation !== state.generation || current.generation !== generation) {
		throw new Error("Provider outbox generation is stale");
	}
	const outbox = [...state.outbox];
	outbox[index] = update(current);
	return { ...state, outbox };
}

export function createCoordinatorState(input: CoordinatorIdentity): CoordinatorState {
	assertIdentifier(input.sessionId, "Session id");
	assertGeneration(input.generation);
	return {
		schemaVersion: 1,
		sessionId: input.sessionId,
		projectId: parseProjectId(input.projectId),
		generation: input.generation,
		queue: [],
		seen: {},
		outbox: [],
	};
}

export async function enqueueTurn(
	state: CoordinatorState,
	requestInput: SemanticTurnRequest,
): Promise<{
	readonly state: CoordinatorState;
	readonly enqueued: boolean;
	readonly turnId: string;
}> {
	const request = parseSemanticTurnRequest(requestInput);
	const fingerprint = `sha256:${await sha256(request)}`;
	const duplicate = state.seen[fingerprint];
	if (duplicate) return { state, enqueued: false, turnId: duplicate };
	const turnId = `turn_${fingerprint.slice("sha256:".length, "sha256:".length + 32)}`;
	const turn: CoordinatorTurn = { turnId, fingerprint, request };
	return {
		state: {
			...state,
			queue: [...state.queue, turn],
			seen: { ...state.seen, [fingerprint]: turnId },
		},
		enqueued: true,
		turnId,
	};
}

export function startNextTurn(state: CoordinatorState): {
	readonly state: CoordinatorState;
	readonly turn?: CoordinatorTurn;
} {
	if (state.activeTurn) throw new Error("A coordinator turn is already active");
	const [turn, ...queue] = state.queue;
	if (!turn) return { state };
	return { state: { ...state, queue, activeTurn: turn }, turn };
}

export async function checkpointProviderTurn(
	state: CoordinatorState,
	input: {
		readonly turnId: string;
		readonly recipeCheckpoint: Readonly<Record<string, unknown>>;
		readonly payloadDigest: string;
	},
): Promise<{ readonly state: CoordinatorState; readonly outbox: ProviderOutboxRecord }> {
	const active = state.activeTurn;
	if (!active || active.turnId !== input.turnId) throw new Error("Provider checkpoint turn is not active");
	if (!/^sha256:[A-Za-z0-9._:-]+$/u.test(input.payloadDigest)) {
		throw new Error("Provider payload digest is invalid");
	}
	const existing = state.outbox.find((record) => record.turnId === input.turnId);
	if (existing) throw new Error("Provider outbox already exists for the active turn");
	const requestDigest = await sha256({
		sessionId: state.sessionId,
		turnId: input.turnId,
		generation: state.generation,
		payloadDigest: input.payloadDigest,
	});
	const outbox: ProviderOutboxRecord = {
		requestId: `out_${requestDigest.slice(0, 32)}`,
		turnId: input.turnId,
		generation: state.generation,
		payloadDigest: input.payloadDigest,
		state: "queued",
		dispatchAttempts: 0,
	};
	return {
		state: {
			...state,
			activeTurn: { ...active, recipeCheckpoint: structuredClone(input.recipeCheckpoint) },
			outbox: [...state.outbox, outbox],
		},
		outbox,
	};
}

export function markOutboxDispatching(
	state: CoordinatorState,
	requestId: string,
	generation: number,
): CoordinatorState {
	return updateOutbox(state, requestId, generation, (record) => {
		if (record.state !== "queued") throw new Error("Provider outbox is not queued");
		return { ...record, state: "dispatching", dispatchAttempts: record.dispatchAttempts + 1 };
	});
}

export function markOutboxAccepted(
	state: CoordinatorState,
	requestId: string,
	generation: number,
	providerRequestId: string,
): CoordinatorState {
	assertIdentifier(providerRequestId, "Provider request id");
	return updateOutbox(state, requestId, generation, (record) => {
		if (record.state !== "dispatching") throw new Error("Provider outbox is not dispatching");
		return { ...record, state: "accepted", providerRequestId };
	});
}

export function markOutboxSettled(
	state: CoordinatorState,
	requestId: string,
	generation: number,
	responseDigest: string,
): CoordinatorState {
	if (!/^sha256:[A-Za-z0-9._:-]+$/u.test(responseDigest)) {
		throw new Error("Provider response digest is invalid");
	}
	return updateOutbox(state, requestId, generation, (record) => {
		if (record.state !== "accepted") throw new Error("Provider outbox is not accepted");
		return { ...record, state: "settled", responseDigest };
	});
}

export function handleOutboxFailure(
	state: CoordinatorState,
	requestId: string,
	generation: number,
	evidence: {
		readonly conclusivelyRejected: boolean;
		readonly providerIdempotencyProven: boolean;
	},
): CoordinatorState {
	return updateOutbox(state, requestId, generation, (record) => {
		if (record.state !== "dispatching" && record.state !== "accepted") {
			throw new Error("Provider outbox is not in flight");
		}
		if (evidence.conclusivelyRejected || evidence.providerIdempotencyProven) {
			return {
				...record,
				state: "queued",
				providerRequestId: undefined,
				responseDigest: undefined,
			};
		}
		return { ...record, state: "indeterminate" };
	});
}

export function replaceCoordinatorGeneration(state: CoordinatorState): CoordinatorState {
	const generation = state.generation + 1;
	assertGeneration(generation);
	return {
		...state,
		generation,
		outbox: state.outbox.map((record) => {
			if (record.state === "dispatching" || record.state === "accepted") {
				return { ...record, state: "indeterminate" };
			}
			if (record.state === "queued") return { ...record, generation };
			return record;
		}),
	};
}

export function completeActiveTurn(state: CoordinatorState): { readonly state: CoordinatorState } {
	const active = state.activeTurn;
	if (!active) throw new Error("No coordinator turn is active");
	const incomplete = state.outbox.some((record) => record.turnId === active.turnId && record.state !== "settled");
	if (incomplete) throw new Error("Provider outbox must settle before completing the active turn");
	const { activeTurn: _activeTurn, ...rest } = state;
	return { state: rest };
}

export function serializeCoordinatorState(state: CoordinatorState): string {
	return canonicalJson(state);
}

export function restoreCoordinatorState(serialized: string): CoordinatorState {
	const candidate = JSON.parse(serialized) as Partial<CoordinatorState>;
	if (candidate.schemaVersion !== 1 || typeof candidate.sessionId !== "string") {
		throw new Error("Coordinator checkpoint version is unsupported");
	}
	const restored = createCoordinatorState({
		sessionId: candidate.sessionId,
		projectId: parseProjectId(candidate.projectId),
		generation: candidate.generation ?? 0,
	});
	const queue = Array.isArray(candidate.queue)
		? candidate.queue.map((turn) => ({
				...turn,
				request: parseSemanticTurnRequest(turn.request),
			}))
		: [];
	const activeTurn = candidate.activeTurn
		? { ...candidate.activeTurn, request: parseSemanticTurnRequest(candidate.activeTurn.request) }
		: undefined;
	const seen =
		typeof candidate.seen === "object" && candidate.seen !== null
			? Object.fromEntries(
					Object.entries(candidate.seen).map(([fingerprint, turnId]) => {
						if (typeof turnId !== "string") throw new Error("Coordinator duplicate index is invalid");
						return [fingerprint, turnId];
					}),
				)
			: {};
	const outbox = Array.isArray(candidate.outbox)
		? candidate.outbox.map((record) => {
				if (
					typeof record.requestId !== "string" ||
					typeof record.turnId !== "string" ||
					!["queued", "dispatching", "accepted", "settled", "indeterminate"].includes(record.state)
				) {
					throw new Error("Coordinator outbox checkpoint is invalid");
				}
				return record;
			})
		: [];
	return { ...restored, queue, ...(activeTurn ? { activeTurn } : {}), seen, outbox };
}
