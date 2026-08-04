// The forge abstraction: the interface the instigation SPA codes against, so a
// second provider (GitLab, …) is a drop-in — selection happens in index.ts,
// per-deployment values in config.ts. The GitHub implementation is github.ts,
// built over the REST calls in github-rest.ts.

import type {
	FileChange,
	GitHubUser,
	RepoData,
	RepoSummary,
	RepoRef,
	WorkflowRunInfo,
	WorkflowJobInfo
} from './github-rest.ts';

export type { FileChange, GitHubUser, RepoData, RepoSummary, RepoRef, WorkflowRunInfo, WorkflowJobInfo };

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
	/** The head commit SHA — identifies the CI run the request triggers. */
	headSha?: string;
}

/** A ChangeRequest whose head branch the client created itself. */
export interface OpenedChangeRequest extends ChangeRequest {
	/** The repo (upstream or the user's fork) and branch the PR's head lives in. */
	head: { owner: string; repo: string; branch: string };
}

/** The forge operations the instigation GUI needs, independent of provider. */
export interface ForgeClient {
	/** The authenticated user + the scopes their token actually holds, or null. */
	getAuthenticatedUser(): Promise<{ user: GitHubUser; scopes: string } | null>;
	/** Resolve a numeric account id to its current login, or null. Memoised. */
	getUserLogin(id: number): Promise<string | null>;
	/** Resolve a numeric repo id to its current owner/name, or null. Memoised. */
	getRepoById(id: number): Promise<RepoRef | null>;
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
	/**
	 * Commit several files in one commit, removing `opts.deletePaths` in the same
	 * one; `opts.baseSha` enables optimistic concurrency. `opts.onUpload` reports
	 * how many of the binary files have been uploaded.
	 */
	commitFiles(
		owner: string,
		repo: string,
		files: FileChange[],
		message: string,
		opts?: {
			baseSha?: string;
			branch?: string;
			deletePaths?: string[];
			onUpload?: (uploaded: number, total: number) => void;
		}
	): Promise<string>;
	/** A repo file's UTF-8 content, or null if absent. */
	getRepoFile(owner: string, repo: string, path: string, ref?: string): Promise<string | null>;

	getRepoFileBytes(owner: string, repo: string, path: string, ref?: string): Promise<Blob | null>;
	/** A temporary direct-download URL for a repo file (tokenised for private repos). */
	getRepoFileDownloadUrl(owner: string, repo: string, path: string, ref?: string): Promise<string | null>;
	/** A repo directory's files mapped to their temporary download URLs, in one request. */
	getDirDownloadUrls(owner: string, repo: string, dir: string, ref?: string): Promise<Record<string, string>>;
	/** The repo's default branch head + whether the user can push. */
	getRepoHead(owner: string, repo: string): Promise<RepoHead>;
	/** The current user's repository access and the repository visibility. */
	getRepoAccess(owner: string, repo: string): Promise<{ isPrivate: boolean; canPush: boolean }>;
	/** A repository's data by owner/name, or null if it doesn't exist. */
	getRepoInfo(owner: string, repo: string): Promise<RepoData | null>;
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
	/** Delete a branch; an already-gone ref counts as success. */
	deleteBranch(owner: string, repo: string, branch: string): Promise<void>;
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
	): Promise<OpenedChangeRequest>;
	/** Trigger a CI run (GitHub: workflow_dispatch) of `workflow` on `ref`. */
	dispatchWorkflow(owner: string, repo: string, workflow: string, ref: string): Promise<void>;
	/** A pull/merge request's current state: 'open' or 'closed'. */
	getPullRequestState(owner: string, repo: string, number: number): Promise<string>;
	/** The most recent comment on a pull/merge request, or null. */
	getLastIssueComment(owner: string, repo: string, number: number): Promise<string | null>;
	/** The authenticated user's notification subscription for a repo, or null if unset. */
	getRepoSubscription(
		owner: string,
		repo: string
	): Promise<{ subscribed: boolean; ignored: boolean } | null>;
	/** Mute all of the repo's notifications (web + email) for the authenticated user. */
	ignoreRepoNotifications(owner: string, repo: string): Promise<void>;
	/** The most recent CI runs of `workflow`, newest first, optionally narrowed by trigger event or head commit. */
	listWorkflowRuns(
		owner: string,
		repo: string,
		workflow: string,
		filter?: { event?: string; headSha?: string }
	): Promise<WorkflowRunInfo[]>;
	/** One CI run by id. */
	getWorkflowRun(owner: string, repo: string, runId: number): Promise<WorkflowRunInfo>;
	/** A CI run's jobs with their steps, in execution order. */
	getWorkflowRunJobs(owner: string, repo: string, runId: number): Promise<WorkflowJobInfo[]>;
}
