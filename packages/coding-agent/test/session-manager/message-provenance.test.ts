import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager, type SessionMessageEntry } from "../../src/core/session-manager.ts";
import { FileSessionStorage, type SessionStorageWriter } from "../../src/core/session-storage.ts";
import { createHarness } from "../suite/harness.ts";

const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 123 });

class FailingAppendStorage extends FileSessionStorage {
	override openWriter(_path: string): SessionStorageWriter {
		return {
			append: () => Promise.reject(new Error("append failed")),
			appendSync: () => {
				throw new Error("append failed");
			},
			flush: () => Promise.resolve(),
			close: () => Promise.resolve(),
			isOpen: () => true,
			getError: () => undefined,
		};
	}
}

describe("SessionManager message provenance", () => {
	it("maps only exact objects, never equal timestamps, contents or non-message asides", () => {
		const manager = SessionManager.inMemory();
		const first = user("same");
		const second = user("same");
		const firstId = manager.appendMessage(first);
		manager.appendCustomEntry("aside", { timestamp: 123 });
		const secondId = manager.appendMessage(second);
		expect(manager.getMessageEntryId(first)).toBe(firstId);
		expect(manager.getMessageEntryId(second)).toBe(secondId);
		expect(manager.getMessageEntryId(user("same"))).toBeUndefined();
		expect(manager.getMessageEntryId({ ...first })).toBeUndefined();
	});

	it("projects restored, synthesized and normalized messages without exposing IDs on messages", () => {
		const original = user("old");
		const normalized = {
			role: "user" as const,
			content: null,
			timestamp: 123,
		} as unknown as SessionMessageEntry["message"];
		const manager = SessionManager.inMemory("/tmp", undefined, [
			{ type: "session", version: 3, id: "test", cwd: "/tmp", timestamp: "2025-01-01" },
			{ type: "message", id: "old", parentId: null, timestamp: "2025-01-01", message: original },
			{
				type: "message",
				id: "normalized",
				parentId: "old",
				timestamp: "2025-01-01",
				message: normalized,
			},
			{
				type: "custom_message",
				id: "custom",
				parentId: "normalized",
				timestamp: "2025-01-01",
				customType: "a",
				content: "note",
				display: false,
			},
			{
				type: "branch_summary",
				id: "branch",
				parentId: "custom",
				timestamp: "2025-01-01",
				summary: "branch note",
				fromId: "old",
			},
		]);
		const context = manager.buildSessionContext();
		expect(context.messages.map((message) => manager.getMessageEntryId(message))).toEqual([
			"old",
			"normalized",
			"custom",
			"branch",
		]);
		expect(manager.getMessageEntryId(original)).toBe("old");
		expect(manager.getMessageEntryId(normalized)).toBe("normalized");
		expect(context.messages[1]).not.toBe(normalized);
		expect(context.messages[1]).toMatchObject({ content: [] });
		expect(Object.keys(context.messages[2])).not.toContain("id");
		expect(manager.getMessageEntryId({ ...context.messages[2] })).toBeUndefined();
	});

	it("fails closed on duplicate objects and inactive branches/compacted history", () => {
		const manager = SessionManager.inMemory();
		const shared = user("reused");
		const firstId = manager.appendMessage(shared);
		manager.appendMessage(shared);
		expect(manager.getMessageEntryId(shared)).toBeUndefined();
		const discarded = user("discarded");
		manager.appendMessage(discarded);
		manager.branch(firstId);
		expect(manager.getMessageEntryId(discarded)).toBeUndefined();
		const kept = user("kept");
		const keptId = manager.appendMessage(kept);
		const summaryId = manager.appendCompaction("summary", keptId, 100);
		const [summary, projectedKept] = manager.buildSessionContext().messages;
		expect(manager.getMessageEntryId(summary)).toBe(summaryId);
		expect(manager.getMessageEntryId(projectedKept)).toBe(keptId);
		manager.appendCompaction("later", "absent", 100);
		expect(manager.getMessageEntryId(summary)).toBeUndefined();
		expect(manager.getMessageEntryId(kept)).toBeUndefined();
	});

	it("invalidates previous session objects on new session", () => {
		const manager = SessionManager.inMemory();
		const old = user("old");
		manager.appendMessage(old);
		manager.newSession();
		expect(manager.getMessageEntryId(old)).toBeUndefined();
	});

	it("does not claim deferred or failed file appends were persisted", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-provenance-"));
		try {
			const manager = SessionManager.create(root, join(root, "sessions"), { storage: new FailingAppendStorage() });
			const deferred = user("deferred");
			const deferredId = manager.appendMessage(deferred);
			expect(manager.getMessageEntryId(deferred)).toBeUndefined();
			manager.appendMessage({
				role: "assistant",
				content: [],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				stopReason: "stop",
				timestamp: 123,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
			expect(manager.getMessageEntryId(deferred)).toBe(deferredId);
			const failed = user("failed");
			expect(() => manager.appendMessage(failed)).toThrow("append failed");
			expect(manager.getMessageEntryId(failed)).toBeUndefined();
			expect(manager.getMessageEntryId(deferred)).toBe(deferredId);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("registers live user, assistant, tool result, custom, and bash messages", async () => {
		const harness = await createHarness({
			tools: [
				{
					name: "echo",
					label: "Echo",
					description: "Echo",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "result" }], details: {} }),
				},
			],
		});
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("echo", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("start");
			expect(harness.session.messages.map((message) => message.role)).toEqual([
				"user",
				"assistant",
				"toolResult",
				"assistant",
			]);
			for (const message of harness.session.messages) {
				expect(harness.sessionManager.getMessageEntryId(message)).toBeDefined();
			}
			await harness.session.sendCustomMessage({ customType: "note", content: "note", display: false });
			const custom = harness.session.messages.at(-1)!;
			expect(harness.sessionManager.getMessageEntryId(custom)).toBe(harness.sessionManager.getLeafId());
			harness.session.recordBashResult("echo ok", { output: "ok", exitCode: 0, cancelled: false, truncated: false });
			expect(harness.sessionManager.getMessageEntryId(harness.session.messages.at(-1)!)).toBe(
				harness.sessionManager.getLeafId(),
			);
		} finally {
			harness.cleanup();
		}
	});

	it("registers custom message_end objects and ignores unrelated context-only messages", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => ({
						message: { customType: "injected", content: "note", display: false },
					}));
				},
			],
		});
		try {
			harness.setResponses([fauxAssistantMessage("done")]);
			await harness.session.prompt("hello");
			const custom = harness.session.messages.find((message) => message.role === "custom")!;
			expect(harness.sessionManager.getMessageEntryId(custom)).toBeDefined();
			expect(harness.sessionManager.getMessageEntryId({ ...custom })).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});

	it("restores file-backed compaction and custom-message identities in SDK state", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-provenance-resume-"));
		try {
			const source = SessionManager.create(root, join(root, "sessions"));
			source.appendMessage(user("summarized"));
			const kept = source.appendMessage(user("kept"));
			const summary = source.appendCompaction("summary", kept, 100);
			const custom = source.appendCustomMessageEntry("note", "after", false);
			// The first assistant flushes the deferred entries to disk.
			source.appendMessage({
				role: "assistant",
				content: [],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				stopReason: "stop",
				timestamp: 123,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
			const assistantId = source.getLeafId();
			const file = source.getSessionFile()!;
			const manager = SessionManager.open(file);
			const model = getModel("anthropic", "claude-sonnet-4-5");
			const { session } = await createAgentSession({ cwd: root, agentDir: root, sessionManager: manager, model });
			try {
				expect(session.messages.map((message) => manager.getMessageEntryId(message))).toEqual([
					summary,
					kept,
					custom,
					assistantId,
				]);
			} finally {
				session.dispose();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("registers direct custom messages and the SDK initial restore objects", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-provenance-sdk-"));
		try {
			const manager = SessionManager.inMemory(root);
			const id = manager.appendMessage(user("restored"));
			const model = getModel("anthropic", "claude-sonnet-4-5");
			const { session } = await createAgentSession({ cwd: root, agentDir: root, sessionManager: manager, model });
			try {
				expect(manager.getMessageEntryId(session.messages[0])).toBe(id);
				await session.sendCustomMessage({ customType: "note", content: "aside", display: false });
				const message = session.messages.at(-1)!;
				expect(manager.getMessageEntryId(message)).toBe(manager.getLeafId());
				expect(manager.getMessageEntryId({ ...message })).toBeUndefined();
			} finally {
				session.dispose();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
