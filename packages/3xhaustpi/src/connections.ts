import { spawnSync } from "node:child_process";
import { type AsideAccount, parseAsideAccounts } from "./npm-workflow.ts";
import { providerStatuses } from "./provider-runtime.ts";

export interface ConnectionInventory {
	readonly providers: readonly {
		readonly id: string;
		readonly auth: string;
		readonly configured: boolean;
	}[];
	readonly aside: readonly AsideAccount[];
	readonly npm: {
		readonly account?: string;
		readonly configured: boolean;
		readonly registry: string;
	};
}

function command(
	command: string,
	args: readonly string[],
): { readonly status: number | null; readonly output: string } {
	const result = spawnSync(command, [...args], { encoding: "utf8", timeout: 10_000, maxBuffer: 1_048_576 });
	return { status: result.status, output: `${result.stdout}${result.stderr}`.trim() };
}

export async function collectConnections(): Promise<ConnectionInventory> {
	const providers = await providerStatuses();
	const aside = command("aside", ["account", "list"]);
	const npm = command("npm", ["whoami"]);
	const registry = command("npm", ["config", "get", "registry"]);
	return {
		providers: providers.map(({ provider, auth, configured }) => ({ id: provider, auth, configured })),
		aside: aside.status === 0 ? parseAsideAccounts(aside.output) : [],
		npm: {
			...(npm.status === 0 && npm.output ? { account: npm.output } : {}),
			configured: npm.status === 0,
			registry: registry.status === 0 ? registry.output : "https://registry.npmjs.org/",
		},
	};
}

export function useAsideAccount(id: string): void {
	if (!/^u\d+$/u.test(id)) throw new Error(`Invalid Aside account id: ${id}`);
	const result = spawnSync("aside", ["account", "use", id], { encoding: "utf8", timeout: 10_000 });
	if (result.status !== 0)
		throw new Error(`${result.stdout}${result.stderr}`.trim() || "Aside account selection failed");
}

export function renderConnections(inventory: ConnectionInventory): string {
	const lines = ["Connections", "", `Providers ${inventory.providers.filter(({ configured }) => configured).length}`];
	for (const provider of inventory.providers) {
		lines.push(`  ${provider.configured ? "●" : "○"} ${provider.id}  ${provider.auth}`);
	}
	lines.push("", `Aside ${inventory.aside.filter(({ signedIn }) => signedIn).length}`);
	for (const account of inventory.aside) {
		lines.push(
			`  ${account.selected ? "▶" : account.signedIn ? "●" : "○"} ${account.id}  ${account.label}${account.provider ? `  ${account.provider}` : ""}`,
		);
	}
	lines.push("", "npm");
	lines.push(
		inventory.npm.configured
			? `  ● ${inventory.npm.account}  ${inventory.npm.registry}`
			: `  ○ login required  ${inventory.npm.registry}`,
	);
	return lines.join("\n");
}
