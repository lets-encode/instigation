// The MEI machine-check: well-formed XML AND valid against the pinned MEI
// schema, via xmllint --relaxng (which implies the well-formedness check).
//
// Node-only (child process, filesystem), unlike the pure modules in src/lib.
// Shared by the campaign coordinator, which applies the check to a submission,
// and by the test that holds the generated MEI to the same standard.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// The schema version the campaign template declares in its <?xml-model?>
// processing instruction. A copy is vendored at schema/mei-CMN.rng; the digest
// pins the bytes it must contain.
export const MEI_SCHEMA_URL = 'https://music-encoding.org/schema/5.0/mei-CMN.rng';
export const MEI_SCHEMA_SHA256 = 'fa2081b4e0c858e1dcde339b1b733b8e6350212a46c0db50b94cc71bbe68ca4c';

/**
 * Return the local path of the vendored schema. Verified once per process; a
 * missing file or a digest mismatch throws rather than letting content
 * through unchecked.
 */
let schemaPath: string | null = null;
export async function meiSchemaPath(): Promise<string> {
	if (schemaPath) return schemaPath;
	const path = fileURLToPath(new URL('../schema/mei-CMN.rng', import.meta.url));
	const schema = await readFile(path);
	const digest = createHash('sha256').update(schema).digest('hex');
	if (digest !== MEI_SCHEMA_SHA256) {
		throw new Error(`MEI schema integrity check failed (expected ${MEI_SCHEMA_SHA256}, received ${digest})`);
	}
	schemaPath = path;
	return path;
}

export interface MeiCheck {
	ok: boolean;
	/** The first validity error, as `<line>: <message>`; '' when the MEI is valid. */
	error: string;
}

// xmllint reports stdin as `-`; the line number is what identifies the spot.
function firstError(stderr: string): string {
	const line = stderr.split('\n').find((l) => l.trim() && !/^-( |:? fails to validate)/.test(l));
	return (line ?? stderr.split('\n')[0] ?? '').replace(/^-:/, '').trim().slice(0, 300);
}

/**
 * Check MEI text against the pinned schema. A schema or xmllint problem throws
 * — an unrunnable check is a broken environment, not invalid content.
 */
export async function validateMei(content: string): Promise<MeiCheck> {
	const path = await meiSchemaPath();
	const r = spawnSync('xmllint', ['--noout', '--relaxng', path, '-'], { input: content });
	if (r.error) throw new Error(`Could not run xmllint for the MEI machine-check: ${r.error.message}`);
	if (r.status === 0) return { ok: true, error: '' };
	const stderr = r.stderr?.toString() ?? '';
	console.warn(`MEI machine-check failed:\n${stderr}`);
	return { ok: false, error: firstError(stderr) };
}
