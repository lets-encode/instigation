// Entry point for the forge abstraction. `createForge(token)` returns the
// ForgeClient implementation selected by the configured provider, so the rest of
// the app never depends on a specific forge.

import type { ForgeClient } from './types.ts';
import { createGitHubForge } from './github.ts';
import { provider } from './config.ts';

export function createForge(token: string): ForgeClient {
	switch (provider.id) {
		case 'github':
			return createGitHubForge(token);
		default:
			throw new Error(`Unsupported forge provider: ${provider.id}`);
	}
}

export { provider } from './config.ts';
export type { ForgeClient, RepoHead, ChangeRequest, FileChange, GitHubUser, RepoData, RepoSummary } from './types.ts';
