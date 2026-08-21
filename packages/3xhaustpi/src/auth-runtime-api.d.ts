export type ProviderOAuthEvent =
	| { type: "info"; message: string; links?: readonly { label: string; url: string }[] }
	| { type: "auth_url"; url: string; instructions?: string }
	| {
			type: "device_code";
			userCode: string;
			verificationUri: string;
			intervalSeconds?: number;
			expiresInSeconds?: number;
	  }
	| { type: "progress"; message: string };

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
export declare function readProviderCatalog(providerIds?: readonly string[]): Promise<ProviderCatalogSnapshot>;

export declare function loginProviderOAuth(
	providerId: string,
	onEvent: (event: ProviderOAuthEvent) => void,
): Promise<void>;
