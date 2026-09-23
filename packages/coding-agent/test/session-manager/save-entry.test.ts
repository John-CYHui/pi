import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CustomEntry, SessionManager } from "../../src/core/session-manager.ts";
import { FileSessionStorage, type SessionStorageWriter } from "../../src/core/session-storage.ts";

class FailingAppendStorage extends FileSessionStorage {
	override openWriter(_path: string): SessionStorageWriter {
		return {
			append: () => Promise.reject(new Error("audit storage failed")),
			appendSync: () => {
				throw new Error("audit storage failed");
			},
			flush: () => Promise.resolve(),
			close: () => Promise.resolve(),
			isOpen: () => true,
			getError: () => undefined,
		};
	}
}

describe("SessionManager.saveCustomEntry", () => {
	it("rolls back tree state when synchronous persistence fails", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-session-rollback-"));
		try {
			const session = SessionManager.create(root, join(root, "sessions"), {
				storage: new FailingAppendStorage(),
			});
			session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
			session.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
				api: "anthropic-messages",
				provider: "anthropic",
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
			const entriesBefore = session.getEntries();
			const leafBefore = session.getLeafId();

			expect(() => session.appendCustomEntry("audit", { safe: true })).toThrow("audit storage failed");

			expect(session.getEntries()).toEqual(entriesBefore);
			expect(session.getLeafId()).toBe(leafBefore);
			expect(session.getBranch().map((entry) => entry.id)).toEqual(entriesBefore.map((entry) => entry.id));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("saves custom entries and includes them in tree traversal", () => {
		const session = SessionManager.inMemory();

		// Save a message
		const msgId = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });

		// Save a custom entry
		const customId = session.appendCustomEntry("my_data", { foo: "bar" });

		// Save another message
		const msg2Id = session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "anthropic-messages",
			provider: "anthropic",
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

		// Custom entry should be in entries
		const entries = session.getEntries();
		expect(entries).toHaveLength(3);

		const customEntry = entries.find((e) => e.type === "custom") as CustomEntry;
		expect(customEntry).toBeDefined();
		expect(customEntry.customType).toBe("my_data");
		expect(customEntry.data).toEqual({ foo: "bar" });
		expect(customEntry.id).toBe(customId);
		expect(customEntry.parentId).toBe(msgId);

		// Tree structure should be correct
		const path = session.getBranch();
		expect(path).toHaveLength(3);
		expect(path[0].id).toBe(msgId);
		expect(path[1].id).toBe(customId);
		expect(path[2].id).toBe(msg2Id);

		// buildSessionContext should work (custom entries skipped in messages)
		const ctx = session.buildSessionContext();
		expect(ctx.messages).toHaveLength(2); // only message entries
	});
});
