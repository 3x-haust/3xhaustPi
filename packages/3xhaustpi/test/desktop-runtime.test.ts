import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	DesktopAccessibilityHost,
	type DesktopAccessibilityPlatform,
	type DesktopHelperRuntime,
} from "../src/desktop-runtime.ts";

const fixturePath = resolve(import.meta.dirname, "fixtures/desktop-helper-fixture.mjs");

function runtime(platform: DesktopAccessibilityPlatform): DesktopHelperRuntime {
	return {
		platform,
		command: process.execPath,
		args: [fixturePath],
		helper: `${platform} fixture accessibility`,
		env: { X3HAUSTPI_FIXTURE_PLATFORM: platform },
	};
}

describe.each(["win32", "linux"] as const)("%s desktop accessibility adapter", (platform) => {
	it("lists, observes, and performs an identity-bound semantic action", async () => {
		const host = new DesktopAccessibilityHost({ helperRuntime: runtime(platform) });
		const applications = await host.listApplications();
		expect(applications).toMatchObject({
			platform,
			trusted: true,
			applications: [{ pid: 4242, name: "Fixture Editor", active: true }],
		});
		const observation = await host.observe({ pid: 4242 });
		expect(observation.elements).toEqual([
			{ role: "button", name: "Run" },
			{ role: "field", name: "Query" },
		]);
		const result = await host.act(
			{ pid: 4242 },
			{
				action: "click",
				target: { role: "button", name: "Run", observationDigest: observation.digest },
				button: "left",
			},
		);
		expect(result.method).toBe("accessibility");
	});

	it("rejects stale and unapproved coordinate targets before helper execution", async () => {
		const host = new DesktopAccessibilityHost({ helperRuntime: runtime(platform) });
		await expect(
			host.act(
				{ pid: 4242 },
				{
					action: "click",
					target: { role: "button", name: "Run", observationDigest: "0".repeat(64) },
					button: "left",
				},
			),
		).rejects.toThrow(/stale/u);

		const observation = await host.observe({ pid: 4242 });
		await expect(
			host.act(
				{ pid: 4242 },
				{
					action: "click",
					target: { role: "button", name: "Missing", observationDigest: observation.digest },
					coordinates: { x: 10, y: 10 },
					button: "left",
				},
			),
		).rejects.toThrow(/matching host-issued approval/u);
	});
});
