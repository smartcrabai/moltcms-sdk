import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
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
	const dir = await mkdtemp(join(tmpdir(), "moltcms-schema-"));
	const outputPath = join(dir, "schema.ts");
	try {
		await writeFile(outputPath, output);
		const tscPath = fileURLToPath(
			new URL("bin/tsc", import.meta.resolve("typescript/package.json")),
		);
		await writeFile(
			join(dir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					module: "NodeNext",
					moduleResolution: "NodeNext",
					noEmit: true,
					paths: {
						"@moltcms-sdk/client": [
							join(relative(dir, process.cwd()), "src/index.ts").replace(
								/\\/g,
								"/",
							),
						],
					},
					skipLibCheck: true,
					strict: true,
					target: "ES2024",
				},
				include: ["schema.ts"],
			}),
		);
		const proc = Bun.spawn({
			cmd: [tscPath, "--project", join(dir, "tsconfig.json")],
			stderr: "pipe",
			stdout: "pipe",
		});
		const [stdout, stderr] = await Promise.all(
			[proc.stdout, proc.stderr].map(async (n) => n.text()),
		);
		const exitCode = await proc.exited;
		expect(exitCode).toBe(0);
		expect(stdout).toBe("");
		expect(stderr).toBe("");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
