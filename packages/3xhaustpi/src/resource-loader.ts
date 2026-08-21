import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodingTaskEvent } from "./coding-runtime.ts";
import { resolveProjectDataDirectory, resolveUserDataDirectory } from "./identity.ts";
import { PRODUCT_DISPLAY_NAME } from "./product-identity.ts";

export type ResourceScope = "builtin" | "user" | "project";
export type HookEvent = CodingTaskEvent["type"];

export interface SkillResource {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly instructions: string;
	readonly scope: ResourceScope;
	readonly sourcePath: string;
	readonly sha256: string;
}

export interface ObserverHook {
	readonly id: string;
	readonly event: HookEvent;
	readonly command: string;
	readonly args: readonly string[];
	readonly scope: "user" | "project";
	readonly sourcePath: string;
}

export interface ResourceEntry {
	readonly kind: "skill" | "hook";
	readonly id: string;
	readonly scope: ResourceScope;
	readonly state: "enabled" | "disabled";
	readonly sourcePath: string;
	readonly reason?: string;
}

export interface HarnessResourceOptions {
	readonly projectRoot: string;
	readonly userRoot?: string;
	readonly builtinRoot?: string;
	readonly allowProjectHooks?: boolean;
}

export interface HarnessResources {
	readonly skills: readonly SkillResource[];
	readonly hooks: readonly ObserverHook[];
	readonly entries: readonly ResourceEntry[];
	readonly skillContext: string;
	readonly digest: string;
}

interface HookManifest {
	readonly schemaVersion: 1;
	readonly hooks: readonly {
		readonly id: string;
		readonly event: HookEvent;
		readonly command: string;
		readonly args?: readonly string[];
		readonly enabled?: boolean;
	}[];
}

const RESOURCE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const HOOK_EVENTS = new Set<HookEvent>([
	"session.started",
	"model.completed",
	"capability.started",
	"capability.completed",
	"patch.proposed",
	"patch.decision",
	"diagnostics.completed",
	"assistant.message",
	"session.completed",
	"session.failed",
]);
const MAX_SKILL_BYTES = 32 * 1024;
const MAX_SKILL_CONTEXT = 8 * 1024;
const MAX_SKILLS = 16;

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function assertId(value: string, label: string): void {
	if (!RESOURCE_ID.test(value)) throw new Error(`${label} has an invalid id: ${value}`);
}

function assertRegularFile(path: string): void {
	const info = lstatSync(path);
	if (info.isSymbolicLink()) throw new Error(`Resource must not be a symbolic link: ${path}`);
	if (!info.isFile()) throw new Error(`Resource must be a regular file: ${path}`);
}

function assertInside(root: string, path: string): void {
	const result = relative(realpathSync(root), realpathSync(path));
	if (result === ".." || result.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(result)) {
		throw new Error(`Resource escapes its root: ${path}`);
	}
}

function parseFrontmatter(
	source: string,
	path: string,
): { readonly fields: ReadonlyMap<string, string>; readonly body: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(source);
	if (!match) throw new Error(`Skill frontmatter is invalid: ${path}`);
	const fields = new Map<string, string>();
	for (const line of match[1]!.split(/\r?\n/u)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const separator = trimmed.indexOf(":");
		if (separator <= 0) throw new Error(`Skill frontmatter line is invalid: ${path}`);
		const key = trimmed.slice(0, separator).trim();
		const value = trimmed.slice(separator + 1).trim();
		if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(key)) throw new Error(`Skill frontmatter key is invalid: ${path}`);
		fields.set(key, value.replace(/^(['"])(.*)\1$/u, "$2"));
	}
	return { fields, body: match[2]! };
}

function parseSkill(path: string, id: string, scope: ResourceScope): SkillResource {
	assertRegularFile(path);
	assertInside(dirname(dirname(path)), path);
	const bytes = lstatSync(path).size;
	if (bytes > MAX_SKILL_BYTES) throw new Error(`Skill exceeds ${MAX_SKILL_BYTES} bytes: ${path}`);
	const source = readFileSync(path, "utf8");
	const { fields, body } = parseFrontmatter(source, path);
	const name = fields.get("name");
	const description = fields.get("description");
	if (!name || !description) throw new Error(`Skill requires name and description: ${path}`);
	const instructions = body.trim();
	if (!instructions) throw new Error(`Skill instructions are empty: ${path}`);
	return {
		id,
		name,
		description,
		instructions,
		scope,
		sourcePath: path,
		sha256: digest(source),
	};
}

function loadSkills(root: string, scope: ResourceScope): readonly SkillResource[] {
	const skillsRoot = join(root, "skills");
	if (!existsSync(skillsRoot)) return [];
	return readdirSync(skillsRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.sort((left, right) => left.name.localeCompare(right.name))
		.map((entry) => {
			assertId(entry.name, "Skill");
			return parseSkill(join(skillsRoot, entry.name, "SKILL.md"), entry.name, scope);
		});
}

function parseHookManifest(path: string, scope: "user" | "project"): readonly ObserverHook[] {
	if (!existsSync(path)) return [];
	assertRegularFile(path);
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Hook manifest must be an object: ${path}`);
	}
	const candidate = parsed as Partial<HookManifest>;
	if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.hooks)) {
		throw new Error(`Hook manifest schema is unsupported: ${path}`);
	}
	return candidate.hooks
		.filter((hook) => hook.enabled !== false)
		.map((hook) => {
			if (typeof hook !== "object" || hook === null || Array.isArray(hook)) {
				throw new Error(`Hook entry must be an object: ${path}`);
			}
			if (typeof hook.id !== "string") throw new Error(`Hook id must be a string: ${path}`);
			assertId(hook.id, "Hook");
			if (typeof hook.event !== "string" || !HOOK_EVENTS.has(hook.event as HookEvent)) {
				throw new Error(`Hook event is unsupported: ${String(hook.event)}`);
			}
			if (typeof hook.command !== "string" || !isAbsolute(hook.command)) {
				throw new Error(`Hook command must be absolute: ${hook.id}`);
			}
			if (!Array.isArray(hook.args) && hook.args !== undefined)
				throw new Error(`Hook args must be an array: ${hook.id}`);
			const args = hook.args ?? [];
			if (args.some((arg: unknown) => typeof arg !== "string")) {
				throw new Error(`Hook args must be strings: ${hook.id}`);
			}
			return {
				id: hook.id,
				event: hook.event as HookEvent,
				command: hook.command,
				args,
				scope,
				sourcePath: path,
			};
		});
}

function escapeContext(value: string): string {
	return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}

function skillContext(skills: readonly SkillResource[]): string {
	let result = "";
	for (const skill of skills) {
		const block = [
			`<three-xhaustpi-skill id="${skill.id}" source="${skill.scope}">`,
			`Name: ${escapeContext(skill.name)}`,
			`Description: ${escapeContext(skill.description)}`,
			escapeContext(skill.instructions),
			"</three-xhaustpi-skill>",
		].join("\n");
		if (Buffer.byteLength(`${result}\n\n${block}`, "utf8") > MAX_SKILL_CONTEXT) break;
		result = result ? `${result}\n\n${block}` : block;
	}
	return result;
}

export function loadHarnessResources(options: HarnessResourceOptions): HarnessResources {
	const builtinRoot = options.builtinRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "../resources");
	const userRoot = options.userRoot ?? resolveUserDataDirectory();
	const projectRoot = resolveProjectDataDirectory(options.projectRoot);
	const roots = [
		{ root: builtinRoot, scope: "builtin" as const },
		{ root: userRoot, scope: "user" as const },
		{ root: projectRoot, scope: "project" as const },
	];
	const byId = new Map<string, SkillResource>();
	for (const { root, scope } of roots) {
		for (const skill of loadSkills(root, scope)) byId.set(skill.id, skill);
	}
	const skills = [...byId.values()];
	if (skills.length > MAX_SKILLS) throw new Error(`At most ${MAX_SKILLS} skills may be active`);

	const userHooks = parseHookManifest(join(userRoot, "hooks.json"), "user");
	const projectHooks = parseHookManifest(join(projectRoot, "hooks.json"), "project");
	const hooks = options.allowProjectHooks ? [...userHooks, ...projectHooks] : userHooks;
	const entries: ResourceEntry[] = [
		...skills.map((skill) => ({
			kind: "skill" as const,
			id: skill.id,
			scope: skill.scope,
			state: "enabled" as const,
			sourcePath: skill.sourcePath,
		})),
		...userHooks.map((hook) => ({
			kind: "hook" as const,
			id: hook.id,
			scope: hook.scope,
			state: "enabled" as const,
			sourcePath: hook.sourcePath,
		})),
		...projectHooks.map((hook) => ({
			kind: "hook" as const,
			id: hook.id,
			scope: hook.scope,
			state: options.allowProjectHooks ? ("enabled" as const) : ("disabled" as const),
			sourcePath: hook.sourcePath,
			...(options.allowProjectHooks ? {} : { reason: "project hooks require opt-in" }),
		})),
	];
	const context = skillContext(skills);
	const receipt = JSON.stringify({
		skills: skills.map(({ id, scope, sha256 }) => ({ id, scope, sha256 })),
		hooks: hooks.map(({ id, event, command, args, scope }) => ({ id, event, command, args, scope })),
	});
	return {
		skills,
		hooks,
		entries,
		skillContext: context,
		digest: `sha256:${digest(receipt)}`,
	};
}

export function createSkillTemplate(input: {
	readonly projectRoot: string;
	readonly name: string;
	readonly scope: "project" | "user";
	readonly userRoot?: string;
}): { readonly path: string; readonly content: string } {
	assertId(input.name, "Skill");
	const root =
		input.scope === "project"
			? resolveProjectDataDirectory(input.projectRoot)
			: (input.userRoot ?? resolveUserDataDirectory());
	const path = join(root, "skills", input.name, "SKILL.md");
	if (existsSync(path)) throw new Error(`Skill already exists: ${input.name}`);
	const content = `---
name: ${input.name}
description: Describe when ${PRODUCT_DISPLAY_NAME} should load this skill.
---

# ${input.name}

Write concise, executable guidance for this workflow.
`;
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
	return { path, content };
}
