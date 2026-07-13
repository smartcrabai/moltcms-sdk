/** The name of a content type within a moltcms tenant. */
export type ContentType = string;

/** A field declaration in a content schema. */
export type FieldType =
	| { kind: "string"; max_len?: number | null }
	| { kind: "text" }
	| { kind: "richtext" }
	| {
			kind: "number";
			integer?: boolean;
			min?: number | null;
			max?: number | null;
	  }
	| { kind: "boolean" }
	| { kind: "datetime" }
	| { kind: "image"; multiple?: boolean }
	| { kind: "relation"; multiple?: boolean; target: ContentType }
	| { kind: "select"; multiple?: boolean; options: string[] }
	| { kind: "json" };

/** A named field in a content schema. */
export type FieldDef = FieldType & {
	name: string;
	required?: boolean;
};

/** A complete, immutable version of one content type's schema. */
export interface ContentSchema {
	content_type: ContentType;
	version: number;
	fields: FieldDef[];
}

/** The current state of a content entity. */
export interface ContentChange {
	type: "content";
	content_type: ContentType;
	id: string;
	seq: number;
	schema_version: number;
	/** Field values are defined by the content type's schema. */
	data: Record<string, unknown>;
}

/** A content entity that must be removed from a local projection. */
export interface ContentDeleted {
	type: "content_deleted";
	content_type: ContentType;
	id: string;
	seq: number;
}

/** A versioned content-schema definition. */
export interface SchemaChanged {
	type: "schema_changed";
	content_type: ContentType;
	seq: number;
	version: number;
	fields: FieldDef[];
}

/** One item sent in a `change` event on the sync feed. */
export type DeliveryItem = ContentChange | ContentDeleted | SchemaChanged;
