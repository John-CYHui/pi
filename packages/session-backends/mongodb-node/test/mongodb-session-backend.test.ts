import { MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoSessionStorageBackend } from "../src/index.ts";

const uri = process.env.PI_MONGODB_URI;
const database = `pi_session_test_${process.pid}`;
let client: MongoClient | undefined;

describe.skipIf(!uri)("MongoSessionStorageBackend", () => {
	beforeAll(async () => {
		client = new MongoClient(uri!);
		await client.connect();
	});

	afterAll(async () => {
		if (client) {
			await client.db(database).dropDatabase();
			await client.close();
		}
	});

	it("recovers sessions and rejects stale or out-of-order revisions", async () => {
		const backend = new MongoSessionStorageBackend({ client: client!, database, fence: "writer-a" });
		await backend.initialize();
		await backend.write("/sessions/a.jsonl", "header\n", 1, { fence: "writer-a", sequence: 1 });
		await backend.append("/sessions/a.jsonl", "entry\n", 2, { fence: "writer-a", sequence: 2 });

		const loaded = [...(await backend.load())];
		expect(loaded[0]?.content).toBe("header\nentry\n");
		expect(loaded[0]?.revision.sequence).toBe(2);

		await expect(
			backend.append("/sessions/a.jsonl", "duplicate\n", 3, { fence: "writer-a", sequence: 2 }),
		).rejects.toThrow("revision conflict");
		await expect(
			backend.append("/sessions/a.jsonl", "stale\n", 3, { fence: "writer-b", sequence: 3 }),
		).rejects.toThrow("revision conflict");
	});
});
