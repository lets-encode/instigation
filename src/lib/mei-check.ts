// Browser-side MEI schema check: the same validator and schema the campaign
// automation applies to a submission, run before a pull request is opened so
// a score that would fail the machine-check is refused at once. The
// automation's check stays authoritative. The library (1 MB) and the schema
// (1.3 MB) load on first use only.

import { DOCTYPE_REJECTION, checkMeiAgainst, hasDoctype, meiValidatorLoader } from './mei-schema.ts';

const loadMeiValidator = meiValidatorLoader(() => import('../../scripts/vendor/libxml2-wasm/index.mjs'));

/**
 * Why `content` fails the MEI schema check, or null when it passes — or when
 * the check cannot run (library or schema unavailable), in which case the
 * submission proceeds and the automation's check decides.
 */
export async function checkMei(content: string): Promise<string | null> {
	if (hasDoctype(content)) return DOCTYPE_REJECTION.error;
	try {
		const check = checkMeiAgainst(await loadMeiValidator(), content);
		return check.ok ? null : check.error;
	} catch (e) {
		console.warn('[mei-check] unavailable, leaving the check to the automation:', (e as Error).message);
		return null;
	}
}
