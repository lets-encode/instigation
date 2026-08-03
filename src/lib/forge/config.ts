// Per-deployment forge configuration, read from public (client-visible) env.
// Everything here is non-secret: OAuth credentials and the user's token live
// only in the broker. Values intrinsic to a provider (e.g. api.github.com)
// live in that provider's module, not here.

import { env } from '$env/dynamic/public';

export interface ProviderConfig {
	/** Which ForgeClient implementation to use (see forge/index.ts). */
	id: string;
	/**
	 * The session broker, as a same-origin path (it must share the SPA's
	 * origin so its session cookie is first-party). It runs the OAuth flow,
	 * holds the user's token server-side, and proxies authenticated API calls.
	 */
	brokerUrl: string;
	/** The campaign template this deployment stamps new repos from. */
	template: { owner: string; repo: string };
	/** Topic stamped on created repos, used to build the listing. */
	repoTopic: string;
}

export const provider: ProviderConfig = {
	id: env.PUBLIC_FORGE || 'github',
	brokerUrl: env.PUBLIC_BROKER_URL || '/auth',
	template: {
		owner: env.PUBLIC_TEMPLATE_OWNER || '',
		repo: env.PUBLIC_TEMPLATE_REPO || ''
	},
	repoTopic: env.PUBLIC_REPO_TOPIC || 'created-with-instigation'
};

/**
 * The slug registry's mount, as a same-origin path so its calls need no CORS.
 * The registry is part of the session broker (see broker/registry.py); the
 * production reverse proxy (deploy/apache.conf) and the Vite dev proxy pass this
 * path through to it unchanged. It owns
 * the campaign name → repo id mapping: the app resolves a campaign URL through
 * it and registers a new name against its GitHub repo id after creating the
 * repo.
 */
export const registryUrl = env.PUBLIC_REGISTRY_URL || '/registry';

/** The mei-friend instance volunteers are handed off to for editing. */
export const meiFriendUrl = env.PUBLIC_MEI_FRIEND_URL || 'https://mei-friend.mdw.ac.at';

/** The edirom measure-detector used to scaffold a score from page images. */
export const measureDetectorUrl =
	env.PUBLIC_MEASURE_DETECTOR_URL || 'https://measure-detector.edirom.de';

/**
 * The central automation pointer written into each new campaign's config.yaml
 * (DESIGN.md §4a). The campaign's caller workflow checks out `central_repository`
 * at `ref` and runs `path`. `ref` should be an immutable tag/SHA in production;
 * `main` is for iteration.
 */
export const automation = {
	central_repository: env.PUBLIC_AUTOMATION_REPO || 'lets-encode/instigation',
	ref: env.PUBLIC_AUTOMATION_REF || 'main',
	path: env.PUBLIC_AUTOMATION_PATH || 'scripts/coordinator.ts'
};
