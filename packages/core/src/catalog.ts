import type { CapabilityCatalog, CapabilityId, CapabilityManifest } from "./types.ts";

export const CAPABILITY_CATALOG_VERSION = "3xhaustpi-capabilities-v1";

const CAPABILITIES = Object.freeze([
	{
		id: "searchText",
		version: "1",
		effect: "read",
		cache: "revision",
		timeoutMs: 5_000,
		maxAttempts: 2,
	},
	{
		id: "searchSymbol",
		version: "1",
		effect: "read",
		cache: "revision",
		timeoutMs: 5_000,
		maxAttempts: 2,
	},
	{
		id: "readRanges",
		version: "1",
		effect: "read",
		cache: "revision",
		timeoutMs: 5_000,
		maxAttempts: 2,
	},
	{ id: "applyPatch", version: "1", effect: "write", cache: "none", timeoutMs: 15_000, maxAttempts: 1 },
	{
		id: "getDiagnostics",
		version: "1",
		effect: "read",
		cache: "revision",
		timeoutMs: 20_000,
		maxAttempts: 1,
	},
] as const satisfies readonly CapabilityManifest[]);

const CATALOG: CapabilityCatalog = Object.freeze({
	version: CAPABILITY_CATALOG_VERSION,
	capabilities: CAPABILITIES,
});

export const getCapabilityCatalog = (): CapabilityCatalog => CATALOG;

export function getCapabilityManifest(id: CapabilityId): CapabilityManifest {
	const manifest = CAPABILITIES.find((candidate) => candidate.id === id);
	if (!manifest) throw new Error("Unknown capability manifest");
	return manifest;
}
