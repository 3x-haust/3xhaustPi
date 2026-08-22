import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	AgentSessionNotFoundError,
	cacheRoutingOptions,
	openAgentSessionManager,
	providerCacheAffinity,
} from "../src/agent-runtime.ts";

describe("native agent cache routing", () => {
	it("keeps project/provider/model affinity deterministic and isolated", () => {
		const first = providerCacheAffinity("/project", "openai-codex", "gpt-5.6-terra");
		expect(providerCacheAffinity("/project", "openai-codex", "gpt-5.6-terra")).toBe(first);
		expect(providerCacheAffinity("/other", "openai-codex", "gpt-5.6-terra")).not.toBe(first);
		expect(providerCacheAffinity("/project", "openai-codex", "gpt-5.4")).not.toBe(first);
		expect(first).toMatch(/^3xhaustpi_[0-9a-f]{32}$/u);
	});

	it("uses long-lived main affinity and an isolated short compaction affinity", () => {
		expect(cacheRoutingOptions("cache_key", "You are the coding agent.")).toEqual({
			cacheRetention: "long",
			sessionId: "cache_key",
			promptCacheKey: "cache_key",
		});
		expect(cacheRoutingOptions("cache_key", "You are a context summarization assistant. Summarize.")).toEqual({
			cacheRetention: "short",
			sessionId: "cache_key_compaction",
			promptCacheKey: "cache_key_compaction",
		});
	});

	it("reopens only the exact persisted session for the same project", async () => {
		const root = mkdtempSync(join(tmpdir(), "3xhaustpi-agent-session-"));
		const projectRoot = join(root, "project");
		const sessionDir = join(root, "sessions");
		const sessionId = "01a02620-d48b-7bec-bfe9-e1a99c466b87";
		try {
			const created = SessionManager.create(projectRoot, sessionDir, { id: sessionId });
			created.appendMessage({ role: "user", content: "continue", timestamp: 1 });
			created.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "continued" }],
				api: "openai-completions",
				provider: "openai",
				model: "test",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			});
			const reopened = await openAgentSessionManager(projectRoot, sessionId, sessionDir);
			expect(reopened.getSessionId()).toBe(sessionId);
			await expect(openAgentSessionManager(projectRoot, "session_missing", sessionDir)).rejects.toBeInstanceOf(
				AgentSessionNotFoundError,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
