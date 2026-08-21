import { SemanticContractError } from "./errors.ts";
import type {
	ArtifactId,
	ClarifyIntent,
	CompleteIntent,
	CompletionClaim,
	DocumentId,
	Intent,
	ObservationId,
	PatchProposal,
	ProjectId,
	ProposedEdit,
	SelectionId,
	SemanticOutput,
	SemanticTarget,
	SemanticTurnMode,
	SemanticTurnRequest,
	WorkIntent,
} from "./types.ts";

const MAX_TEXT = 4_096;
const MAX_SOURCE_TEXT = 1_048_576;
const MAX_LIST = 64;
const ID_SUFFIX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,126}$/;

export type SafeParseResult<T> =
	| { readonly success: true; readonly data: T }
	| { readonly success: false; readonly error: SemanticContractError };

function fail(code: ConstructorParameters<typeof SemanticContractError>[0], message: string): never {
	throw new SemanticContractError(code, message);
}

function object(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		fail("INVALID_TYPE", "Semantic value must be an object");
	}
	return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
	const allowed = new Set([...required, ...optional]);
	if (required.some((key) => !(key in value)) || Object.keys(value).some((key) => !allowed.has(key))) {
		fail("INVALID_KEYS", "Semantic value has invalid keys");
	}
}

function text(value: unknown, options: { readonly max?: number; readonly nonEmpty?: boolean } = {}): string {
	if (typeof value !== "string") fail("INVALID_TEXT", "Declared text must be a string");
	if (options.nonEmpty && value.length === 0) fail("INVALID_LENGTH", "Declared text must not be empty");
	if (value.length > (options.max ?? MAX_TEXT)) fail("INVALID_LENGTH", "Declared text exceeds maximum length");
	return value;
}

function list<T>(
	value: unknown,
	parse: (item: unknown) => T,
	options: { readonly nonEmpty?: boolean } = {},
): readonly T[] {
	if (!Array.isArray(value)) fail("INVALID_TYPE", "Semantic list must be an array");
	if (options.nonEmpty && value.length === 0) fail("INVALID_LENGTH", "Semantic list must not be empty");
	if (value.length > MAX_LIST) fail("INVALID_LENGTH", "Semantic list exceeds maximum length");
	return value.map(parse);
}

function opaque<Id extends string>(value: unknown, prefix: string): Id {
	if (typeof value !== "string" || !value.startsWith(prefix) || !ID_SUFFIX.test(value.slice(prefix.length))) {
		fail("INVALID_IDENTIFIER", "Opaque identifier has invalid format");
	}
	return value as Id;
}

const projectId = (value: unknown) => opaque<ProjectId>(value, "prj_");
const selectionId = (value: unknown) => opaque<SelectionId>(value, "sel_");
const documentId = (value: unknown) => opaque<DocumentId>(value, "doc_");
const observationId = (value: unknown) => opaque<ObservationId>(value, "obs_");
const artifactId = (value: unknown) => opaque<ArtifactId>(value, "art_");
const texts = (value: unknown) => list(value, (item) => text(item));

function target(value: unknown): SemanticTarget {
	const candidate = object(value);
	switch (candidate.kind) {
		case "selection":
			exact(candidate, ["kind", "selectionId"]);
			return { kind: "selection", selectionId: selectionId(candidate.selectionId) };
		case "documents":
			exact(candidate, ["kind", "documentIds"], ["hint"]);
			return {
				kind: "documents",
				documentIds: list(candidate.documentIds, documentId, { nonEmpty: true }),
				...(candidate.hint === undefined ? {} : { hint: text(candidate.hint) }),
			};
		case "symbol":
			exact(candidate, ["kind", "hint"]);
			return { kind: "symbol", hint: text(candidate.hint, { nonEmpty: true }) };
		case "error":
			exact(candidate, ["kind", "fingerprint"]);
			return { kind: "error", fingerprint: text(candidate.fingerprint, { nonEmpty: true }) };
		case "behavior":
			exact(candidate, ["kind", "description"]);
			return { kind: "behavior", description: text(candidate.description, { nonEmpty: true }) };
		case "ui":
			exact(candidate, ["kind", "role", "name"]);
			return {
				kind: "ui",
				role: text(candidate.role, { nonEmpty: true }),
				name: text(candidate.name, { nonEmpty: true }),
			};
		default:
			fail("INVALID_VALUE", "Semantic target kind is unsupported");
	}
}

function workIntent(candidate: Record<string, unknown>): WorkIntent {
	exact(candidate, ["kind", "objective", "target", "evidenceGoals", "constraints", "doneWhen"]);
	return {
		kind: candidate.kind as WorkIntent["kind"],
		objective: text(candidate.objective, { nonEmpty: true }),
		target: target(candidate.target),
		evidenceGoals: texts(candidate.evidenceGoals),
		constraints: texts(candidate.constraints),
		doneWhen: text(candidate.doneWhen, { nonEmpty: true }),
	};
}

function claim(value: unknown): CompletionClaim {
	const candidate = object(value);
	exact(candidate, ["observationRef", "claim"]);
	return {
		observationRef: observationId(candidate.observationRef),
		claim: text(candidate.claim, { nonEmpty: true }),
	};
}

function intent(value: unknown): Intent {
	const candidate = object(value);
	if (["inspect", "modify", "review", "verify"].includes(String(candidate.kind))) return workIntent(candidate);
	if (candidate.kind === "clarify") {
		exact(candidate, ["kind", "question", "reason"]);
		return {
			kind: "clarify",
			question: text(candidate.question, { nonEmpty: true }),
			reason: text(candidate.reason, { nonEmpty: true }),
		} satisfies ClarifyIntent;
	}
	if (candidate.kind === "complete") {
		exact(candidate, ["kind", "summary", "claims"]);
		return {
			kind: "complete",
			summary: text(candidate.summary, { nonEmpty: true }),
			claims: list(candidate.claims, claim, { nonEmpty: true }),
		} satisfies CompleteIntent;
	}
	fail("INVALID_VALUE", "Intent kind is unsupported");
}

function edit(value: unknown): ProposedEdit {
	const candidate = object(value);
	exact(candidate, ["documentId", "oldText", "newText"]);
	return {
		documentId: documentId(candidate.documentId),
		oldText: text(candidate.oldText, { max: MAX_SOURCE_TEXT, nonEmpty: true }),
		newText: text(candidate.newText, { max: MAX_SOURCE_TEXT }),
	};
}

function proposal(value: unknown): PatchProposal {
	const candidate = object(value);
	exact(candidate, ["edits", "assumptions", "verificationGoals"]);
	return {
		edits: list(candidate.edits, edit, { nonEmpty: true }),
		assumptions: texts(candidate.assumptions),
		verificationGoals: texts(candidate.verificationGoals),
	};
}

export function parseSemanticOutput(value: unknown): SemanticOutput {
	const candidate = object(value);
	exact(candidate, ["protocolVersion", "kind", "payload"]);
	if (candidate.protocolVersion !== 2) fail("UNSUPPORTED_VERSION", "Unsupported semantic protocol version");
	if (candidate.kind === "intent") return { protocolVersion: 2, kind: "intent", payload: intent(candidate.payload) };
	if (candidate.kind === "patchProposal") {
		return { protocolVersion: 2, kind: "patchProposal", payload: proposal(candidate.payload) };
	}
	fail("INVALID_VALUE", "Semantic output kind is unsupported");
}

export function parseSemanticTurnRequest(value: unknown): SemanticTurnRequest {
	const candidate = object(value);
	exact(candidate, ["protocolVersion", "mode", "objective", "disclosed"]);
	if (candidate.protocolVersion !== 2) fail("UNSUPPORTED_VERSION", "Unsupported semantic protocol version");
	if (!["prompt", "steer", "followUp"].includes(String(candidate.mode))) {
		fail("INVALID_VALUE", "Semantic turn mode is unsupported");
	}
	const disclosed = object(candidate.disclosed);
	exact(disclosed, ["selectionIds", "documentIds", "observationIds"]);
	return {
		protocolVersion: 2,
		mode: candidate.mode as SemanticTurnMode,
		objective: text(candidate.objective, { nonEmpty: true }),
		disclosed: {
			selectionIds: list(disclosed.selectionIds, selectionId),
			documentIds: list(disclosed.documentIds, documentId),
			observationIds: list(disclosed.observationIds, observationId),
		},
	};
}

function safe<T>(parse: () => T): SafeParseResult<T> {
	try {
		return { success: true, data: parse() };
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof SemanticContractError
					? error
					: new SemanticContractError("INVALID_TYPE", "Semantic value could not be parsed"),
		};
	}
}

export const safeParseSemanticOutput = (value: unknown): SafeParseResult<SemanticOutput> =>
	safe(() => parseSemanticOutput(value));
export const safeParseSemanticTurnRequest = (value: unknown): SafeParseResult<SemanticTurnRequest> =>
	safe(() => parseSemanticTurnRequest(value));

export const parseProjectId = projectId;
export const parseArtifactId = artifactId;
