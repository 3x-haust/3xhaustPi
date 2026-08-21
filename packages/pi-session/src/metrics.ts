import type { AgentHarnessEvent } from "@earendil-works/pi-agent-core";

export interface ThreeXhaustSessionMetrics {
	readonly providerRequests: number;
	readonly modelTurns: number;
	readonly uncachedInputTokens: number;
	readonly outputTokens: number;
	readonly cache: {
		readonly readTokens: number;
		readonly writeTokens: number;
		readonly eligibleTokens: number;
		readonly hitRate: number;
	};
	readonly tools: {
		readonly calls: number;
		readonly succeeded: number;
		readonly failed: number;
		readonly successRate: number | null;
	};
}

export class ThreeXhaustSessionMetricsCollector {
	#providerRequests = 0;
	#modelTurns = 0;
	#uncachedInputTokens = 0;
	#outputTokens = 0;
	#cacheReadTokens = 0;
	#cacheWriteTokens = 0;
	#toolCalls = 0;
	#toolSucceeded = 0;
	#toolFailed = 0;

	recordProviderRequest(): void {
		this.#providerRequests += 1;
	}

	record(event: AgentHarnessEvent): void {
		if (event.type === "message_end" && event.message.role === "assistant") {
			this.#modelTurns += 1;
			this.#uncachedInputTokens += event.message.usage.input;
			this.#outputTokens += event.message.usage.output;
			this.#cacheReadTokens += event.message.usage.cacheRead;
			this.#cacheWriteTokens += event.message.usage.cacheWrite;
			return;
		}
		if (event.type === "tool_execution_start") {
			this.#toolCalls += 1;
			return;
		}
		if (event.type === "tool_execution_end") {
			if (event.isError) this.#toolFailed += 1;
			else this.#toolSucceeded += 1;
		}
	}

	snapshot(): ThreeXhaustSessionMetrics {
		const eligibleTokens = this.#uncachedInputTokens + this.#cacheReadTokens + this.#cacheWriteTokens;
		return {
			providerRequests: this.#providerRequests,
			modelTurns: this.#modelTurns,
			uncachedInputTokens: this.#uncachedInputTokens,
			outputTokens: this.#outputTokens,
			cache: {
				readTokens: this.#cacheReadTokens,
				writeTokens: this.#cacheWriteTokens,
				eligibleTokens,
				hitRate: eligibleTokens === 0 ? 0 : this.#cacheReadTokens / eligibleTokens,
			},
			tools: {
				calls: this.#toolCalls,
				succeeded: this.#toolSucceeded,
				failed: this.#toolFailed,
				successRate: this.#toolCalls === 0 ? null : this.#toolSucceeded / this.#toolCalls,
			},
		};
	}
}
