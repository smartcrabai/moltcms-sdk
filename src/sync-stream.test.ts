import { afterEach, expect, test } from "bun:test";
import {
	openSyncStream,
	SyncHttpError,
	type SyncStream,
	type SyncStreamHandlers,
	type SyncStreamOptions,
} from "./index.js";

interface TestServer {
	readonly port: number | undefined;
	stop: (closeActiveConnections?: boolean) => Promise<void>;
}

interface SseConnection {
	request: Request;
	ordinal: number;
	send: (chunk: string) => void;
	close: () => void;
}

const servers: TestServer[] = [];
const streams: SyncStream[] = [];

type TestSyncStreamOptions = Omit<SyncStreamOptions, "apiKey"> & {
	apiKey?: string;
};

afterEach(async () => {
	for (const stream of streams.splice(0)) stream.close();
	await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});

function serverPort(server: TestServer): number {
	if (server.port === undefined)
		throw new Error("test server is not listening");
	return server.port;
}

function startSseServer(
	onConnection: (connection: SseConnection) => void,
): string {
	let connections = 0;
	const encoder = new TextEncoder();
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			const ordinal = ++connections;
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					let open = true;
					onConnection({
						request,
						ordinal,
						send(chunk) {
							if (open) controller.enqueue(encoder.encode(chunk));
						},
						close() {
							if (open) controller.close();
							open = false;
						},
					});
				},
			});
			return new Response(body, {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	servers.push(server);
	return `http://127.0.0.1:${serverPort(server)}/tenants/tenant-1/sync`;
}

const change = (id: number, payload: unknown): string =>
	`event: change\nid: ${id}\ndata: ${JSON.stringify(payload)}\n\n`;
const complete = (cursor: string): string =>
	`event: sync-complete\ndata: ${JSON.stringify(cursor)}\n\n`;

function open<Item>(
	url: string,
	handlers: SyncStreamHandlers<Item>,
	options: TestSyncStreamOptions = {},
): SyncStream {
	const stream = openSyncStream<Item>(url, handlers, {
		apiKey: options.apiKey ?? "read-key",
		...options,
	});
	streams.push(stream);
	return stream;
}

test("sends Bearer auth, forwards query options, drains changes, and closes", async () => {
	const requestReceived = Promise.withResolvers<Request>();
	const completed = Promise.withResolvers<string>();
	const received: Array<{ id: string; seq: string }> = [];
	const errors: unknown[] = [];
	const url = startSseServer((connection) => {
		requestReceived.resolve(connection.request);
		connection.send(change(1, { type: "content", id: "first" }));
		connection.send(change(2, { type: "content", id: "second" }));
		connection.send(complete("cursor / with spaces"));
		connection.close();
	});

	const stream = open<{ id: string }>(
		url,
		{
			onChange: (item, seq) => {
				received.push({ id: item.id, seq });
			},
			onComplete: completed.resolve,
			onTransportError: (error) => {
				errors.push(error);
			},
		},
		{ apiKey: "top-secret", cursor: "before / now", kind: "draft" },
	);

	const request = await requestReceived.promise;
	expect(request.headers.get("authorization")).toBe("Bearer top-secret");
	expect(request.headers.get("accept")).toBe("text/event-stream");
	const requestedUrl = new URL(request.url);
	expect(requestedUrl.searchParams.get("cursor")).toBe("before / now");
	expect(requestedUrl.searchParams.get("kind")).toBe("draft");
	expect(await completed.promise).toBe("cursor / with spaces");
	expect(received).toEqual([
		{ id: "first", seq: "1" },
		{ id: "second", seq: "2" },
	]);
	expect(errors).toEqual([]);
	expect(stream.closed).toBe(true);
});

test("reconnects with Last-Event-ID and retains Bearer authentication", async () => {
	const completed = Promise.withResolvers<string>();
	const received: string[] = [];
	const headers: Array<{
		authorization: string | null;
		lastEventId: string | null;
	}> = [];
	const url = startSseServer((connection) => {
		headers.push({
			authorization: connection.request.headers.get("authorization"),
			lastEventId: connection.request.headers.get("last-event-id"),
		});
		connection.send("retry: 1\n\n");
		if (connection.ordinal === 1) {
			connection.send(change(5, { id: "early" }));
			connection.close();
			return;
		}
		connection.send(change(6, { id: "late" }));
		connection.send(complete("resume-cursor"));
		connection.close();
	});

	open<{ id: string }>(url, {
		onChange: (item) => {
			received.push(item.id);
		},
		onComplete: completed.resolve,
		onTransportError: (error) => {
			throw error;
		},
	});

	expect(await completed.promise).toBe("resume-cursor");
	expect(received).toEqual(["early", "late"]);
	expect(headers).toEqual([
		{ authorization: "Bearer read-key", lastEventId: null },
		{ authorization: "Bearer read-key", lastEventId: "5" },
	]);
});

test("autoClose false reconnects after each completed cycle until the caller closes", async () => {
	const secondCycle = Promise.withResolvers<void>();
	const cursors: string[] = [];
	const url = startSseServer((connection) => {
		connection.send("retry: 1\n\n");
		connection.send(complete(`cursor-${connection.ordinal}`));
		connection.close();
	});
	let stream: SyncStream;
	stream = open(
		url,
		{
			onChange: () => {},
			onComplete: (cursor) => {
				cursors.push(cursor);
				if (cursors.length === 2) {
					stream.close();
					secondCycle.resolve();
				}
			},
		},
		{ autoClose: false },
	);

	await secondCycle.promise;
	expect(cursors).toEqual(["cursor-1", "cursor-2"]);
	expect(stream.closed).toBe(true);
});

test("server error events reach onError and stop the default stream", async () => {
	const serverError = Promise.withResolvers<string>();
	const url = startSseServer((connection) => {
		connection.send("event: error\ndata: API key revoked\n\n");
		connection.close();
	});
	const stream = open(url, {
		onChange: () => {},
		onError: serverError.resolve,
	});

	expect(await serverError.promise).toBe("API key revoked");
	expect(stream.closed).toBe(true);
});

test("awaits asynchronous change handlers before delivering the completion cursor", async () => {
	const firstChangeStarted = Promise.withResolvers<void>();
	const allowFirstChangeToFinish = Promise.withResolvers<void>();
	const completed = Promise.withResolvers<string>();
	const deliveryOrder: string[] = [];
	const url = startSseServer((connection) => {
		connection.send(change(1, { id: "first" }));
		connection.send(change(2, { id: "second" }));
		connection.send(complete("durable-cursor"));
		connection.close();
	});

	open<{ id: string }>(url, {
		onChange: async (item) => {
			deliveryOrder.push(`${item.id}:start`);
			if (item.id === "first") {
				firstChangeStarted.resolve();
				await allowFirstChangeToFinish.promise;
			}
			deliveryOrder.push(`${item.id}:finish`);
		},
		onComplete: (cursor) => {
			deliveryOrder.push("complete");
			completed.resolve(cursor);
		},
	});

	await firstChangeStarted.promise;
	expect(deliveryOrder).toEqual(["first:start"]);
	allowFirstChangeToFinish.resolve();
	expect(await completed.promise).toBe("durable-cursor");
	expect(deliveryOrder).toEqual([
		"first:start",
		"first:finish",
		"second:start",
		"second:finish",
		"complete",
	]);
});

test("a malformed change stops without accepting its completion cursor", async () => {
	const transportError = Promise.withResolvers<unknown>();
	const changes: string[] = [];
	let completed = false;
	const url = startSseServer((connection) => {
		connection.send("event: change\nid: 1\ndata: not-json\n\n");
		connection.send(change(2, { id: "must-not-arrive" }));
		connection.send(complete("must-not-arrive"));
		connection.close();
	});

	const stream = open<{ id: string }>(url, {
		onChange: (item) => {
			changes.push(item.id);
		},
		onComplete: () => {
			completed = true;
		},
		onTransportError: transportError.resolve,
	});

	expect(await transportError.promise).toBeInstanceOf(SyntaxError);
	expect(changes).toEqual([]);
	expect(completed).toBe(false);
	expect(stream.closed).toBe(true);
});

test("a failed asynchronous change handler never accepts the completion cursor", async () => {
	const transportError = Promise.withResolvers<unknown>();
	let completed = false;
	const url = startSseServer((connection) => {
		connection.send(change(1, { id: "not-durable" }));
		connection.send(complete("must-not-arrive"));
		connection.close();
	});

	const stream = open<{ id: string }>(url, {
		onChange: async () => {
			throw new Error("persistence failed");
		},
		onComplete: () => {
			completed = true;
		},
		onTransportError: transportError.resolve,
	});

	const error = await transportError.promise;
	expect(error).toBeInstanceOf(Error);
	expect(error).toMatchObject({ message: "persistence failed" });
	expect(completed).toBe(false);
	expect(stream.closed).toBe(true);
});

test("HTTP failures report SyncHttpError and do not reconnect", async () => {
	const receivedError = Promise.withResolvers<unknown>();
	let requests = 0;
	const server = Bun.serve({
		port: 0,
		fetch() {
			requests += 1;
			return new Response("forbidden", {
				status: 403,
				statusText: "Forbidden",
			});
		},
	});
	servers.push(server);

	const stream = open(
		`http://127.0.0.1:${serverPort(server)}/tenants/tenant-1/sync`,
		{
			onChange: () => {},
			onTransportError: receivedError.resolve,
		},
	);
	const error = await receivedError.promise;

	expect(error).toBeInstanceOf(SyncHttpError);
	expect(error).toMatchObject({ status: 403, statusText: "Forbidden" });
	expect(requests).toBe(1);
	expect(stream.closed).toBe(true);
});
