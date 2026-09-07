import { randomUUID } from "node:crypto";
import { MemorySessionStorage, type SessionStorage, type SessionStorageWriter } from "./session-storage.ts";

export interface SessionStorageRevision {
	/** Monotonically increasing revision for one logical session path. */
	sequence: number;
	/** Stable writer identity used to reject stale pod/process writers. */
	fence: string;
}

export interface IndexedSessionStorageEntry {
	path: string;
	content: string;
	mtimeMs: number;
	revision: SessionStorageRevision;
}

export interface IndexedSessionStorageBackend {
	load(): Promise<Iterable<IndexedSessionStorageEntry>>;
	write(path: string, content: string, mtimeMs: number, revision: SessionStorageRevision): Promise<void>;
	append(path: string, content: string, mtimeMs: number, revision: SessionStorageRevision): Promise<void>;
	delete(path: string, revision: SessionStorageRevision): Promise<void>;
}

/**
 * A synchronous indexed view over an asynchronous session backend.
 *
 * SessionManager reads and updates the local index synchronously. Mutations are
 * published to the backend in per-path order and can be awaited with drain().
 */
export class IndexedSessionStorage implements SessionStorage {
	private readonly index = new MemorySessionStorage();
	private readonly tails = new Map<string, Promise<void>>();
	private pending: Promise<void> = Promise.resolve();
	private initialized = false;
	private readonly backend: IndexedSessionStorageBackend;
	private readonly closeBackend?: () => Promise<void>;
	private readonly fence: string;
	private readonly sequences = new Map<string, number>();

	constructor(
		backend: IndexedSessionStorageBackend,
		fence: string = randomUUID(),
		closeBackend?: () => Promise<void>,
	) {
		this.backend = backend;
		this.fence = fence;
		this.closeBackend = closeBackend;
	}

	async initialize(): Promise<void> {
		const entries = await this.backend.load();
		for (const entry of entries) {
			this.index.restore(entry.path, entry.content, entry.mtimeMs);
			this.sequences.set(entry.path, entry.revision.sequence);
		}
		this.initialized = true;
	}

	isInitialized(): boolean {
		return this.initialized;
	}

	ensureDir(path: string): void {
		this.index.ensureDir(path);
	}

	exists(path: string): boolean {
		return this.index.exists(path);
	}

	stat(path: string): { size: number; mtimeMs: number } {
		return this.index.stat(path);
	}

	read(path: string): string {
		return this.index.read(path);
	}

	listFiles(dir: string, pattern: string): string[] {
		return this.index.listFiles(dir, pattern);
	}

	write(path: string, content: string): void {
		this.index.write(path, content);
		const mtimeMs = this.index.stat(path).mtimeMs;
		const revision = this.nextRevision(path);
		this.enqueue(path, () => this.backend.write(path, content, mtimeMs, revision));
	}

	append(path: string, content: string): void {
		this.index.append(path, content);
		const mtimeMs = this.index.stat(path).mtimeMs;
		const revision = this.nextRevision(path);
		this.enqueue(path, () => this.backend.append(path, content, mtimeMs, revision));
	}

	async delete(path: string): Promise<void> {
		if (!this.index.exists(path)) throw new Error(`Session file not found: ${path}`);
		const revision = this.nextRevision(path);
		await this.enqueueAndWait(path, () => this.backend.delete(path, revision));
		await this.index.delete(path);
	}

	openWriter(path: string): SessionStorageWriter {
		let open = true;
		let error: Error | undefined;
		return {
			append: (line) => {
				if (!open) return Promise.reject(new Error("Session storage writer is closed"));
				this.append(path, line);
				return this.tails.get(path) ?? Promise.resolve();
			},
			flush: () => this.drain(),
			close: async () => {
				await this.drain();
				open = false;
			},
			isOpen: () => open,
			getError: () => error,
		};
	}

	async drain(): Promise<void> {
		await this.pending;
		await Promise.all([...this.tails.values()]);
	}

	async close(): Promise<void> {
		await this.drain();
		await this.closeBackend?.();
	}

	private nextRevision(path: string): SessionStorageRevision {
		const sequence = (this.sequences.get(path) ?? 0) + 1;
		this.sequences.set(path, sequence);
		return { sequence, fence: this.fence };
	}

	private enqueue(path: string, operation: () => Promise<void>): void {
		void this.enqueueAndWait(path, operation);
	}

	private enqueueAndWait(path: string, operation: () => Promise<void>): Promise<void> {
		const previous = this.tails.get(path) ?? Promise.resolve();
		const next = previous.then(operation);
		this.tails.set(path, next);
		this.pending = Promise.all([this.pending, next]).then(() => undefined);
		return next;
	}
}

/** Small backend useful for integration tests and local adapter development. */
export class MemoryIndexedBackend implements IndexedSessionStorageBackend {
	private readonly files = new Map<string, IndexedSessionStorageEntry>();
	private readonly fences = new Map<string, string>();
	private delayMs: number;

	constructor(delayMs = 0) {
		this.delayMs = delayMs;
	}

	async load(): Promise<Iterable<IndexedSessionStorageEntry>> {
		return [...this.files.values()];
	}

	async write(path: string, content: string, mtimeMs: number, revision: SessionStorageRevision): Promise<void> {
		await this.delay();
		this.acceptRevision(path, revision);
		this.files.set(path, { path, content, mtimeMs, revision });
	}

	async append(path: string, content: string, mtimeMs: number, revision: SessionStorageRevision): Promise<void> {
		await this.delay();
		this.acceptRevision(path, revision);
		const previous = this.files.get(path)?.content ?? "";
		this.files.set(path, { path, content: `${previous}${content}`, mtimeMs, revision });
	}

	async delete(path: string, revision: SessionStorageRevision): Promise<void> {
		await this.delay();
		this.acceptRevision(path, revision);
		this.files.delete(path);
	}

	private acceptRevision(path: string, revision: SessionStorageRevision): void {
		const previous = this.files.get(path)?.revision;
		if (previous && previous.fence !== revision.fence) {
			throw new Error(`Session storage fence rejected for ${path}`);
		}
		if (previous && revision.sequence !== previous.sequence + 1) {
			throw new Error(`Session storage sequence conflict for ${path}`);
		}
		this.fences.set(path, revision.fence);
	}

	private async delay(): Promise<void> {
		if (this.delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
	}
}
