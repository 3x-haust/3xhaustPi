import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { AsyncEntry } from "@napi-rs/keyring";

type StoredCredentials = Record<string, Credential>;
type CredentialMetadata = Record<string, { readonly type: Credential["type"]; readonly storage: "os-keyring" }>;

export interface SecureCredentialEntry {
	getPassword(): Promise<string | null | undefined>;
	setPassword(password: string): Promise<void>;
	deleteCredential(): Promise<boolean>;
}

export type SecureCredentialEntryFactory = (providerId: string) => SecureCredentialEntry;

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function parseRecord(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Credential store is not a JSON object");
	}
	return parsed as Record<string, unknown>;
}

function parseCredentials(path: string): StoredCredentials {
	return parseRecord(path) as StoredCredentials;
}

function isCredentialType(value: unknown): value is Credential["type"] {
	return value === "api_key" || value === "oauth";
}

function isCredential(value: unknown): value is Credential {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	return isCredentialType((value as { readonly type?: unknown }).type);
}

function isCredentialMetadata(
	value: unknown,
): value is { readonly type: Credential["type"]; readonly storage: "os-keyring" } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const candidate = value as { readonly type?: unknown; readonly storage?: unknown };
	return isCredentialType(candidate.type) && candidate.storage === "os-keyring";
}

function writePrivateJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	chmodSync(temporary, 0o600);
	renameSync(temporary, path);
	chmodSync(path, 0o600);
}

async function withCredentialLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
	const lockPath = `${path}.lock`;
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const deadline = Date.now() + 10_000;
	let descriptor: number | undefined;
	while (descriptor === undefined) {
		try {
			descriptor = openSync(lockPath, "wx", 0o600);
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error
					? String((error as { readonly code?: unknown }).code)
					: "";
			if (code !== "EEXIST") throw error;
			if (existsSync(lockPath) && Date.now() - statSync(lockPath).mtimeMs > 30_000) {
				unlinkSync(lockPath);
				continue;
			}
			if (Date.now() >= deadline) throw new Error("Credential store lock timed out");
			await wait(50);
		}
	}
	try {
		return await operation();
	} finally {
		closeSync(descriptor);
		if (existsSync(lockPath)) unlinkSync(lockPath);
	}
}

export class FileCredentialStore implements CredentialStore {
	readonly #path: string;
	readonly #chains = new Map<string, Promise<unknown>>();

	constructor(path: string) {
		this.#path = path;
	}

	async #withLock<T>(operation: () => Promise<T>): Promise<T> {
		return withCredentialLock(this.#path, operation);
	}

	#write(credentials: StoredCredentials): void {
		writePrivateJson(this.#path, credentials);
	}

	#enqueue<T>(providerId: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.#chains.get(providerId) ?? Promise.resolve();
		const next = previous.catch(() => {}).then(operation);
		this.#chains.set(
			providerId,
			next.catch(() => {}),
		);
		return next;
	}

	async read(providerId: string): Promise<Credential | undefined> {
		return parseCredentials(this.#path)[providerId];
	}

	async list(): Promise<readonly CredentialInfo[]> {
		return Object.entries(parseCredentials(this.#path)).map(([providerId, credential]) => ({
			providerId,
			type: credential.type,
		}));
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		return this.#enqueue(providerId, () =>
			this.#withLock(async () => {
				const credentials = parseCredentials(this.#path);
				const current = credentials[providerId];
				const next = await fn(current);
				if (next === undefined) return current;
				this.#write({ ...credentials, [providerId]: next });
				return next;
			}),
		);
	}

	delete(providerId: string): Promise<void> {
		return this.#enqueue(providerId, () =>
			this.#withLock(async () => {
				const credentials = parseCredentials(this.#path);
				if (!(providerId in credentials)) return;
				const { [providerId]: _removed, ...remaining } = credentials;
				this.#write(remaining);
			}),
		);
	}
}

export class SystemCredentialStore implements CredentialStore {
	readonly #path: string;
	readonly #entryFactory: SecureCredentialEntryFactory;
	readonly #legacyEntryFactory: SecureCredentialEntryFactory | undefined;
	readonly #chains = new Map<string, Promise<unknown>>();
	#migration: Promise<void> | undefined;

	constructor(
		path: string,
		options: {
			readonly service?: string;
			readonly legacyService?: string;
			readonly entryFactory?: SecureCredentialEntryFactory;
			readonly legacyEntryFactory?: SecureCredentialEntryFactory;
		} = {},
	) {
		this.#path = path;
		const service = options.service ?? "io.3xhaustpi.cli.credentials.v1";
		this.#entryFactory =
			options.entryFactory ??
			((providerId) => {
				return new AsyncEntry(service, providerId);
			});
		this.#legacyEntryFactory =
			options.legacyEntryFactory ??
			(options.legacyService ? (providerId) => new AsyncEntry(options.legacyService!, providerId) : undefined);
	}

	#enqueue<T>(providerId: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.#chains.get(providerId) ?? Promise.resolve();
		const next = previous.catch(() => {}).then(operation);
		this.#chains.set(
			providerId,
			next.catch(() => {}),
		);
		return next;
	}

	#metadata(): CredentialMetadata {
		return Object.fromEntries(
			Object.entries(parseRecord(this.#path)).flatMap(([providerId, value]) =>
				isCredentialMetadata(value) ? [[providerId, value] as const] : [],
			),
		);
	}

	async #readSecure(providerId: string): Promise<Credential | undefined> {
		const entry = this.#entryFactory(providerId);
		let serialized = await entry.getPassword();
		if (
			(serialized === undefined || serialized === null) &&
			this.#legacyEntryFactory &&
			providerId in this.#metadata()
		) {
			serialized = await this.#legacyEntryFactory(providerId).getPassword();
			if (serialized !== undefined && serialized !== null) {
				await entry.setPassword(serialized);
				if ((await entry.getPassword()) !== serialized) {
					throw new Error(`OS credential migration verification failed for provider ${providerId}`);
				}
			}
		}
		if (serialized === undefined || serialized === null) return undefined;
		const parsed = JSON.parse(serialized) as unknown;
		if (!isCredential(parsed)) throw new Error(`OS credential entry is invalid for provider ${providerId}`);
		return parsed;
	}

	async #restore(providerId: string, credential: Credential | undefined): Promise<void> {
		const entry = this.#entryFactory(providerId);
		if (credential === undefined) {
			await entry.deleteCredential();
			return;
		}
		await entry.setPassword(JSON.stringify(credential));
	}

	async #ensureMigrated(): Promise<void> {
		this.#migration ??= withCredentialLock(this.#path, async () => {
			const raw = parseRecord(this.#path);
			const legacy = Object.entries(raw).flatMap(([providerId, value]) =>
				isCredential(value) && !isCredentialMetadata(value) ? [[providerId, value] as const] : [],
			);
			if (legacy.length === 0) {
				if (existsSync(this.#path)) chmodSync(this.#path, 0o600);
				return;
			}

			const metadata: CredentialMetadata = Object.fromEntries(
				Object.entries(raw).flatMap(([providerId, value]) =>
					isCredentialMetadata(value) ? [[providerId, value] as const] : [],
				),
			);
			const previous: Array<readonly [string, Credential | undefined]> = [];
			try {
				for (const [providerId, credential] of legacy) {
					previous.push([providerId, await this.#readSecure(providerId)]);
					const entry = this.#entryFactory(providerId);
					const serialized = JSON.stringify(credential);
					await entry.setPassword(serialized);
					if ((await entry.getPassword()) !== serialized) {
						throw new Error(`OS credential verification failed for provider ${providerId}`);
					}
					metadata[providerId] = { type: credential.type, storage: "os-keyring" };
				}
				writePrivateJson(this.#path, metadata);
			} catch (cause) {
				for (const [providerId, credential] of previous.reverse()) {
					await this.#restore(providerId, credential).catch(() => {});
				}
				throw cause;
			}
		});
		return this.#migration;
	}

	async read(providerId: string): Promise<Credential | undefined> {
		await this.#ensureMigrated();
		return this.#readSecure(providerId);
	}

	async list(): Promise<readonly CredentialInfo[]> {
		await this.#ensureMigrated();
		return Object.entries(this.#metadata()).map(([providerId, credential]) => ({
			providerId,
			type: credential.type,
		}));
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		return this.#enqueue(providerId, async () => {
			await this.#ensureMigrated();
			return withCredentialLock(this.#path, async () => {
				const current = await this.#readSecure(providerId);
				const next = await fn(current);
				if (next === undefined) return current;
				const entry = this.#entryFactory(providerId);
				const serialized = JSON.stringify(next);
				try {
					await entry.setPassword(serialized);
					if ((await entry.getPassword()) !== serialized) {
						throw new Error(`OS credential verification failed for provider ${providerId}`);
					}
					writePrivateJson(this.#path, {
						...this.#metadata(),
						[providerId]: { type: next.type, storage: "os-keyring" },
					});
				} catch (cause) {
					await this.#restore(providerId, current).catch(() => {});
					throw cause;
				}
				return next;
			});
		});
	}

	delete(providerId: string): Promise<void> {
		return this.#enqueue(providerId, async () => {
			await this.#ensureMigrated();
			await withCredentialLock(this.#path, async () => {
				const current = await this.#readSecure(providerId);
				const metadata = this.#metadata();
				if (current === undefined && !(providerId in metadata)) return;
				try {
					await this.#entryFactory(providerId).deleteCredential();
					const { [providerId]: _removed, ...remaining } = metadata;
					writePrivateJson(this.#path, remaining);
				} catch (cause) {
					await this.#restore(providerId, current).catch(() => {});
					throw cause;
				}
			});
		});
	}
}

export function systemCredentialStoreName(platform = process.platform): string {
	if (platform === "darwin") return "macOS Keychain";
	if (platform === "win32") return "Windows Credential Manager";
	if (platform === "linux") return "Linux Secret Service";
	return "OS credential store";
}
