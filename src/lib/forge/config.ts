// Per-deployment forge configuration, read from public (client-visible) env.
// Everything here is non-secret: the OAuth client_id is public, and the client
// secret lives only in the token broker. Values intrinsic to a provider (e.g.
// api.github.com) live in that provider's module, not here.

import { env } from '$env/dynamic/public';

export interface ProviderConfig {
	/** Which ForgeClient implementation to use (see forge/index.ts). */
	id: string;
	/** OAuth client id (public). */
	clientId: string;
	/** OAuth scope requested at login. */
	scope: string;
	/** The provider's OAuth authorize endpoint. */
	authorizeUrl: string;
	/** Stateless token broker that swaps an OAuth code for an access token. */
	brokerUrl: string;
	/** The campaign template this deployment stamps new repos from. */
	template: { owner: string; repo: string };
	/** Topic stamped on created repos, used to build the listing. */
	repoTopic: string;
}

export const provider: ProviderConfig = {
	id: env.PUBLIC_FORGE || 'github',
	clientId: env.PUBLIC_GITHUB_CLIENT_ID || '',
	scope: 'repo',
	authorizeUrl: 'https://github.com/login/oauth/authorize',
	brokerUrl: env.PUBLIC_OAUTH_BROKER_URL || '',
	template: {
		owner: env.PUBLIC_TEMPLATE_OWNER || '',
		repo: env.PUBLIC_TEMPLATE_REPO || ''
	},
	repoTopic: env.PUBLIC_REPO_TOPIC || 'created-with-instigation'
};

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
