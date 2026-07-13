# @moltcms-sdk/client

Typed, authenticated client for the moltcms incremental-sync SSE endpoint.

## Install

```sh
npm install @moltcms-sdk/client
```

## Usage

`openSyncStream` uses `fetch`, not the native `EventSource`, so it can send the
required Bearer API key. `onChange` may be asynchronous; changes are delivered
one at a time and the completion cursor is not emitted until each handler has
finished successfully.

```ts
import { openSyncStream, type DeliveryItem } from "@moltcms-sdk/client";

const stream = openSyncStream<DeliveryItem>(
	"https://api.example.com/tenants/tenant-id/sync",
	{
		onChange: async (item, seq) => {
			await persistChange(item, seq);
		},
		onComplete: async (cursor) => {
			await persistCursor(cursor);
		},
		onError: (message) => console.error("moltcms sync error:", message),
		onTransportError: (error) => console.error("moltcms transport error:", error),
	},
	{
		apiKey: process.env.MOLTCMS_READ_KEY!,
		cursor: await loadCursor(),
	},
);

```

Call `stream.close()` only when the consumer is shutting down or the sync is no
longer needed; it aborts the active request and disables reconnects.

After an interrupted connection, the client reuses the last successfully
handled change event id as `Last-Event-ID`. On the next fresh sync, pass the
opaque cursor received by `onComplete` through the `cursor` option instead.

The default `autoClose: true` stops the stream after a `sync-complete` or
server `error` event. Set `autoClose: false` to reconnect after each completed
cycle.

## Generated, schema-safe items

The API-key endpoint `GET /tenants/{tenant}/sync/schemas` exposes the current
schema definitions. Generate an importable type module before compiling the
consumer:

```sh
npx moltcms-sdk-codegen \
	--sync-url https://api.example.com/tenants/tenant-id/sync \
	--api-key "$MOLTCMS_READ_KEY" \
	--output src/moltcms-schema.ts
```

Use the generated map with `openTypedSyncStream`:

```ts
import { openTypedSyncStream } from "@moltcms-sdk/client";
import {
	schemaVersions,
	type MoltcmsSchemas,
} from "./moltcms-schema.js";

openTypedSyncStream<MoltcmsSchemas>(
	"https://api.example.com/tenants/tenant-id/sync",
	{
		onChange: async (item) => {
			if (item.type === "content" && item.content_type === "post") {
				await persistPost(item.data.title);
			}
		},
	},
	{
		apiKey: process.env.MOLTCMS_READ_KEY!,
		schemaVersions,
	},
);
```

For every content item, the client retrieves and validates the exact
`(content_type, schema_version)` before calling `onChange`. A version absent
from the generated module fails closed; regenerate after a schema change before
accepting data written with that version. The API intentionally does not cast
old content to the latest schema.

## Publishing

Pushing a tag named `v<package.json version>` runs the release workflow. Before
the first release, configure npm Trusted Publishing with:

- Package: `@moltcms-sdk/client`
- Organization: `smartcrabai`
- Repository: `moltcms-sdk`
- Workflow filename: `release.yml`
- Environment: leave empty

The workflow publishes with npm provenance.
