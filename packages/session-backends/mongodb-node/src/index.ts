import { randomUUID } from "node:crypto";
import { MongoClient, type Collection, type Db } from "mongodb";
export interface SessionStorageRevision {
	sequence: number;
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
}

interface SessionDocument {
	_id: string;
	path: string;
	content: string;
	mtimeMs: number;
	sequence: number;
	fence: string;
	updatedAt: Date;
}

interface FenceDocument {
	_id: string;
	fence: string;
	updatedAt: Date;
}

export interface MongoSessionBackendOptions {
	client: MongoClient;
	database: string;
	collectionPrefix?: string;
	fence: string;
}

export interface MongoCredentialFile {
	uri: string;
	database: string;
	collectionPrefix?: string;
	fence?: string;
}

export async function createMongoSessionBackend(credentials: MongoCredentialFile): Promise<{
	backend: MongoSessionStorageBackend;
	close: () => Promise<void>;
}> {
	const client = new MongoClient(credentials.uri);
	await client.connect();
	const backend = new MongoSessionStorageBackend({
		client,
		database: credentials.database,
		collectionPrefix: credentials.collectionPrefix,
		fence: credentials.fence ?? randomUUID(),
	});
	await backend.initialize();
	return { backend, close: () => client.close() };
}

export function parseMongoCredentialFile(value: unknown): MongoCredentialFile {
	if (value === null || typeof value !== "object") throw new Error("MongoDB credential file must contain a JSON object");
	const record = value as Record<string, unknown>;
	if (typeof record.uri !== "string" || record.uri.length === 0) {
		throw new Error('MongoDB credential file requires a non-empty "uri"');
	}
	if (typeof record.database !== "string" || record.database.length === 0) {
		throw new Error('MongoDB credential file requires a non-empty "database"');
	}
	if (record.collectionPrefix !== undefined && typeof record.collectionPrefix !== "string") {
		throw new Error('MongoDB credential file "collectionPrefix" must be a string');
	}
	if (record.fence !== undefined && typeof record.fence !== "string") {
		throw new Error('MongoDB credential file "fence" must be a string');
	}
	return {
		uri: record.uri,
		database: record.database,
		...(record.collectionPrefix !== undefined ? { collectionPrefix: record.collectionPrefix } : {}),
		...(record.fence !== undefined ? { fence: record.fence } : {}),
	};
}

export class MongoSessionStorageBackend implements IndexedSessionStorageBackend {
	private readonly db: Db;
	private readonly sessions: Collection<SessionDocument>;
	private readonly fences: Collection<FenceDocument>;
	private readonly prefix: string;
	private readonly fence: string;
	private initialized = false;

	constructor(options: MongoSessionBackendOptions) {
		this.db = options.client.db(options.database);
		this.prefix = options.collectionPrefix ?? "pi_sessions";
		this.sessions = this.db.collection<SessionDocument>(`${this.prefix}_documents`);
		this.fences = this.db.collection<FenceDocument>(`${this.prefix}_fences`);
		this.fence = options.fence;
	}

	async initialize(): Promise<void> {
		await this.sessions.createIndex({ path: 1 }, { unique: true });
		await this.sessions.createIndex({ updatedAt: -1 });
		await this.fences.createIndex({ updatedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 });
		await this.fences.updateOne(
			{ _id: this.fence },
			{ $set: { fence: this.fence, updatedAt: new Date() } },
			{ upsert: true },
		);
		this.initialized = true;
	}

	async load(): Promise<Iterable<IndexedSessionStorageEntry>> {
		this.requireInitialized();
		const rows = await this.sessions.find({}).toArray();
		return rows.map((row) => ({
			path: row.path,
			content: row.content,
			mtimeMs: row.mtimeMs,
			revision: { sequence: row.sequence, fence: row.fence },
		}));
	}

	async write(path: string, content: string, mtimeMs: number, revision: SessionStorageRevision): Promise<void> {
		await this.commit(path, content, mtimeMs, revision);
	}

	async append(path: string, content: string, mtimeMs: number, revision: SessionStorageRevision): Promise<void> {
		this.requireInitialized();
		const result = await this.sessions.updateOne(
			{ _id: path, sequence: revision.sequence - 1, fence: revision.fence },
			[
				{
					$set: {
						content: { $concat: [{ $ifNull: ["$content", ""] }, content] },
						mtimeMs,
						sequence: revision.sequence,
						fence: revision.fence,
						updatedAt: new Date(),
					},
				},
			],
		);
		if (result.matchedCount !== 1) {
			throw new Error(`MongoDB session revision conflict for ${path}`);
		}
	}

	private async commit(
		path: string,
		content: string,
		mtimeMs: number,
		revision: SessionStorageRevision,
	): Promise<void> {
		this.requireInitialized();
		const result = await this.sessions.updateOne(
			{
				_id: path,
				$or: [
					{ sequence: revision.sequence - 1, fence: revision.fence },
					{ sequence: { $exists: false } },
				],
			},
			{
				$set: {
					_id: path,
					path,
					content,
					mtimeMs,
					sequence: revision.sequence,
					fence: revision.fence,
					updatedAt: new Date(),
				},
			},
			{ upsert: true },
		);
		if (result.matchedCount === 0 && result.upsertedCount === 0) {
			throw new Error(`MongoDB session revision conflict for ${path}`);
		}
	}

	private requireInitialized(): void {
		if (!this.initialized) throw new Error("MongoSessionStorageBackend.initialize() must be called first");
	}
}
