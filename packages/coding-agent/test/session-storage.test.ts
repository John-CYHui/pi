import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	IndexedSessionStorage,
	MemoryIndexedBackend,
} from "../src/core/indexed-session-storage.ts";
import { MemorySessionStorage, type SessionStorageWriter } from "../src/core/session-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const tempDirs: string[] = [];

class FailingMemorySessionStorage extends MemorySessionStorage {
	openWriter(): SessionStorageWriter {
		let open = true;
		const failure = new Error("remote append failed");
		return {
			append: async () => {
				throw failure;
			},
			flush: async () => {
				throw failure;
			},
			close: async () => {
				open = false;
				throw failure;
			},
			isOpen: () => open,
			getError: () => failure,
		};
	}
}

class DelayedMemorySessionStorage extends MemorySessionStorage {
	openWriter(path: string): SessionStorageWriter {
		let open = true;
		let error: Error | undefined;
		let tail = Promise.resolve();
		return {
			append: (line) => {
				if (!open) return Promise.reject(new Error("Session storage writer is closed"));
				tail = tail.then(
					() =>
						new Promise<void>((resolve) => {
							setTimeout(() => {
								try {
									this.append(path, line);
									resolve();
								} catch (cause) {
									error = cause instanceof Error ? cause : new Error(String(cause));
									resolve();
								}
							}, 5);
						}),
				);
				return tail;
			},
			flush: () => tail.then(() => {
				if (error) throw error;
			}),
			close: async () => {
				await tail;
				open = false;
			},
			isOpen: () => open,
			getError: () => error,
		};
	}
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	}
});

describe("SessionStorage integration", () => {
	it("preserves the default filesystem session behavior", () => {
		const root = join(tmpdir(), `pi-session-storage-file-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
		tempDirs.push(root);

		const manager = SessionManager.create(cwd, join(root, "sessions"));
		manager.appendSessionInfo("filesystem");
		const sessionFile = manager.getSessionFile();

		expect(sessionFile).toBeDefined();
		expect(existsSync(sessionFile!)).toBe(false);
		manager.appendMessage({ role: "assistant", content: [], timestamp: Date.now() } as never);
		expect(existsSync(sessionFile!)).toBe(true);
	});

	it("can reopen and list a session through an injected backend", async () => {
		const root = join(tmpdir(), `pi-session-storage-memory-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = join(root, "project");
		const sessionDir = join(root, "sessions");
		const storage = new MemorySessionStorage();

		const manager = SessionManager.create(cwd, sessionDir, { storage });
		manager.appendSessionInfo("memory");
		manager.appendMessage({ role: "assistant", content: [], timestamp: Date.now() } as never);
		const sessionFile = manager.getSessionFile();
		expect(sessionFile).toBeDefined();
		expect(storage.exists(sessionFile!)).toBe(true);

		expect((await SessionManager.list(cwd, sessionDir, undefined, storage))).toHaveLength(1);
		const reopened = SessionManager.open(sessionFile!, sessionDir, undefined, storage);
		expect(reopened.getCwd()).toBe(cwd);
		expect(reopened.getSessionId()).toBe(manager.getSessionId());
		expect(reopened.getSessionName()).toBe("memory");
	});

	it("orders delayed appends and waits for them during flush", async () => {
		const storage = new DelayedMemorySessionStorage();
		const manager = SessionManager.create("/project", "/sessions", { storage });
		manager.appendMessage({ role: "assistant", content: [], timestamp: Date.now() } as never);
		const sessionFile = manager.getSessionFile()!;
		manager.appendSessionInfo("delayed");

		expect(storage.read(sessionFile)).not.toContain('"name":"delayed"');
		await manager.flush();
		expect(storage.read(sessionFile)).toContain('"name":"delayed"');
		await manager.close();
	});

	it("publishes indexed storage writes in order and drains them", async () => {
		const backend = new MemoryIndexedBackend(5);
		const storage = new IndexedSessionStorage(backend);
		await storage.initialize();
		const manager = SessionManager.create("/project", "/sessions", { storage });
		manager.appendMessage({ role: "assistant", content: [], timestamp: Date.now() } as never);
		manager.appendSessionInfo("indexed");
		const sessionFile = manager.getSessionFile()!;

		expect(storage.read(sessionFile)).not.toContain('"name":"indexed"');
		await manager.flush();
		expect(storage.read(sessionFile)).toContain('"name":"indexed"');
		await storage.drain();
		const reloaded = new IndexedSessionStorage(backend);
		await reloaded.initialize();
		expect(reloaded.read(sessionFile)).toContain('"name":"indexed"');
	});

	it("forks through the injected backend without filesystem access", () => {
		const storage = new MemorySessionStorage();
		const source = SessionManager.create("/source", "/sessions", { storage });
		source.appendMessage({ role: "assistant", content: [], timestamp: Date.now() } as never);
		const sourcePath = source.getSessionFile()!;

		const forked = SessionManager.forkFrom(sourcePath, "/target", "/sessions", { storage });
		const forkedPath = forked.getSessionFile()!;
		expect(storage.exists(forkedPath)).toBe(true);
		expect(forked.getCwd()).toBe("/target");
		expect(forked.getEntries()).toHaveLength(source.getEntries().length);
	});

	it("surfaces asynchronous append failures from flush and close", async () => {
		const manager = SessionManager.create("/project", "/sessions", { storage: new FailingMemorySessionStorage() });
		manager.appendMessage({ role: "assistant", content: [], timestamp: Date.now() } as never);
		manager.appendSessionInfo("failure");

		await expect(manager.flush()).rejects.toThrow("remote append failed");
		await expect(manager.close()).rejects.toThrow("remote append failed");
	});
});
