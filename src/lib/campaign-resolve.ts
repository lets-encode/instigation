// Resolve a campaign URL (which carries only the campaign NAME) to the repo it
// addresses, and register/look up names in the slug registry.
//
// The registry (see broker/registry.py) is the authoritative — and sole — name →
// repo-id map: the repo id is stable across renames/transfers, so resolving a
// name to its id and then to the repo's current owner/name (getRepoById)
// survives a rename that a bare name→search never could. The registry is reached
// same-origin via the PUBLIC_REGISTRY_URL mount, so no CORS is involved. A
// registry miss (no entry, or the registry unreachable) is a genuine "not
// found" — there is no name-search fallback.

import { provider, registryUrl } from './forge/config.ts';
import type { ForgeClient } from './forge/types.ts';

/** A campaign name resolved to its repo's stable id and current owner/name. */
export interface ResolvedCampaign {
	repoId: number;
	owner: string;
	repo: string;
}

/** A slug's state in the registry. */
export interface SlugInfo {
	name: string;
	status: 'free' | 'pending' | 'active' | 'reserved' | 'tombstoned';
	/** Which forge repo_id belongs to (e.g. 'github'); null unless active. */
	forge: string | null;
	repo_id: number | null;
}

/** Look up a name in the registry, or null if it can't be reached / is malformed. */
export async function lookupSlug(name: string): Promise<SlugInfo | null> {
	try {
		const res = await fetch(`${registryUrl}/api/slug/${encodeURIComponent(name)}`, {
			headers: { Accept: 'application/json' },
			cache: 'no-store'
		});
		if (!res.ok) return null; // 400 malformed, or the registry is down
		return (await res.json()) as SlugInfo;
	} catch {
		return null;
	}
}

/** A held name's token, or why the name could not be held. */
export type ClaimResult = { token: string } | { error: 'taken' | 'invalid' | 'unreachable' };

/**
 * Hold a name in the registry before the repo it will belong to exists, so the
 * rest of a campaign's setup cannot lose it. The token is the right to register
 * the name later, or to give it back; the hold itself runs out (see the
 * registry's CLAIM_TTL_MINUTES), which only means someone else may take the name
 * from then on — the token keeps working until they do.
 */
export async function claimName(name: string): Promise<ClaimResult> {
	try {
		const res = await fetch(`${registryUrl}/claim`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name })
		});
		if (res.ok) return { token: ((await res.json()) as { claim_token: string }).claim_token };
		if (res.status === 409) return { error: 'taken' };
		if (res.status === 422) return { error: 'invalid' };
		return { error: 'unreachable' };
	} catch {
		return { error: 'unreachable' };
	}
}

/**
 * Give a held name back, so a campaign renamed before its repo exists does not
 * leave its first name held. Best-effort: false means the name stays held until
 * the registry's hold runs out, which frees it without anyone acting.
 */
export async function releaseClaim(name: string, token: string): Promise<boolean> {
	try {
		const res = await fetch(`${registryUrl}/claim/${encodeURIComponent(name)}`, {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ claim_token: token })
		});
		return res.ok;
	} catch {
		return false;
	}
}

/** The outcome of registering a name against a repo id. */
export type RegisterResult = 'ok' | 'conflict' | 'invalid' | 'error';

/**
 * Register a campaign name against its repo id on `forge`, after the repo has
 * been created, presenting the token the name was held under. Idempotent for the
 * same (forge, repo id). 'conflict' means the name now belongs to a different
 * repo; 'invalid' means it isn't a valid slug.
 */
export async function registerCampaign(
	name: string,
	repoId: number,
	forge: string,
	claimToken: string
): Promise<RegisterResult> {
	try {
		const res = await fetch(`${registryUrl}/register`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name, repo_id: repoId, forge, claim_token: claimToken })
		});
		if (res.ok) return 'ok';
		if (res.status === 409) return 'conflict';
		if (res.status === 422) return 'invalid';
		return 'error';
	} catch {
		return 'error';
	}
}

/**
 * Message for a resolution that FAILED (resolveCampaign threw — the forge
 * request errored, e.g. the API rate limit) as opposed to a genuine miss
 * (resolveCampaign returned null). A failed resolution must never be presented
 * as "campaign not found".
 */
export function resolveFailureMessage(e: unknown): string {
	const msg = e instanceof Error ? e.message : String(e);
	return /rate limit/i.test(msg)
		? "GitHub's request limit was reached, so the campaign could not be loaded. Try again later, or log in for a higher limit."
		: `The campaign could not be loaded: ${msg}`;
}

/**
 * Resolve a campaign name to its repo via the registry (name → stable repo id →
 * current owner/name). Returns null when no campaign of that name can be found —
 * including when the registry is unreachable. Throws when the forge lookup of
 * the registry's repo id fails (getRepoById) — a failure, not a miss. A caller
 * that has already looked the name up passes its `SlugInfo` to save the second
 * registry round trip.
 */
export async function resolveCampaign(
	f: ForgeClient,
	campaign: string,
	info?: SlugInfo | null
): Promise<ResolvedCampaign | null> {
	if (info === undefined) info = await lookupSlug(campaign);
	// Only resolve a registry hit whose forge matches this deployment's — a repo
	// id is only meaningful on its own forge, so a foreign-forge entry is not
	// reachable here (and its id must never be fed to this forge's client). The
	// registry is the sole source of truth: a miss (no entry, or the registry is
	// unreachable) is a genuine "not found", never a silent name-search fallback.
	if (
		info?.status === 'active' &&
		info.repo_id != null &&
		(info.forge ?? provider.id) === provider.id
	) {
		const ref = await f.getRepoById(info.repo_id);
		if (ref) return { repoId: ref.id, owner: ref.owner, repo: ref.repo };
	}
	return null;
}
