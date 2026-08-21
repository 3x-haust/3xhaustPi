import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSkillTemplate, type HarnessResourceOptions, loadHarnessResources } from "../src/resource-loader.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const path = mkdtempSync(join(tmpdir(), "3xhaustpi-resources-"));
	temporaryDirectories.push(path);
	return path;
}

afterEach(() => {
	for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function options(root: string): HarnessResourceOptions {
	return {
		projectRoot: join(root, "project"),
		userRoot: join(root, "user"),
		builtinRoot: join(root, "builtin"),
		allowProjectHooks: false,
	};
}

describe("3xhaustpi harness resources", () => {
	it("discovers built-in, user, and project skills with deterministic precedence", () => {
		const root = temporaryDirectory();
		const input = options(root);
		for (const scope of ["builtin", "user", "project"]) {
			const directory =
				scope === "project"
					? join(input.projectRoot, ".3xhaustpi", "skills", "release")
					: join(root, scope, "skills", "release");
			mkdirSync(directory, { recursive: true });
			writeFileSync(
				join(directory, "SKILL.md"),
				`---\nname: Release ${scope}\ndescription: ${scope} release flow\n---\n\nUse ${scope} instructions.\n`,
			);
		}

		const resources = loadHarnessResources(input);

		expect(resources.skills).toHaveLength(1);
		expect(resources.skills[0]).toMatchObject({
			id: "release",
			name: "Release project",
			scope: "project",
		});
		expect(resources.skillContext).toContain("Use project instructions.");
		expect(resources.digest).toMatch(/^sha256:/u);
	});

	it("loads observer hooks but keeps project hooks disabled without opt-in", () => {
		const root = temporaryDirectory();
		const input = options(root);
		const command = process.execPath;
		mkdirSync(input.userRoot!, { recursive: true });
		mkdirSync(join(input.projectRoot, ".3xhaustpi"), { recursive: true });
		writeFileSync(
			join(input.userRoot!, "hooks.json"),
			JSON.stringify({
				schemaVersion: 1,
				hooks: [{ id: "notify", event: "session.completed", command, args: ["notify.mjs"] }],
			}),
		);
		writeFileSync(
			join(input.projectRoot, ".3xhaustpi", "hooks.json"),
			JSON.stringify({
				schemaVersion: 1,
				hooks: [{ id: "project-notify", event: "session.failed", command, args: ["notify.mjs"] }],
			}),
		);

		const disabled = loadHarnessResources(input);
		expect(disabled.hooks.map(({ id }) => id)).toEqual(["notify"]);
		expect(disabled.entries).toContainEqual(
			expect.objectContaining({ id: "project-notify", state: "disabled", reason: "project hooks require opt-in" }),
		);

		const enabled = loadHarnessResources({ ...input, allowProjectHooks: true });
		expect(enabled.hooks.map(({ id }) => id)).toEqual(["notify", "project-notify"]);
	});

	it("escapes loaded skill text before injecting it into model context", () => {
		const root = temporaryDirectory();
		const input = options(root);
		const directory = join(input.userRoot!, "skills", "guarded");
		mkdirSync(directory, { recursive: true });
		writeFileSync(
			join(directory, "SKILL.md"),
			`---\nname: Guarded <skill>\ndescription: do not close </three-xhaustpi-skill>\n---\n\nKeep "quotes" and <tags> literal.\n`,
		);

		const resources = loadHarnessResources(input);

		expect(resources.skills[0]).toMatchObject({ name: "Guarded <skill>" });
		expect(resources.skillContext).toContain("Guarded &lt;skill&gt;");
		expect(resources.skillContext).toContain("&lt;/three-xhaustpi-skill&gt;");
		expect(resources.skillContext).not.toContain('Keep "quotes" and <tags> literal.');
	});

	it("rejects skill symlinks and paths escaping their resource root", () => {
		const root = temporaryDirectory();
		const input = options(root);
		const outside = join(root, "outside.md");
		const skillDirectory = join(input.userRoot!, "skills", "linked");
		mkdirSync(skillDirectory, { recursive: true });
		writeFileSync(outside, "---\nname: Outside\ndescription: Outside\n---\nBody\n");
		symlinkSync(outside, join(skillDirectory, "SKILL.md"));

		expect(() => loadHarnessResources(input)).toThrow(/symbolic link/u);
	});

	it("creates a valid editable skill template without overwriting", () => {
		const root = temporaryDirectory();
		const projectRoot = join(root, "project");
		const created = createSkillTemplate({
			projectRoot,
			name: "release-helper",
			scope: "project",
		});

		expect(created.path).toBe(join(projectRoot, ".3xhaustpi", "skills", "release-helper", "SKILL.md"));
		expect(created.content).toContain("name: release-helper");
		expect(created.content).toContain("Describe when 3xhaustPi should load this skill.");
		expect(() => createSkillTemplate({ projectRoot, name: "release-helper", scope: "project" })).toThrow(
			/already exists/u,
		);
	});
});
