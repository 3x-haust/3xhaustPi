export type SemanticContractErrorCode =
	| "INVALID_TYPE"
	| "INVALID_KEYS"
	| "UNSUPPORTED_VERSION"
	| "INVALID_IDENTIFIER"
	| "INVALID_TEXT"
	| "INVALID_LENGTH"
	| "INVALID_VALUE";

export interface SerializedSemanticContractError {
	readonly name: "SemanticContractError";
	readonly code: SemanticContractErrorCode;
	readonly message: string;
}

export class SemanticContractError extends Error {
	readonly name = "SemanticContractError";
	readonly code: SemanticContractErrorCode;

	constructor(code: SemanticContractErrorCode, message: string) {
		super(message);
		this.code = code;
	}

	toJSON(): SerializedSemanticContractError {
		return { name: this.name, code: this.code, message: this.message };
	}
}
