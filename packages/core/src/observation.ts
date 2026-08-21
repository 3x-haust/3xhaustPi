import { type ObservationId, parseArtifactId } from "@3xhaust/semantic-contract";
import { canonicalJson, sha256 } from "./canonical.ts";
import type { CapabilityInvocation, Observation, ObservationOutcome } from "./types.ts";

const MAX_SUMMARY = 4_096;
const MAX_FACTS = 1_048_576;
const MAX_ARTIFACTS = 64;

export async function normalizeObservation(
	invocation: CapabilityInvocation,
	outcome: ObservationOutcome,
): Promise<Observation> {
	if (outcome.summary.length === 0 || outcome.summary.length > MAX_SUMMARY) {
		throw new Error("Observation summary is outside bounds");
	}
	if (canonicalJson(outcome.facts).length > MAX_FACTS) throw new Error("Observation facts exceed bounds");
	if (outcome.artifactRefs.length > MAX_ARTIFACTS) throw new Error("Observation artifacts exceed bounds");
	const artifactRefs = outcome.artifactRefs.map(parseArtifactId);
	const digest = await sha256({
		invocationId: invocation.invocationId,
		status: outcome.status,
		summary: outcome.summary,
		facts: outcome.facts,
		artifactRefs,
		projectRevision: invocation.basedOn.projectRevision,
	});
	return {
		observationId: `obs_${digest.slice(0, 32)}` as ObservationId,
		invocationId: invocation.invocationId,
		status: outcome.status,
		summary: outcome.summary,
		facts: outcome.facts,
		artifactRefs,
		projectRevision: invocation.basedOn.projectRevision,
	};
}
