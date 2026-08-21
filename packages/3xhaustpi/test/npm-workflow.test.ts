import { describe, expect, it, vi } from "vitest";
import { type CommandProcess, parseAsideAccounts, runNpmLogin, runNpmPublish } from "../src/npm-workflow.ts";

function fakeProcess(output: string, exitCode = 0): CommandProcess {
	return {
		stdout: output,
		stderr: "",
		exitCode,
		write: vi.fn(),
		wait: vi.fn(async () => exitCode),
	};
}

function fakeSpawn(processes: readonly CommandProcess[]) {
	return vi.fn((_command: string, _args: readonly string[]) => {
		const process = processes.at(0);
		if (!process) throw new Error("Unexpected spawned command");
		(processes as CommandProcess[]).shift();
		return process;
	});
}

describe("npm and Aside workflow", () => {
	it("parses signed-in and selected Aside accounts", () => {
		expect(
			parseAsideAccounts(
				"* u0  user@example.com  signed in  profiles: Profile 0\n  provider: google\n  u1  Local Account  signed out  profiles: Profile 1",
			),
		).toEqual([
			{ id: "u0", label: "user@example.com", provider: "google", signedIn: true, selected: true },
			{ id: "u1", label: "Local Account", signedIn: false, selected: false },
		]);
	});

	it("selects the Aside account, runs plain npm login, sends Enter, and delegates browser opening to Aside", async () => {
		const selection = fakeProcess("selected work");
		const login = fakeProcess("Press ENTER to open in the browser");
		const spawn = fakeSpawn([selection, login]);

		await runNpmLogin({
			account: "work",
			asidePath: "/usr/local/bin/aside",
			spawn,
		});

		expect(spawn).toHaveBeenNthCalledWith(1, "/usr/local/bin/aside", ["account", "use", "work"], expect.any(Object));
		expect(spawn).toHaveBeenNthCalledWith(
			2,
			"npm",
			["login"],
			expect.objectContaining({
				env: expect.objectContaining({
					BROWSER: "/usr/local/bin/aside",
				}),
			}),
		);
		expect(login.write).toHaveBeenCalledWith("\n");
	});

	it("selects the Aside account and requires explicit confirmation before publish", async () => {
		const selection = fakeProcess("selected work");
		const whoami = fakeProcess("release-user\n");
		const publish = fakeProcess("+ package@1.0.0");
		const spawn = fakeSpawn([selection, whoami, publish]);

		const result = await runNpmPublish({
			account: "work",
			asidePath: "/usr/local/bin/aside",
			spawn,
			confirm: async (review) => {
				expect(review.account).toBe("release-user");
				expect(review.command).toBe("npm publish");
				return true;
			},
		});

		expect(result.account).toBe("release-user");
		expect(spawn).toHaveBeenNthCalledWith(1, "/usr/local/bin/aside", ["account", "use", "work"], expect.any(Object));
		expect(spawn).toHaveBeenNthCalledWith(
			2,
			"npm",
			["whoami"],
			expect.objectContaining({
				env: expect.objectContaining({ BROWSER: "/usr/local/bin/aside" }),
			}),
		);
		expect(spawn).toHaveBeenNthCalledWith(3, "npm", ["publish"], expect.any(Object));
	});
});
