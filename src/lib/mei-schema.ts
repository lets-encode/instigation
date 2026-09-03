// The pinned MEI schema and the RelaxNG check against it, shared by the
// campaign automation (scripts/mei-validate.ts) and the console
// (mei-check.ts). Pure functions over the vendored libxml2-wasm library;
// each consumer supplies its own import of the library.

import type { ErrorDetail, RelaxNGValidator, XmlDocument as XmlDocumentType } from '../../scripts/vendor/libxml2-wasm/index.mjs';

/** The libxml2-wasm entry module, as imported by the consumer. */
export type Libxml2 = typeof import('../../scripts/vendor/libxml2-wasm/index.mjs');

// The schema version the campaign template declares in its <?xml-model?>
// processing instruction; the digest pins the bytes it must contain.
export const MEI_SCHEMA_URL = 'https://music-encoding.org/schema/5.1/mei-CMN.rng';
export const MEI_SCHEMA_SHA256 = 'f6440d5eb59c3e903f2a7a64ea26518646186f8449b86096106846a269eb354b';

export interface MeiCheck {
	ok: boolean;
	/** The first validity error, as `<line>: <message>`; '' when the MEI is valid. */
	error: string;
}

/** Download the pinned schema and verify its digest; throws on failure. */
export async function fetchMeiSchema(): Promise<Uint8Array> {
	const response = await fetch(MEI_SCHEMA_URL);
	if (!response.ok) {
		throw new Error(`Could not download the MEI schema: ${response.status} ${response.statusText} (${MEI_SCHEMA_URL})`);
	}
	const schema = new Uint8Array(await response.arrayBuffer());
	const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', schema)))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
	if (digest !== MEI_SCHEMA_SHA256) {
		throw new Error(`MEI schema integrity check failed (expected ${MEI_SCHEMA_SHA256}, received ${digest})`);
	}
	return schema;
}

/** Compile the schema bytes into a validator; compiling takes a few hundred milliseconds. */
export function compileMeiSchema(lib: Libxml2, schema: Uint8Array): RelaxNGValidator {
	// The validator keeps its own copy of the grammar; the parsed schema
	// document is released once compiled.
	const doc = lib.XmlDocument.fromBuffer(schema);
	try {
		return lib.RelaxNGValidator.fromDoc(doc);
	} finally {
		doc.dispose();
	}
}

export interface MeiValidator {
	lib: Libxml2;
	validator: RelaxNGValidator;
}

/**
 * A loader that imports the library and compiles the pinned schema on first
 * use and hands out the same instance afterwards. A failed load is not kept:
 * the next call tries again.
 */
export function meiValidatorLoader(importLib: () => Promise<Libxml2>): () => Promise<MeiValidator> {
	let ready: Promise<MeiValidator> | null = null;
	return () => {
		ready ??= (async () => {
			try {
				const [lib, schema] = await Promise.all([importLib(), fetchMeiSchema()]);
				return { lib, validator: compileMeiSchema(lib, schema) };
			} catch (e) {
				ready = null;
				throw e;
			}
		})();
		return ready;
	};
}

// A DOCTYPE declaration can define external or recursively expanding entities
// (XXE / billion laughs); no MEI score legitimately carries one, so any
// document containing it is rejected before parsing — and before the schema
// is needed at all.
export const hasDoctype = (content: string): boolean => /<!DOCTYPE/i.test(content);
export const DOCTYPE_REJECTION: MeiCheck = {
	ok: false,
	error: 'the document contains a DOCTYPE declaration, which is not accepted'
};

// libxml2 reports every problem it found; the first one names the spot. An
// error without a `details` list is not a report about the document but a
// failure of the library itself, and is rethrown.
function contentError(e: unknown): string {
	const details = (e as { details?: ErrorDetail[] }).details;
	if (!Array.isArray(details) || details.length === 0) throw e;
	return `${details[0].line}: ${details[0].message.trim()}`.slice(0, 300);
}

/**
 * Check MEI text against a compiled schema: well-formedness and validity.
 * Throws when the check itself cannot run.
 */
export function checkMeiAgainst({ lib, validator }: MeiValidator, content: string): MeiCheck {
	if (hasDoctype(content)) return DOCTYPE_REJECTION;
	let doc: XmlDocumentType;
	try {
		// XML_PARSE_NONET: the document must not trigger network fetches
		// (external DTDs or entities); entities are not substituted.
		doc = lib.XmlDocument.fromString(content, { option: lib.ParseOption.XML_PARSE_NONET });
	} catch (e) {
		return { ok: false, error: contentError(e) };
	}
	try {
		validator.validate(doc);
		return { ok: true, error: '' };
	} catch (e) {
		return { ok: false, error: contentError(e) };
	} finally {
		doc.dispose();
	}
}
