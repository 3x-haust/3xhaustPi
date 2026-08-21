import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import type {
	Api,
	AuthEvent,
	AuthPrompt,
	Credential,
	CredentialInfo,
	CredentialStore,
	Model,
	Models,
	MutableModels,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { FileCredentialStore, SystemCredentialStore, systemCredentialStoreName } from "./credential-store.ts";
import { ACTIVE_KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_SERVICE, resolveAuthPath } from "./identity.ts";

export const DEFAULT_PROVIDER = "openai-codex";
export const DEFAULT_MODEL = "gpt-5.6-terra";
export const AUTH_PATH = resolveAuthPath();
export const CREDENTIAL_BACKEND = process.env.X3HAUSTPI_CREDENTIAL_BACKEND === "file" ? "file" : "system";

export interface ProviderCredentialOverride {
	readonly providerId: string;
	readonly credential: Credential;
}

class OverlayCredentialStore implements CredentialStore {
	private readonly base: CredentialStore;
	private readonly providerId: string;
	private credential: Credential | undefined;

	constructor(base: CredentialStore, override: ProviderCredentialOverride) {
		this.base = base;
		this.providerId = override.providerId;
		this.credential = override.credential;
	}

	read(providerId: string): Promise<Credential | undefined> {
		if (providerId === this.providerId) return Promise.resolve(this.credential);
		return this.base.read(providerId);
	}

	async list(): Promise<readonly CredentialInfo[]> {
		const existing = (await this.base.list()).filter(({ providerId }) => providerId !== this.providerId);
		return this.credential ? [...existing, { providerId: this.providerId, type: this.credential.type }] : existing;
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		if (providerId === this.providerId) {
			return fn(this.credential).then((next) => {
				if (next !== undefined) this.credential = next;
				return this.credential;
			});
		}
		return this.base.modify(providerId, fn);
	}

	delete(providerId: string): Promise<void> {
		if (providerId === this.providerId) {
			this.credential = undefined;
			return Promise.resolve();
		}
		return this.base.delete(providerId);
	}
}

function credentialFromWire(value: string): Credential {
	if (!value.startsWith("{")) return { type: "api_key", key: value };
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error("Provider credential envelope is invalid");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Provider credential envelope is invalid");
	}
	const candidate = parsed as Record<string, unknown>;
	if (
		candidate.type === "api_key" &&
		(candidate.key === undefined || typeof candidate.key === "string") &&
		(candidate.env === undefined ||
			(typeof candidate.env === "object" && candidate.env !== null && !Array.isArray(candidate.env)))
	) {
		return parsed as Credential;
	}
	if (
		candidate.type === "oauth" &&
		typeof candidate.access === "string" &&
		typeof candidate.refresh === "string" &&
		typeof candidate.expires === "number" &&
		Number.isFinite(candidate.expires)
	) {
		return parsed as Credential;
	}
	throw new Error("Provider credential envelope is invalid");
}

export function providerCredentialOverride(providerId: string, value: string): ProviderCredentialOverride {
	return { providerId, credential: credentialFromWire(value) };
}

function question(prompt: string, signal?: AbortSignal): Promise<string> {
	const readline = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve, reject) => {
		const abort = () => {
			readline.close();
			reject(new Error("Login cancelled"));
		};
		signal?.addEventListener("abort", abort, { once: true });
		readline.question(prompt, (answer) => {
			signal?.removeEventListener("abort", abort);
			readline.close();
			resolve(answer);
		});
	});
}

async function answerPrompt(prompt: AuthPrompt): Promise<string> {
	if (prompt.type === "select") {
		console.log(`\n${prompt.message}`);
		for (let index = 0; index < prompt.options.length; index += 1) {
			const option = prompt.options[index]!;
			console.log(`  ${index + 1}. ${option.label}`);
		}
		const answer = Number.parseInt(await question(`Enter number (1-${prompt.options.length}): `, prompt.signal), 10);
		const selected = prompt.options[answer - 1];
		if (!selected) throw new Error("Invalid login selection");
		return selected.id;
	}
	return question(`${prompt.message}${prompt.placeholder ? ` (${prompt.placeholder})` : ""}: `, prompt.signal);
}

function notifyAuth(event: AuthEvent): void {
	if (event.type === "auth_url") {
		console.log(`\nOpen this URL in your browser:\n${event.url}`);
		if (event.instructions) console.log(event.instructions);
		if (process.platform === "darwin") spawnSync("open", [event.url], { stdio: "ignore" });
		return;
	}
	if (event.type === "device_code") {
		console.log(`\nOpen this URL in your browser:\n${event.verificationUri}`);
		console.log(`Enter code: ${event.userCode}`);
		if (process.platform === "darwin") spawnSync("open", [event.verificationUri], { stdio: "ignore" });
		return;
	}
	console.log(event.message);
}

export function credentialStoreDescription(): string {
	return CREDENTIAL_BACKEND === "file"
		? `private file ${AUTH_PATH}`
		: `${systemCredentialStoreName()} · metadata ${AUTH_PATH}`;
}

export function createCredentialStore(): CredentialStore {
	return CREDENTIAL_BACKEND === "file"
		? new FileCredentialStore(AUTH_PATH)
		: new SystemCredentialStore(AUTH_PATH, {
				service: ACTIVE_KEYCHAIN_SERVICE,
				legacyService: LEGACY_KEYCHAIN_SERVICE,
			});
}

export function createProviderRuntime(override?: ProviderCredentialOverride): MutableModels {
	const base = createCredentialStore();
	return builtinModels({ credentials: override ? new OverlayCredentialStore(base, override) : base });
}

export async function loginProvider(providerId = DEFAULT_PROVIDER): Promise<void> {
	const models = createProviderRuntime();
	const provider = models.getProvider(providerId);
	if (!provider) throw new Error(`Unknown provider: ${providerId}`);
	const type = provider.auth.oauth ? "oauth" : "api_key";
	await models.login(providerId, type, { prompt: answerPrompt, notify: notifyAuth });
	console.log(`Credentials saved to ${credentialStoreDescription()}`);
}

export async function providerStatuses(
	models: Models = createProviderRuntime(),
): Promise<readonly { readonly provider: string; readonly auth: string; readonly configured: boolean }[]> {
	const providers = ["openai", "openai-codex", "anthropic", "google", "openrouter"];
	return Promise.all(
		providers.map(async (provider) => ({
			provider,
			auth: models.getProvider(provider)?.auth.oauth ? "OAuth / subscription" : "API key",
			configured: Boolean(await models.checkAuth(provider)),
		})),
	);
}

export function resolveModel(models: Models, provider = DEFAULT_PROVIDER, modelId = DEFAULT_MODEL): Model<Api> {
	const model = models.getModel(provider, modelId);
	if (!model) throw new Error(`Model is unavailable: ${provider}/${modelId}`);
	return model;
}
