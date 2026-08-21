import { parseProjectId, type SemanticTurnRequest } from "@3xhaust/semantic-contract";
import { describe, expect, it } from "vitest";
import {
	checkpointProviderTurn,
	completeActiveTurn,
	createCoordinatorState,
	enqueueTurn,
	handleOutboxFailure,
	markOutboxAccepted,
	markOutboxDispatching,
	markOutboxSettled,
	replaceCoordinatorGeneration,
	restoreCoordinatorState,
	serializeCoordinatorState,
	startNextTurn,
} from "../src/index.ts";

const request = (mode: SemanticTurnRequest["mode"], objective: string): SemanticTurnRequest => ({
	protocolVersion: 2,
	mode,
	objective,
	disclosed: { selectionIds: [], documentIds: [], observationIds: [] },
});

const createState = () =>
	createCoordinatorState({
		sessionId: "session_demo",
		projectId: parseProjectId("prj_demo"),
		generation: 1,
	});

describe("durable turn coordinator", () => {
	it("queues prompt, steer, and follow-up requests in durable FIFO order", async () => {
		let state = createState();
		state = (await enqueueTurn(state, request("prompt", "First"))).state;
		state = startNextTurn(state).state;
		state = (await enqueueTurn(state, request("steer", "Second"))).state;
		state = (await enqueueTurn(state, request("followUp", "Third"))).state;

		expect(state.activeTurn?.request.objective).toBe("First");
		expect(state.queue.map(({ request: queued }) => queued.objective)).toEqual(["Second", "Third"]);

		state = completeActiveTurn(state).state;
		const second = startNextTurn(state);
		expect(second.turn?.request.mode).toBe("steer");
		state = completeActiveTurn(second.state).state;
		expect(startNextTurn(state).turn?.request.mode).toBe("followUp");
	});

	it("suppresses duplicate semantic turns across restart-safe fingerprints", async () => {
		let state = createState();
		const first = await enqueueTurn(state, request("prompt", "Same"));
		state = first.state;
		const duplicate = await enqueueTurn(state, request("prompt", "Same"));
		expect(first.enqueued).toBe(true);
		expect(duplicate.enqueued).toBe(false);
		expect(duplicate.turnId).toBe(first.turnId);
		expect(duplicate.state.queue).toHaveLength(1);
	});

	it("atomically checkpoints a recipe and creates one queued provider outbox record", async () => {
		let state = (await enqueueTurn(createState(), request("prompt", "Inspect"))).state;
		state = startNextTurn(state).state;
		const result = await checkpointProviderTurn(state, {
			turnId: state.activeTurn!.turnId,
			recipeCheckpoint: { kind: "inspect", phase: "evidence" },
			payloadDigest: "sha256:payload",
		});

		expect(result.state.activeTurn?.recipeCheckpoint).toEqual({ kind: "inspect", phase: "evidence" });
		expect(result.outbox).toMatchObject({
			state: "queued",
			generation: 1,
			payloadDigest: "sha256:payload",
		});
		expect(result.state.outbox).toHaveLength(1);
	});

	it("fences late provider responses by runtime generation", async () => {
		let state = (await enqueueTurn(createState(), request("prompt", "Inspect"))).state;
		state = startNextTurn(state).state;
		const checkpoint = await checkpointProviderTurn(state, {
			turnId: state.activeTurn!.turnId,
			recipeCheckpoint: { phase: "provider" },
			payloadDigest: "sha256:payload",
		});
		state = markOutboxDispatching(checkpoint.state, checkpoint.outbox.requestId, 1);
		state = markOutboxAccepted(state, checkpoint.outbox.requestId, 1, "provider_request");
		state = replaceCoordinatorGeneration(state);

		expect(state.generation).toBe(2);
		expect(state.outbox[0]?.state).toBe("indeterminate");
		expect(() => markOutboxSettled(state, checkpoint.outbox.requestId, 1, "sha256:response")).toThrow(/generation/i);
	});

	it("marks ambiguous transmission indeterminate and requeues only proven-safe failures", async () => {
		const setup = async () => {
			let state = (await enqueueTurn(createState(), request("prompt", "Inspect"))).state;
			state = startNextTurn(state).state;
			const checkpoint = await checkpointProviderTurn(state, {
				turnId: state.activeTurn!.turnId,
				recipeCheckpoint: { phase: "provider" },
				payloadDigest: "sha256:payload",
			});
			state = markOutboxDispatching(checkpoint.state, checkpoint.outbox.requestId, 1);
			return { state, requestId: checkpoint.outbox.requestId };
		};
		const ambiguous = await setup();
		expect(
			handleOutboxFailure(ambiguous.state, ambiguous.requestId, 1, {
				conclusivelyRejected: false,
				providerIdempotencyProven: false,
			}).outbox[0]?.state,
		).toBe("indeterminate");
		const rejected = await setup();
		expect(
			handleOutboxFailure(rejected.state, rejected.requestId, 1, {
				conclusivelyRejected: true,
				providerIdempotencyProven: false,
			}).outbox[0],
		).toMatchObject({ state: "queued", dispatchAttempts: 1 });
	});

	it("restores queue order and duplicate suppression from serialized state", async () => {
		let state = createState();
		state = (await enqueueTurn(state, request("prompt", "First"))).state;
		state = (await enqueueTurn(state, request("steer", "Second"))).state;
		const restored = restoreCoordinatorState(serializeCoordinatorState(state));

		expect(restored).toEqual(state);
		expect(startNextTurn(restored).turn?.request.objective).toBe("First");
		expect((await enqueueTurn(restored, request("steer", "Second"))).enqueued).toBe(false);
	});

	it("requires provider settlement before an active turn can complete", async () => {
		let state = (await enqueueTurn(createState(), request("prompt", "Inspect"))).state;
		state = startNextTurn(state).state;
		const checkpoint = await checkpointProviderTurn(state, {
			turnId: state.activeTurn!.turnId,
			recipeCheckpoint: { phase: "provider" },
			payloadDigest: "sha256:payload",
		});
		expect(() => completeActiveTurn(checkpoint.state)).toThrow(/outbox/i);
		state = markOutboxDispatching(checkpoint.state, checkpoint.outbox.requestId, 1);
		state = markOutboxAccepted(state, checkpoint.outbox.requestId, 1, "provider_request");
		state = markOutboxSettled(state, checkpoint.outbox.requestId, 1, "sha256:response");
		expect(completeActiveTurn(state).state.activeTurn).toBeUndefined();
	});
});
