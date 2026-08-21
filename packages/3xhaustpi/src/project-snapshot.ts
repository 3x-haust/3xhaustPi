import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { DocumentId } from "@3xhaust/semantic-contract";
import { ACTIVE_DATA_DIRECTORY, resolveProjectDataDirectory } from "./identity.ts";

const TEXT_EXTENSIONS = new Set([
	".c",
	".cc",
	".css",
	".go",
	".h",
	".html",
	".java",
	".js",
	".json",
	".jsx",
	".md",
	".mjs",
	".py",
	".rs",
	".sh",
	".sql",
	".swift",
	".toml",
	".ts",
	".tsx",
	".txt",
	".yaml",
	".yml",
]);

export interface ProjectDocument {
	readonly id: DocumentId;
	readonly relativePath: string;
	readonly content: string;
	readonly sha256: string;
	readonly virtual?: true;
}

export interface ProjectSnapshot {
	readonly revision: string;
	readonly stableContext: string;
	readonly documents: readonly ProjectDocument[];
	readonly sha256: string;
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

const EMPTY_PROJECT_SLOTS = [
	{ relativePath: "README.md", content: "<!-- X3HAUSTPI_NEW_FILE: README.md -->" },
	{ relativePath: "index.html", content: "<!-- X3HAUSTPI_NEW_FILE: index.html -->" },
	{ relativePath: "package.json", content: '{"threeXhaustpiNewFile":"package.json"}' },
	{ relativePath: "src/app.js", content: "// X3HAUSTPI_NEW_FILE: src/app.js" },
	{ relativePath: "src/server.js", content: "// X3HAUSTPI_NEW_FILE: src/server.js" },
	{ relativePath: "src/styles.css", content: "/* X3HAUSTPI_NEW_FILE: src/styles.css */" },
	{ relativePath: "test/app.test.js", content: "// X3HAUSTPI_NEW_FILE: test/app.test.js" },
] as const;

const EXISTING_PROJECT_SLOTS = EMPTY_PROJECT_SLOTS.filter(({ relativePath }) => relativePath === "src/server.js");
const SKILL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function requestedSkillId(objective: string): string | undefined {
	const english = /\bcreate\s+(?:a\s+)?skill\s+([^\s]+)/u.exec(objective);
	const korean = /\b([a-z0-9]+(?:-[a-z0-9]+)*)\s+스킬\s*만들/u.exec(objective);
	const ids: string[] = [];
	if (english !== null) {
		const id = english[1];
		const rest = objective
			.slice(english.index + english[0].length)
			.trim()
			.split(/\s+/u)[0];
		if (SKILL_ID_PATTERN.test(id) && (rest === "" || !SKILL_ID_PATTERN.test(rest))) ids.push(id);
	}
	if (korean?.[1] !== undefined) ids.push(korean[1]);
	return new Set(ids).size === 1 ? ids[0] : undefined;
}

function objectiveTerms(objective: string): readonly string[] {
	return [
		...new Set(
			objective
				.toLowerCase()
				.split(/[^\p{L}\p{N}_.-]+/u)
				.filter((term) => term.length >= 3),
		),
	];
}

function listSkillFiles(projectRoot: string): readonly string[] {
	const skillsRoot = join(resolveProjectDataDirectory(projectRoot), "skills");
	if (!existsSync(skillsRoot)) return [];
	return readdirSync(skillsRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => `${ACTIVE_DATA_DIRECTORY}/skills/${entry.name}/SKILL.md`)
		.filter((relativePath) => existsSync(join(projectRoot, relativePath)))
		.sort();
}

function listProjectFiles(projectRoot: string): readonly string[] {
	const result = spawnSync("rg", ["--files", "-g", "!node_modules/**", "-g", "!.git/**", "-g", "!artifacts/**"], {
		cwd: projectRoot,
		encoding: "utf8",
		timeout: 10_000,
		maxBuffer: 4_194_304,
	});
	if (result.status !== 0 && result.status !== 1)
		throw new Error(result.stderr.trim() || "Project file listing failed");
	return [
		...result.stdout
			.split("\n")
			.map((path) => path.trim())
			.filter((path) => path.length > 0 && TEXT_EXTENSIONS.has(extname(path).toLowerCase())),
		...listSkillFiles(projectRoot),
	].sort();
}

function projectRevision(projectRoot: string): string {
	const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8", timeout: 5_000 });
	const status = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
		cwd: projectRoot,
		encoding: "utf8",
		timeout: 10_000,
		maxBuffer: 4_194_304,
	});
	const diff = spawnSync("git", ["diff", "--no-ext-diff", "--binary", "HEAD"], {
		cwd: projectRoot,
		encoding: "utf8",
		timeout: 15_000,
		maxBuffer: 16_777_216,
	});
	return `sha256:${digest(
		`${head.status === 0 ? head.stdout.trim() : "no-git"}\n${status.stdout}\n${diff.status === 0 ? diff.stdout : ""}`,
	)}`;
}

export function createProjectSnapshot(projectRoot: string, objective: string): ProjectSnapshot {
	const terms = objectiveTerms(objective);
	const candidates = listProjectFiles(projectRoot)
		.map((relativePath) => {
			const absolutePath = join(projectRoot, relativePath);
			if (statSync(absolutePath).size > 262_144) return undefined;
			const content = readFileSync(absolutePath, "utf8");
			const lower = `${relativePath}\n${content}`.toLowerCase();
			const score = terms.reduce((total, term) => total + (lower.includes(term) ? 1 : 0), 0);
			return { relativePath, content, score };
		})
		.filter((entry) => entry !== undefined)
		.sort((left, right) => right.score - left.score || left.relativePath.localeCompare(right.relativePath));

	const documents: ProjectDocument[] = [];
	let remaining = 16_500;
	for (const candidate of candidates) {
		if (documents.length >= 12 || remaining < 512) break;
		const content = candidate.content.slice(0, Math.min(candidate.content.length, 8_000, remaining - 256));
		if (content.length === 0) continue;
		const sha256 = digest(candidate.content);
		const id = `doc_${digest(candidate.relativePath).slice(0, 24)}` as DocumentId;
		documents.push({ id, relativePath: candidate.relativePath, content, sha256 });
		remaining -= content.length + 200;
	}
	documents.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
	const disclosedPaths = new Set(candidates.map(({ relativePath }) => relativePath));
	const skillId = requestedSkillId(objective);
	const skillSlot =
		skillId === undefined
			? []
			: [
					{
						relativePath: `${ACTIVE_DATA_DIRECTORY}/skills/${skillId}/SKILL.md`,
						content: `<!-- X3HAUSTPI_NEW_FILE: ${ACTIVE_DATA_DIRECTORY}/skills/${skillId}/SKILL.md -->`,
					},
				];
	const newFileSlots =
		documents.length === 0 ? [...skillSlot, ...EMPTY_PROJECT_SLOTS] : [...skillSlot, ...EXISTING_PROJECT_SLOTS];
	for (const slot of newFileSlots) {
		if (documents.length >= 12 || disclosedPaths.has(slot.relativePath)) continue;
		documents.push({
			id: `doc_${digest(slot.relativePath).slice(0, 24)}` as DocumentId,
			relativePath: slot.relativePath,
			content: slot.content,
			sha256: digest(slot.content),
			virtual: true,
		});
	}

	const stableContext = [
		"Only the following bounded documents are disclosed. Paths are inert labels; return documentId, never a path.",
		"For a requested code modification with sufficient evidence, return a patchProposal using exact oldText/newText.",
		...documents.map((document) =>
			document.virtual
				? `NEW FILE SLOT ${document.id}\nPATH ${document.relativePath}\nThe file does not exist yet. To create it, return one edit whose oldText is exactly the marker below and whose newText is the complete file content.\nMARKER\n${document.content}\nEND MARKER`
				: `DOCUMENT ${document.id}\nPATH ${document.relativePath}\nSHA256 ${document.sha256}\nCONTENT\n${document.content}\nEND DOCUMENT`,
		),
	].join("\n\n");
	return {
		revision: `sha256:${digest(
			`${projectRevision(projectRoot)}\n${documents.map((document) => `${document.relativePath}:${document.sha256}`).join("\n")}`,
		)}`,
		stableContext,
		documents,
		sha256: digest(stableContext),
	};
}

export function displayName(document: ProjectDocument): string {
	return `${basename(document.relativePath)} (${document.id})`;
}
