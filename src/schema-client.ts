import type { ContentSchema } from "./types.js";
import type { SyncFetch } from "./sync-stream.js";

export interface SyncSchemaRequestOptions {
	/** Read-only API key sent as `Authorization: Bearer <apiKey>`. */
	apiKey: string;
	/** Overrides the transport, for example to instrument requests. */
	fetch?: SyncFetch;
	/** Cancels the schema request when aborted. */
	signal?: AbortSignal;
}

/** An unsuccessful HTTP response while retrieving schema metadata. */
export class SyncSchemaHttpError extends Error {
	readonly status: number;
	readonly statusText: string;

	constructor(response: Response) {
		super(
			`Sync schema request failed with HTTP ${response.status} ${response.statusText}`,
		);
		this.name = "SyncSchemaHttpError";
		this.status = response.status;
		this.statusText = response.statusText;
	}
}

/** Retrieves the current schema for each content type accessible to this API key. */
export async function fetchSyncSchemas(
	syncUrl: string,
	options: SyncSchemaRequestOptions,
): Promise<ContentSchema[]> {
	return requestSchemaJson<ContentSchema[]>(
		schemaCollectionUrl(syncUrl),
		options,
	);
}

/** Retrieves the schema whose version exactly matches a sync content item. */
export async function fetchSyncSchemaVersion(
	syncUrl: string,
	contentType: string,
	version: number,
	options: SyncSchemaRequestOptions,
): Promise<ContentSchema> {
	if (!Number.isSafeInteger(version) || version < 1) {
		throw new RangeError("Schema version must be a positive safe integer");
	}
	const url = schemaCollectionUrl(syncUrl);
	url.pathname += `/${encodeURIComponent(contentType)}/${version}`;
	return requestSchemaJson<ContentSchema>(url, options);
}

/** Derives the API-key schema collection endpoint from a `/sync` endpoint URL. */
export function schemaCollectionUrl(syncUrl: string): URL {
	const base = typeof location === "undefined" ? undefined : location.href;
	const url = new URL(syncUrl, base);
	if (!url.pathname.endsWith("/sync")) {
		throw new TypeError("The sync URL must end with /sync");
	}
	url.pathname += "/schemas";
	url.search = "";
	url.hash = "";
	return url;
}

async function requestSchemaJson<T>(
	url: URL,
	options: SyncSchemaRequestOptions,
): Promise<T> {
	if (options.apiKey.length === 0) {
		throw new TypeError("SyncSchemaRequestOptions.apiKey must not be empty");
	}
	const request = options.fetch ?? globalThis.fetch;
	const response = await request(url, {
		headers: {
			accept: "application/json",
			authorization: `Bearer ${options.apiKey}`,
		},
		signal: options.signal,
	});
	if (!response.ok) throw new SyncSchemaHttpError(response);
	return (await response.json()) as T;
}
