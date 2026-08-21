import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const EVIDENCE_FILES = [
	"packages/pi-adapter/src/prompt.ts",
	"packages/pi-adapter/src/adapter.ts",
	"packages/pi-adapter/src/types.ts",
	"packages/core/src/compiler.ts",
	"packages/core/src/catalog.ts",
	"packages/core/src/policy.ts",
	"packages/core/src/observation.ts",
	"packages/semantic-contract/src/types.ts",
] as const;

export interface StableProjectEvidence {
	readonly text: string;
	readonly sha256: string;
	readonly files: readonly { readonly path: string; readonly sha256: string }[];
}

export function createStableProjectEvidence(projectRoot: string, maximumCharacters = 16_284): StableProjectEvidence {
	if (!Number.isSafeInteger(maximumCharacters) || maximumCharacters < 1 || maximumCharacters > 1_048_576) {
		throw new Error("Stable project evidence character bound must be an integer from 1 to 1,048,576");
	}
	const blocks: string[] = [];
	const files: { path: string; sha256: string }[] = [];
	for (const relativePath of EVIDENCE_FILES) {
		const absolutePath = resolve(projectRoot, relativePath);
		const content = readFileSync(absolutePath, "utf8");
		const sha256 = createHash("sha256").update(content).digest("hex");
		files.push({ path: relative(projectRoot, absolutePath), sha256 });
		blocks.push(`FILE ${relativePath}\nSHA256 ${sha256}\n${content}`);
	}
	const full = blocks.join("\n\n");
	// Keep the real-provider request below the product's 5K prompt budget after
	// protocol and per-turn framing are added. The slice remains deterministic
	// and content-addressed; no synthetic cache padding is included.
	const text = full.slice(0, maximumCharacters);
	return {
		text,
		sha256: createHash("sha256").update(text).digest("hex"),
		files,
	};
}
