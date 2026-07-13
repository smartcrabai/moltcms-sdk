import {
	fetchSyncSchemaVersion,
	type SyncSchemaRequestOptions,
} from "./schema-client.js";
import {
	openSyncStream,
	type SyncStream,
	type SyncStreamOptions,
} from "./sync-stream.js";
import type {
	ContentChange,
	ContentDeleted,
	ContentSchema,
	DeliveryItem,
	FieldDef,
	SchemaChanged,
} from "./types.js";

/**
 * A generated mapping from content-type literals to exact schema-version data
 * shapes. It intentionally has no string index signature so TypeScript keeps
 * each generated content type as a discriminant.
 */
export type SchemaTypeMap = object;

/** Runtime counterpart of generated schema versions, coupled to `S`. */
export type SchemaVersionIndex<S extends SchemaTypeMap> = {
	readonly [ContentType in keyof S & string]: readonly (keyof S[ContentType] &
		number)[];
};

type TypedContentChange<S extends SchemaTypeMap> = {
	[C in keyof S & string]: {
		[V in keyof S[C] & number]: Omit<
			ContentChange,
			"content_type" | "schema_version" | "data"
		> & {
			content_type: C;
			schema_version: V;
			data: S[C][V];
		};
	}[keyof S[C] & number];
}[keyof S & string];

type TypedContentDeleted<S extends SchemaTypeMap> = Omit<
	ContentDeleted,
	"content_type"
> & {
	content_type: keyof S & string;
};

/** A sync item narrowed to the content types and schema versions generated for `S`. */
export type TypedDeliveryItem<S extends SchemaTypeMap> =
	| TypedContentChange<S>
	| TypedContentDeleted<S>
	| SchemaChanged;

export interface TypedSyncStreamHandlers<S extends SchemaTypeMap> {
	/** A validated item whose content data has the exact generated schema type. */
	onChange: (item: TypedDeliveryItem<S>, seq: string) => void | Promise<void>;
	onComplete?: (cursor: string) => void | Promise<void>;
	onError?: (message: string) => void | Promise<void>;
	onTransportError?: (error: unknown) => void | Promise<void>;
}

export interface TypedSyncStreamOptions<S extends SchemaTypeMap>
	extends SyncStreamOptions {
	/** Versions emitted by the generated schema module. Unknown versions are rejected. */
	schemaVersions: SchemaVersionIndex<S>;
}

/** A schema version was not present in the generated type module. */
export class UnknownGeneratedSchemaVersionError extends Error {
	constructor(contentType: string, version: number) {
		super(
			`No generated schema exists for content type ${contentType} version ${version}`,
		);
		this.name = "UnknownGeneratedSchemaVersionError";
	}
}

/** A received content item did not conform to its exact moltcms schema version. */
export class SyncItemValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SyncItemValidationError";
	}
}

/**
 * Opens a schema-validated sync stream.
 *
 * This function fetches and caches the exact `(content_type, schema_version)`
 * definition for each content item. The generated `schemaVersions` index is
 * checked first, so an item written against a version absent from generated
 * TypeScript types fails closed instead of being cast to the latest schema.
 */
export function openTypedSyncStream<S extends SchemaTypeMap>(
	syncUrl: string,
	handlers: TypedSyncStreamHandlers<S>,
	options: TypedSyncStreamOptions<S>,
): SyncStream {
	const schemas = new Map<string, Promise<ContentSchema>>();
	const runtimeSchemaVersions = options.schemaVersions as Record<
		string,
		readonly number[]
	>;
	const schemaOptions: SyncSchemaRequestOptions = {
		apiKey: options.apiKey,
		fetch: options.fetch,
		signal: options.signal,
	};

	return openSyncStream<DeliveryItem>(
		syncUrl,
		{
			onChange: async (item, seq) => {
				if (item.type === "content") {
					const schema = await schemaFor(
						item.content_type,
						item.schema_version,
					);
					validateContentItem(item, schema);
				}
				await handlers.onChange(item as TypedDeliveryItem<S>, seq);
			},
			onComplete: handlers.onComplete,
			onError: handlers.onError,
			onTransportError: handlers.onTransportError,
		},
		options,
	);

	function schemaFor(
		contentType: string,
		version: number,
	): Promise<ContentSchema> {
		if (!runtimeSchemaVersions[contentType]?.includes(version)) {
			throw new UnknownGeneratedSchemaVersionError(contentType, version);
		}
		const key = `${contentType}\u0000${version}`;
		let schema = schemas.get(key);
		if (schema === undefined) {
			schema = fetchSyncSchemaVersion(
				syncUrl,
				contentType,
				version,
				schemaOptions,
			);
			schemas.set(key, schema);
		}
		return schema;
	}
}

function validateContentItem(item: ContentChange, schema: ContentSchema): void {
	if (
		schema.content_type !== item.content_type ||
		schema.version !== item.schema_version
	) {
		throw new SyncItemValidationError(
			`Schema response does not match ${item.content_type} version ${item.schema_version}`,
		);
	}
	const fields = new Map(schema.fields.map((field) => [field.name, field]));
	for (const name of Object.keys(item.data)) {
		if (!fields.has(name)) {
			throw new SyncItemValidationError(
				`Unknown field ${name} in ${item.content_type}`,
			);
		}
	}
	for (const field of schema.fields)
		validateField(item.data[field.name], field);
}

function validateField(value: unknown, field: FieldDef): void {
	if (value === undefined || value === null) {
		if (field.required) {
			throw new SyncItemValidationError(
				`Required field ${field.name} is missing`,
			);
		}
		return;
	}

	const invalid = (): never => {
		throw new SyncItemValidationError(
			`Field ${field.name} has an invalid value`,
		);
	};
	switch (field.kind) {
		case "string": {
			if (typeof value !== "string") invalid();
			const stringValue = value as string;
			const maxLength = "max_len" in field ? field.max_len : undefined;
			if (
				maxLength !== undefined &&
				maxLength !== null &&
				stringValue.length > maxLength
			) {
				invalid();
			}
			break;
		}
		case "text":
		case "datetime":
			if (typeof value !== "string") invalid();
			break;
		case "number": {
			if (typeof value !== "number" || !Number.isFinite(value)) invalid();
			const numberValue = value as number;
			const minimum = "min" in field ? field.min : undefined;
			const maximum = "max" in field ? field.max : undefined;
			if (minimum !== undefined && minimum !== null && numberValue < minimum)
				invalid();
			if (maximum !== undefined && maximum !== null && numberValue > maximum)
				invalid();
			if (field.integer && !Number.isInteger(numberValue)) invalid();
			break;
		}
		case "boolean":
			if (typeof value !== "boolean") invalid();
			break;
		case "image":
		case "relation": {
			const multiple = "multiple" in field && field.multiple === true;
			if (multiple) {
				if (
					!Array.isArray(value) ||
					value.some((item) => typeof item !== "string")
				) {
					invalid();
				}
			} else if (typeof value !== "string") {
				invalid();
			}
			break;
		}
		case "select": {
			const multiple = "multiple" in field && field.multiple === true;
			const options = "options" in field ? field.options : [];
			const selected = multiple ? value : [value];
			if (
				!Array.isArray(selected) ||
				selected.some(
					(option) => typeof option !== "string" || !options.includes(option),
				)
			) {
				invalid();
			}
			break;
		}
		case "richtext":
		case "json":
			break;
	}
}
