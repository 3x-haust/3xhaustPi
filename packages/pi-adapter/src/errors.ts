export type PiAdapterErrorCode = "CLOSED" | "PROVIDER_ERROR" | "INVALID_SEMANTIC_OUTPUT";

export class PiAdapterError extends Error {
	readonly code: PiAdapterErrorCode;

	constructor(code: PiAdapterErrorCode, message: string) {
		super(message);
		this.name = "PiAdapterError";
		this.code = code;
	}
}
