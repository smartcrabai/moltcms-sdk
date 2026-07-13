import type { DeliveryItem } from "./types.js";

/** A fetch implementation used to open the sync stream. */
export type SyncFetch = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

export interface SyncStreamHandlers<Item> {
	/** A content or schema change. `seq` is the raw SSE event id. */
	onChange: (item: Item, seq: string) => void | Promise<void>;
	/** The feed is fully drained; persist this opaque cursor for the next run. */
	onComplete?: (cursor: string) => void | Promise<void>;
	/** A server-sent `error` event. */
	onError?: (message: string) => void | Promise<void>;
	/** Network, HTTP-status, malformed-payload, or consumer-handler failures. */
	onTransportError?: (error: unknown) => void | Promise<void>;
}

export interface SyncStreamOptions {
	/** Read-only API key sent as `Authorization: Bearer <apiKey>`. */
	apiKey: string;
	/** Opaque cursor from the preceding `sync-complete` event. */
	cursor?: string;
	/** Selects the published (default) or draft feed. */
	kind?: "published" | "draft";
	/** Stops after `sync-complete` or server `error`; defaults to `true`. */
	autoClose?: boolean;
	/** Cancels the stream when aborted. */
	signal?: AbortSignal;
	/** Overrides the transport, for example to instrument requests. */
	fetch?: SyncFetch;
}

export interface SyncStream {
	/** Stops the request and prevents any reconnect. Idempotent. */
	close: () => void;
	/** Whether this client has been closed. */
	readonly closed: boolean;
}

/** An unsuccessful HTTP response while opening the sync feed. */
export class SyncHttpError extends Error {
	readonly status: number;
	readonly statusText: string;

	constructor(response: Response) {
		super(
			`Sync request failed with HTTP ${response.status} ${response.statusText}`,
		);
		this.name = "SyncHttpError";
		this.status = response.status;
		this.statusText = response.statusText;
	}
}

interface SseMessage {
	event: string;
	data: string;
	id: string | undefined;
}

interface SseParserCallbacks {
	onMessage: (message: SseMessage) => Promise<void>;
	onRetry: (milliseconds: number) => void;
}

const DEFAULT_RETRY_MILLISECONDS = 3_000;

/**
 * Opens an authenticated, reconnecting client for a moltcms `/sync` SSE feed.
 *
 * `fetch` is used instead of `EventSource` because the moltcms endpoint
 * requires a Bearer API key, which the browser's native EventSource cannot
 * attach. After an interrupted connection the client sends the most recent
 * `change` event id in `Last-Event-ID`; that header takes precedence over a
 * supplied cursor on the server.
 */
export function openSyncStream<Item = DeliveryItem>(
	syncUrl: string,
	handlers: SyncStreamHandlers<Item>,
	options: SyncStreamOptions,
): SyncStream {
	if (options.apiKey.length === 0) {
		throw new TypeError("SyncStreamOptions.apiKey must not be empty");
	}

	const base = typeof location === "undefined" ? undefined : location.href;
	const url = new URL(syncUrl, base);
	if (options.cursor !== undefined)
		url.searchParams.set("cursor", options.cursor);
	if (options.kind !== undefined) url.searchParams.set("kind", options.kind);

	const shutdown = new AbortController();
	const request = options.fetch ?? globalThis.fetch;
	const autoClose = options.autoClose ?? true;
	let activeRequest: AbortController | undefined;
	let closed = false;
	let lastEventId: string | undefined;
	let retryMilliseconds = DEFAULT_RETRY_MILLISECONDS;

	const close = (): void => {
		if (closed) return;
		closed = true;
		activeRequest?.abort();
		shutdown.abort();
	};
	const stopForExternalAbort = (): void => close();
	if (options.signal !== undefined) {
		if (options.signal.aborted) close();
		else
			options.signal.addEventListener("abort", stopForExternalAbort, {
				once: true,
			});
	}

	void consume();

	return {
		close,
		get closed(): boolean {
			return closed;
		},
	};

	async function consume(): Promise<void> {
		while (!closed) {
			const controller = new AbortController();
			activeRequest = controller;
			const abortFromShutdown = (): void => controller.abort();
			shutdown.signal.addEventListener("abort", abortFromShutdown, {
				once: true,
			});

			try {
				const response = await request(url, {
					headers: syncHeaders(options.apiKey, lastEventId),
					signal: controller.signal,
				});
				if (!response.ok) {
					close();
					await handlers.onTransportError?.(new SyncHttpError(response));
					return;
				}
				if (response.body === null) {
					throw new TypeError("Sync response did not include a body");
				}

				await parseSse(response.body, {
					onMessage: async (message) => {
						if (!closed) await handleMessage(message);
					},
					onRetry: (milliseconds) => {
						retryMilliseconds = milliseconds;
					},
				});
			} catch (error) {
				if (!closed) await handlers.onTransportError?.(error);
			} finally {
				shutdown.signal.removeEventListener("abort", abortFromShutdown);
				if (activeRequest === controller) activeRequest = undefined;
			}

			if (!closed) await delay(retryMilliseconds, shutdown.signal);
		}
	}

	async function handleMessage(message: SseMessage): Promise<void> {
		switch (message.event) {
			case "change": {
				try {
					const item = JSON.parse(message.data) as Item;
					await handlers.onChange(item, message.id ?? "");
					if (message.id !== undefined) lastEventId = message.id;
				} catch (error) {
					// A failed consumer has not durably handled this change. Do not
					// accept the completion cursor or advance Last-Event-ID past it.
					close();
					await handlers.onTransportError?.(error);
				}
				break;
			}
			case "sync-complete": {
				try {
					const cursor: unknown = JSON.parse(message.data);
					if (typeof cursor !== "string") {
						throw new TypeError("sync-complete data must be a JSON string");
					}
					if (autoClose) close();
					await handlers.onComplete?.(cursor);
				} catch (error) {
					close();
					await handlers.onTransportError?.(error);
				}
				break;
			}
			case "error":
				if (autoClose) close();
				await handlers.onError?.(message.data);
				break;
			default:
				break;
		}
	}
}

function syncHeaders(apiKey: string, lastEventId: string | undefined): Headers {
	const headers = new Headers({
		accept: "text/event-stream",
		authorization: `Bearer ${apiKey}`,
	});
	if (lastEventId !== undefined && lastEventId.length > 0) {
		headers.set("last-event-id", lastEventId);
	}
	return headers;
}

async function parseSse(
	body: ReadableStream<Uint8Array>,
	callbacks: SseParserCallbacks,
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let event = "message";
	let data: string[] = [];
	let id: string | undefined;

	const dispatch = async (): Promise<void> => {
		if (data.length > 0) {
			await callbacks.onMessage({ event, data: data.join("\n"), id });
		}
		event = "message";
		data = [];
		id = undefined;
	};
	const processLine = async (line: string): Promise<void> => {
		if (line.length === 0) {
			await dispatch();
			return;
		}
		if (line.startsWith(":")) return;

		const separator = line.indexOf(":");
		const field = separator === -1 ? line : line.slice(0, separator);
		const valueStart = separator === -1 ? line.length : separator + 1;
		const value =
			line.charAt(valueStart) === " "
				? line.slice(valueStart + 1)
				: line.slice(valueStart);
		switch (field) {
			case "event":
				event = value;
				break;
			case "data":
				data.push(value);
				break;
			case "id":
				if (!value.includes("\0")) id = value;
				break;
			case "retry": {
				if (/^\d+$/.test(value)) callbacks.onRetry(Number(value));
				break;
			}
			default:
				break;
		}
	};

	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) return;
			buffer += decoder.decode(chunk.value, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline).replace(/\r$/, "");
				buffer = buffer.slice(newline + 1);
				await processLine(line);
				newline = buffer.indexOf("\n");
			}
		}
	} finally {
		reader.releaseLock();
	}
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, milliseconds);
	const abort = (): void => {
		clearTimeout(timer);
		resolve();
	};
	signal.addEventListener("abort", abort, { once: true });
	return promise.finally(() => signal.removeEventListener("abort", abort));
}
