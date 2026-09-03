// The MEI machine-check: well-formed XML AND valid against the pinned MEI
// schema, via libxml2's RelaxNG validator (the WebAssembly build vendored
// under scripts/vendor/libxml2-wasm). Nothing has to be installed on the
// machine running the check; the library loads on first use.
//
// Shared by the campaign coordinator, which applies the check to a
// submission, and by the test that holds the generated MEI to the same
// standard.

import { DOCTYPE_REJECTION, checkMeiAgainst, hasDoctype, meiValidatorLoader } from '../src/lib/mei-schema.ts';
import type { MeiCheck } from '../src/lib/mei-schema.ts';

/** The library and the compiled schema; throws when the schema cannot be obtained. */
export const loadMeiValidator = meiValidatorLoader(() => import('./vendor/libxml2-wasm/index.mjs'));

/**
 * Check MEI text against the pinned schema. A schema or library problem
 * throws — an unrunnable check is a broken environment, not invalid content.
 */
export async function validateMei(content: string): Promise<MeiCheck> {
	if (hasDoctype(content)) return DOCTYPE_REJECTION;
	const check = checkMeiAgainst(await loadMeiValidator(), content);
	if (!check.ok) console.warn(`MEI machine-check failed: ${check.error}`);
	return check;
}
