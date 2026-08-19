# MongoDB session backend

Optional MongoDB backend for `@earendil-works/pi-coding-agent`.

The package implements `IndexedSessionStorageBackend` and is not imported by the coding-agent runtime by default. Applications must create and initialize the backend explicitly:

```ts
import { MongoClient } from "mongodb";
import {
	IndexedSessionStorage,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { MongoSessionStorageBackend } from "@earendil-works/pi-session-backend-mongodb-node";

const client = new MongoClient(process.env.MONGODB_URI!);
await client.connect();

const backend = new MongoSessionStorageBackend({
	client,
	database: "agent",
	fence: crypto.randomUUID(),
});
await backend.initialize();

const storage = new IndexedSessionStorage(backend);
await storage.initialize();
const sessionManager = SessionManager.create(process.cwd(), undefined, { storage });
```

## Native Pi CLI usage

With the Pi CLI, pass the backend explicitly:

```bash
pi --session-backend mongodb
```

By default, Pi reads:

```text
app/.credential_store/mongodb.json
```

Override the file location with:

```bash
pi --session-backend mongodb --mongodb-credential path/to/mongodb.json
```

Example credential file:

```json
{
  "uri": "mongodb://127.0.0.1:27017",
  "database": "pi-dev",
  "collectionPrefix": "pi_sessions",
  "fence": "local-dev"
}
```

The credential file should be protected as a secret and excluded from source control.

## Durability model

- Session bodies are stored as one document per logical session path.
- Writes carry a per-path sequence and writer fence.
- The backend rejects stale fences and out-of-order sequences.
- `IndexedSessionStorage.drain()` must complete before process shutdown.
- MongoDB retry, deployment identity, tenant isolation, retention, and operational recovery remain application responsibilities.

This initial adapter is intentionally small. It does not provide Kubernetes leases or cross-process fence acquisition; callers must provide a unique and appropriately managed `fence` value.
