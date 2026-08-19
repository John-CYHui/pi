import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export interface SessionStorageWriter {
	append(line: string): Promise<void>;
	appendSync?(line: string): void;
	flush(): Promise<void>;
	flushSync?(): void;
	close(): Promise<void>;
	closeSync?(): void;
	isOpen(): boolean;
	getError(): Error | undefined;
}

export interface SessionStorage {
	ensureDir(path: string): void;
	exists(path: string): boolean;
	stat(path: string): { size: number; mtimeMs: number };
	read(path: string): string;
	listFiles(dir: string, pattern: string): string[];
	write(path: string, content: string): void;
	append(path: string, content: string): void;
	openWriter(path: string): SessionStorageWriter;
	close?(): Promise<void>;
}

class SynchronousSessionStorageWriter implements SessionStorageWriter {
	private open = true;
	private error: Error | undefined;
	private readonly storage: SessionStorage;
	private readonly path: string;

	constructor(storage: SessionStorage, path: string) {
		this.storage = storage;
		this.path = path;
	}

	append(line: string): Promise<void> {
		try {
			this.appendSync?.(line);
			return Promise.resolve();
		} catch (error) {
			this.error ??= error instanceof Error ? error : new Error(String(error));
			return Promise.reject(this.error);
		}
	}

	appendSync(line: string): void {
		if (!this.open) throw new Error("Session storage writer is closed");
		this.storage.append(this.path, line);
	}

	flush(): Promise<void> {
		this.flushSync?.();
		return Promise.resolve();
	}

	flushSync(): void {
		if (!this.open) throw new Error("Session storage writer is closed");
		if (this.error) throw this.error;
	}

	close(): Promise<void> {
		this.closeSync?.();
		return Promise.resolve();
	}

	closeSync(): void {
		this.open = false;
	}

	getError(): Error | undefined {
		return this.error;
	}

	isOpen(): boolean {
		return this.open;
	}
}

export class FileSessionStorage implements SessionStorage {
	ensureDir(path: string): void {
		if (!existsSync(path)) mkdirSync(path, { recursive: true });
	}

	exists(path: string): boolean {
		return existsSync(path);
	}

	stat(path: string): { size: number; mtimeMs: number } {
		const stats = statSync(path);
		return { size: stats.size, mtimeMs: stats.mtimeMs };
	}

	listFiles(dir: string, pattern: string): string[] {
		if (pattern !== "*.jsonl") return [];
		try {
			return readdirSync(dir).filter((name) => name.endsWith(".jsonl")).map((name) => join(dir, name));
		} catch {
			return [];
		}
	}

	read(path: string): string {
		return readFileSync(path, "utf8");
	}

	write(path: string, content: string): void {
		this.ensureDir(dirname(path));
		const fd = openSync(path, "w");
		try {
			writeFileSync(fd, content);
		} finally {
			closeSync(fd);
		}
	}

	append(path: string, content: string): void {
		appendFileSync(path, content);
	}

	openWriter(path: string): SessionStorageWriter {
		return new SynchronousSessionStorageWriter(this, path);
	}
}

export class MemorySessionStorage implements SessionStorage {
	private readonly files = new Map<string, { content: string; mtimeMs: number }>();
	private nextMtimeMs = Date.now();

	ensureDir(_path: string): void {}

	exists(path: string): boolean {
		return this.files.has(path);
	}

	read(path: string): string {
		const file = this.files.get(path);
		if (file === undefined) throw new Error(`Session file not found: ${path}`);
		return file.content;
	}

	stat(path: string): { size: number; mtimeMs: number } {
		const file = this.files.get(path);
		if (file === undefined) throw new Error(`Session file not found: ${path}`);
		return { size: Buffer.byteLength(file.content, "utf8"), mtimeMs: file.mtimeMs };
	}

	listFiles(dir: string, pattern: string): string[] {
		if (pattern !== "*.jsonl") return [];
		const prefix = dir.endsWith("/") ? dir : `${dir}/`;
		return [...this.files.keys()].filter(
			(path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/") && path.endsWith(".jsonl"),
		);
	}

	write(path: string, content: string): void {
		this.files.set(path, { content, mtimeMs: ++this.nextMtimeMs });
	}

	append(path: string, content: string): void {
		const previous = this.files.get(path)?.content ?? "";
		this.files.set(path, { content: `${previous}${content}`, mtimeMs: ++this.nextMtimeMs });
	}

	openWriter(path: string): SessionStorageWriter {
		return new SynchronousSessionStorageWriter(this, path);
	}
}
