import { describe, expect, it } from "vitest";
import { parseMongoCredentialFile } from "../src/index.ts";

describe("parseMongoCredentialFile", () => {
	it("accepts the credential file shape", () => {
		expect(
			parseMongoCredentialFile({
				uri: "mongodb://127.0.0.1:27017",
				database: "pi-dev",
				collectionPrefix: "sessions",
				fence: "local-dev",
			}),
		).toEqual({
			uri: "mongodb://127.0.0.1:27017",
			database: "pi-dev",
			collectionPrefix: "sessions",
			fence: "local-dev",
		});
	});

	it("rejects missing connection details", () => {
		expect(() => parseMongoCredentialFile({ database: "pi-dev" })).toThrow('requires a non-empty "uri"');
		expect(() => parseMongoCredentialFile({ uri: "mongodb://localhost" })).toThrow('requires a non-empty "database"');
	});
});
