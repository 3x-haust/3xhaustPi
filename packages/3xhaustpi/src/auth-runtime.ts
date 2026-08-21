import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import { createCredentialStore, createProviderRuntime, credentialStoreDescription } from "./provider-runtime.ts";

export type ProviderOAuthEvent = AuthEvent;

export interface ProviderCatalogModel {
	readonly id: string;
	readonly name: string;
	readonly provider: string;
	readonly api: string;
	readonly baseUrl: string;
	readonly reasoning: boolean;
	readonly input: readonly ("text" | "image")[];
	readonly contextWindow: number;
	readonly maxTokens: number;
	readonly cost: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
	};
}

export interface ProviderCatalogEntry {
	readonly id: string;
	readonly name: string;
	readonly baseUrl?: string;
	readonly configured: boolean;
	readonly authMethods: readonly ("api_key" | "oauth")[];
	readonly credentialType?: "api_key" | "oauth";
	readonly credentialSource?: string;
	readonly refreshError?: string;
	readonly models: readonly ProviderCatalogModel[];
}

export interface ProviderCatalogSnapshot {
	readonly capturedAt: string;
	readonly providers: readonly ProviderCatalogEntry[];
}

/** Returns the real runtime catalog and current credential availability without exposing credentials. */
export async function readProviderCatalog(providerIds?: readonly string[]): Promise<ProviderCatalogSnapshot> {
	const runtime = createProviderRuntime();
	const requested = providerIds ? new Set(providerIds) : undefined;
	const registered = new Map(
		(await createCredentialStore().list()).map((credential) => [credential.providerId, credential]),
	);
	const providers = runtime
		.getProviders()
		.filter((provider) => !requested || requested.has(provider.id))
		.map((provider): ProviderCatalogEntry => {
			const credential = registered.get(provider.id);
			const available = provider.getModels();
			return {
				id: provider.id,
				name: provider.name,
				...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
				configured: Boolean(credential),
				authMethods: [
					provider.auth.apiKey ? ("api_key" as const) : undefined,
					provider.auth.oauth ? ("oauth" as const) : undefined,
				].filter((method): method is "api_key" | "oauth" => Boolean(method)),
				...(credential?.type ? { credentialType: credential.type } : {}),
				...(credential ? { credentialSource: credentialStoreDescription() } : {}),
				models: available.map((model) => ({
					id: model.id,
					name: model.name,
					provider: model.provider,
					api: model.api,
					baseUrl: model.baseUrl,
					reasoning: model.reasoning,
					input: [...model.input],
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					cost: {
						input: model.cost.input,
						output: model.cost.output,
						cacheRead: model.cost.cacheRead,
						cacheWrite: model.cost.cacheWrite,
					},
				})),
			};
		});
	return { capturedAt: new Date().toISOString(), providers };
}

function waitForBrowserCallback(prompt: AuthPrompt): Promise<string> {
	const signal = prompt.signal;
	if (!signal) throw new Error("Browser login prompt has no cancellation signal");
	return new Promise((resolve, reject) => {
		const abort = () => reject(new Error("Browser login completed or was cancelled"));
		if (signal.aborted) {
			abort();
			return;
		}
		signal.addEventListener("abort", abort, { once: true });
		void resolve;
	});
}

async function answerBrowserLoginPrompt(prompt: AuthPrompt): Promise<string> {
	if (prompt.type === "select") {
		const browser = prompt.options.find(({ id }) => id === "browser");
		return (browser ?? prompt.options[0])?.id ?? "";
	}
	if (prompt.type === "manual_code") return waitForBrowserCallback(prompt);
	throw new Error(`OAuth login requires an unsupported prompt: ${prompt.type}`);
}

/** Starts the provider's real browser OAuth flow and persists the credential in the shared OS store. */
export async function loginProviderOAuth(
	providerId: string,
	onEvent: (event: ProviderOAuthEvent) => void,
): Promise<void> {
	const models = createProviderRuntime();
	const provider = models.getProvider(providerId);
	if (!provider) throw new Error(`Unknown provider: ${providerId}`);
	if (!provider.auth.oauth) throw new Error(`${provider.name} does not support OAuth login`);
	await models.login(providerId, "oauth", {
		prompt: answerBrowserLoginPrompt,
		notify: onEvent,
	});
}
