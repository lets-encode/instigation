// The forge abstraction: the interface the instigation SPA codes against, so a
// second provider (GitLab, …) is a drop-in — selection happens in index.ts,
// per-deployment values in config.ts. The GitHub implementation is github.ts,
// built over the REST calls in github-rest.ts.

import type { FileChange, GitHubUser, RepoData, RepoSummary } from './github-rest.ts';

export type { FileChange, GitHubUser, RepoData, RepoSummary };

/** A repo's default branch, its head commit SHA, and whether the user can push. */
export interface RepoHead {
	branch: string;
	sha: string;
	canPush: boolean;
}

/** A reference to an opened pull/merge request. */
export interface ChangeRequest {
	number: number;
	html_url: string;
}

/** The forge operations the instigation GUI needs, independent of provider. */
export interface ForgeClient {
	/** The authenticated user + the scopes their token actually holds, or null. */
	getAuthenticatedUser(): Promise<{ user: GitHubUser; scopes: string } | null>;
	/** Repos tagged with `topic` that the user can see. */
	searchReposByTopic(topic: string): Promise<RepoSummary[]>;
	/** Create a repo from a template into `owner`'s account. */
	createRepoFromTemplate(opts: {
		templateOwner: string;
		templateRepo: string;
		name: string;
		description: string;
		isPrivate: boolean;
		owner: string;
	}): Promise<RepoData>;
	/** Replace a repo's topics. */
	setRepoTopics(owner: string, repo: string, names: string[]): Promise<void>;
	/** Give the repo's CI token read/write access. */
	setActionsWorkflowPermissions(owner: string, repo: string): Promise<void>;
	/** Poll until `path` appears in the repo, returning its content. */
	waitForRepoContents(
		owner: string,
		repo: string,
		path: string,
		opts?: { attempts?: number; delayMs?: number }
	): Promise<string>;
	/** Commit several files in one commit; `opts.baseSha` enables optimistic concurrency. */
	commitFiles(
		owner: string,
		repo: string,
		files: FileChange[],
		message: string,
		opts?: { baseSha?: string; branch?: string }
	): Promise<string>;
	/** A repo file's UTF-8 content, or null if absent. */
	getRepoFile(owner: string, repo: string, path: string, ref?: string): Promise<string | null>;
	/** A temporary direct-download URL for a repo file (tokenised for private repos). */
	getRepoFileDownloadUrl(owner: string, repo: string, path: string, ref?: string): Promise<string | null>;
	/** A repo directory's files mapped to their temporary download URLs, in one request. */
	getDirDownloadUrls(owner: string, repo: string, dir: string, ref?: string): Promise<Record<string, string>>;
	/** The repo's default branch head + whether the user can push. */
	getRepoHead(owner: string, repo: string): Promise<RepoHead>;
	/** Whether the repo is private. */
	getRepoIsPrivate(owner: string, repo: string): Promise<boolean>;
	/** Ensure the user has a fork, waiting until it's ready. */
	ensureFork(
		owner: string,
		repo: string,
		opts?: { attempts?: number; delayMs?: number }
	): Promise<{ owner: string; repo: string }>;
	/** Create a branch at `fromSha`. */
	createBranch(owner: string, repo: string, branch: string, fromSha: string): Promise<void>;
	/** Fast-forward an existing branch to `sha`; false if that isn't a fast-forward. */
	fastForwardBranch(owner: string, repo: string, branch: string, sha: string): Promise<boolean>;
	/** Open a pull/merge request. */
	createPullRequest(
		owner: string,
		repo: string,
		opts: { title: string; head: string; base: string; body: string }
	): Promise<ChangeRequest>;
	/** Commit `files` to a fresh branch (in the repo or the user's fork) and open a PR upstream. */
	openChangePr(
		owner: string,
		repo: string,
		opts: { branch: string; files: FileChange[]; message: string; title: string; body: string }
	): Promise<ChangeRequest>;
	/** Trigger a CI run (GitHub: workflow_dispatch) of `workflow` on `ref`. */
	dispatchWorkflow(owner: string, repo: string, workflow: string, ref: string): Promise<void>;
	/** The user's notification subscription for the repo, or null if none set. */
	getRepoSubscription(
		owner: string,
		repo: string
	): Promise<{ subscribed: boolean; ignored: boolean } | null>;
	/** Mute all of the repo's notifications (web + email) for the authenticated user. */
	ignoreRepoNotifications(owner: string, repo: string): Promise<void>;
	/** A pull/merge request's current state: 'open' or 'closed'. */
	getPullRequestState(owner: string, repo: string, number: number): Promise<string>;
	/** The most recent comment on a pull/merge request, or null. */
	getLastIssueComment(owner: string, repo: string, number: number): Promise<string | null>;
	/** The most recent CI run of `workflow` for `event`, or null if none yet. */
	getLatestWorkflowRun(
		owner: string,
		repo: string,
		workflow: string,
		event: string
	): Promise<{ status: string; conclusion: string | null; created_at: string } | null>;
}
