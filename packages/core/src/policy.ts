import { getCapabilityManifest } from "./catalog.ts";
import type { CapabilityId, PolicyDecision, PolicyProfile } from "./types.ts";

export const POLICY_VERSION = "3xhaustpi-policy-v1";

const DEFAULT_PROFILE: PolicyProfile = Object.freeze({ writeMode: "approval" });

export function evaluateCapabilityPolicy(
	capability: CapabilityId,
	profile: PolicyProfile = DEFAULT_PROFILE,
): PolicyDecision {
	const manifest = getCapabilityManifest(capability);
	if (manifest.effect === "read") return { decision: "allow", policyVersion: POLICY_VERSION };
	if (profile.writeMode === "deny") {
		return { decision: "deny", policyVersion: POLICY_VERSION, reason: "workspace writes are disabled" };
	}
	return { decision: "approval-required", policyVersion: POLICY_VERSION };
}
