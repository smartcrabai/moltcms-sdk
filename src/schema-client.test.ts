import { afterEach, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ts from "typescript";
import {
	fetchSyncSchemaVersion,
	fetchSyncSchemas,
	openTypedSyncStream,
	type ContentSchema,
	type SchemaVersionIndex,
} from "./index.js";
import { generateSchemaTypes } from "./codegen.js";

interface TestServer {
	readonly port: number | undefined;
	stop: (closeActiveConnections?: boolean) => Promise<void>;
}

const servers: TestServer[] = [];
const streams: Array<{ close: () => void }> = [];

afterEach(async () => {
	for (const stream of streams.splice(0)) stream.close();
	await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});

function startServer(handler: (request: Request) => Response): string {
	const server = Bun.serve({ port: 0, fetch: handler });
	servers.push(server);
	if (server.port === undefined)
		throw new Error("test server is not listening");
	return `http://127.0.0.1:${server.port}/tenants/tenant-1/sync`;
}

const schema: ContentSchema = {
	content_type: "post",
	version: 1,
	fields: [{ name: "title", kind: "string", required: true }],
};

test("retrieves current and exact schemas with Bearer authentication", async () => {
	const requests: Array<{ path: string; authorization: string | null }> = [];
	const syncUrl = startServer((request) => {
		const path = new URL(request.url).pathname;
		requests.push({
			path,
			authorization: request.headers.get("authorization"),
		});
		if (path.endsWith("/schemas")) return Response.json([schema]);
		if (path.endsWith("/schemas/post/1")) return Response.json(schema);
		return new Response("missing", { status: 404 });
	});

	expect(await fetchSyncSchemas(syncUrl, { apiKey: "read-key" })).toEqual([
		schema,
	]);
	expect(
		await fetchSyncSchemaVersion(syncUrl, "post", 1, { apiKey: "read-key" }),
	).toEqual(schema);
	expect(requests).toEqual([
		{
			path: "/tenants/tenant-1/sync/schemas",
			authorization: "Bearer read-key",
		},
		{
			path: "/tenants/tenant-1/sync/schemas/post/1",
			authorization: "Bearer read-key",
		},
	]);
});

test("validates an exact generated schema before delivering typed content", async () => {
	const completed = Promise.withResolvers<string>();
	const syncUrl = startServer((request) => {
		const path = new URL(request.url).pathname;
		if (path.endsWith("/schemas/post/1")) return Response.json(schema);
		if (path.endsWith("/sync")) {
			const body = [
				'event: change\nid: 1\ndata: {"type":"content","content_type":"post","id":"a","seq":1,"schema_version":1,"data":{"title":"typed"}}\n\n',
				'event: sync-complete\ndata: "cursor-1"\n\n',
			].join("");
			return new Response(body, {
				headers: { "content-type": "text/event-stream" },
			});
		}
		return new Response("missing", { status: 404 });
	});

	interface GeneratedSchemas {
		post: { 1: { title: string } };
	}
	const generatedSchemaVersions = {
		post: [1],
	} as const satisfies SchemaVersionIndex<GeneratedSchemas>;
	const _mismatchedSchemaVersions = {
		// @ts-expect-error generated v1 payload types cannot claim schema version 2
		post: [2],
	} as const satisfies SchemaVersionIndex<GeneratedSchemas>;
	const items: string[] = [];
	const stream = openTypedSyncStream<GeneratedSchemas>(
		syncUrl,
		{
			onChange: (item) => {
				if (item.type === "content") items.push(item.data.title);
			},
			onComplete: completed.resolve,
		},
		{ apiKey: "read-key", schemaVersions: generatedSchemaVersions },
	);
	streams.push(stream);

	expect(await completed.promise).toBe("cursor-1");
	expect(items).toEqual(["typed"]);
	expect(stream.closed).toBe(true);
});

test("generated schema modules preserve literal select values and optionality", () => {
	const output = generateSchemaTypes([
		{
			content_type: "post",
			version: 3,
			fields: [
				{
					name: "status",
					kind: "select",
					options: ["draft", "live"],
					required: true,
				},
				{ name: "tags", kind: "select", options: ["a", "b"], multiple: true },
			],
		},
	]);

	expect(output).toContain('"status": "draft" | "live";');
	expect(output).toContain('"tags"?: ("a" | "b")[] | null;');
	expect(output).toContain('"post": [\n\t\t3\n\t]');
});

test("generated schema module typechecks against its generic version index", async () => {
	const output = generateSchemaTypes([schema]);
	const outputPath = join(tmpdir(), `moltcms-schema-${crypto.randomUUID()}.ts`);
	await Bun.write(outputPath, output);
	try {
		const program = ts.createProgram([outputPath], {
			baseUrl: process.cwd(),
			module: ts.ModuleKind.NodeNext,
			moduleResolution: ts.ModuleResolutionKind.NodeNext,
			noEmit: true,
			paths: { "@moltcms-sdk/client": ["src/index.ts"] },
			skipLibCheck: true,
			strict: true,
			target: ts.ScriptTarget.ES2022,
		});
		const diagnostics = ts.getPreEmitDiagnostics(program);
		expect(
			diagnostics.map((diagnostic) =>
				ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
			),
		).toEqual([]);
	} finally {
		await unlink(outputPath);
	}
});
