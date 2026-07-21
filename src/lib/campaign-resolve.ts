// Resolve a campaign URL (which carries only the campaign NAME) to the repo it
// addresses, and register/look up names in the slug registry (redirector).
//
// The registry (see redirector/) is the authoritative — and sole — name →
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
	status: 'free' | 'active' | 'reserved' | 'tombstoned';
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

/** The outcome of registering a name against a repo id. */
export type RegisterResult = 'ok' | 'conflict' | 'invalid' | 'error';

/**
 * Register a campaign name against its repo id on `forge`, after the repo has
 * been created. Idempotent for the same (forge, repo id). 'conflict' means the
 * name is taken by a different repo; 'invalid' means it isn't a valid slug.
 */
export async function registerCampaign(
	name: string,
	repoId: number,
	forge: string
): Promise<RegisterResult> {
	try {
		const res = await fetch(`${registryUrl}/register`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name, repo_id: repoId, forge })
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
 * Resolve a campaign name to its repo via the registry (name → stable repo id →
 * current owner/name). Returns null when no campaign of that name can be found —
 * including when the registry is unreachable.
 */
export async function resolveCampaign(
	f: ForgeClient,
	campaign: string
): Promise<ResolvedCampaign | null> {
	const info = await lookupSlug(campaign);
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
