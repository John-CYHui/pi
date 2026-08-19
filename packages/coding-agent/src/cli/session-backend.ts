import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createMongoSessionBackend, parseMongoCredentialFile } from "@earendil-works/pi-session-backend-mongodb-node";
import { IndexedSessionStorage } from "../core/indexed-session-storage.ts";
import type { SessionStorage } from "../core/session-storage.ts";

export interface SessionBackendOptions {
	kind?: "file" | "mongodb";
	credentialPath?: string;
}

export async function createSessionStorage(cwd: string, options: SessionBackendOptions): Promise<SessionStorage | undefined> {
	if (options.kind !== "mongodb") return undefined;

	const credentialPath = resolve(cwd, options.credentialPath ?? "app/.credential_store/mongodb.json");
	let credentials: ReturnType<typeof parseMongoCredentialFile>;
	try {
		credentials = parseMongoCredentialFile(JSON.parse(await readFile(credentialPath, "utf8")));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot read MongoDB credentials from ${credentialPath}: ${message}`);
	}

	const { backend, close } = await createMongoSessionBackend(credentials);
	const storage = new IndexedSessionStorage(backend, credentials.fence ?? randomUUID(), close);
	await storage.initialize();
	return storage;
}
