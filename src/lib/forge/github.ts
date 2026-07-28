// GitHub implementation of ForgeClient: binds the user's token to the REST calls
// in github-rest.ts. Provider selection happens in index.ts.

import * as gh from './github-rest.ts';
import type { ForgeClient } from './types.ts';

export function createGitHubForge(token: string): ForgeClient {
	return {
		getAuthenticatedUser: () => gh.getAuthenticatedUser(token),
		getUserLogin: (id) => gh.getUserLogin(token, id),
		getRepoById: (id) => gh.getRepoById(token, id),
		searchReposByTopic: (topic) => gh.searchReposByTopic(topic, token),
		createRepoFromTemplate: (opts) => gh.createRepoFromTemplate(token, opts),
		setRepoTopics: async (owner, repo, names) => {
			await gh.setRepoTopics(token, owner, repo, names);
		},
		setActionsWorkflowPermissions: (owner, repo) => gh.setActionsWorkflowPermissions(token, owner, repo),
		waitForRepoContents: (owner, repo, path, opts) => gh.waitForRepoContents(token, owner, repo, path, opts),
		commitFiles: (owner, repo, files, message, opts) => gh.commitFiles(token, owner, repo, files, message, opts),
		getRepoFile: (owner, repo, path, ref) => gh.getRepoFile(token, owner, repo, path, ref),
		getRepoFileBytes: (owner, repo, path, ref) => gh.getRepoFileBytes(token, owner, repo, path, ref),
		getRepoFileDownloadUrl: (owner, repo, path, ref) => gh.getRepoFileDownloadUrl(token, owner, repo, path, ref),
		getDirDownloadUrls: (owner, repo, dir, ref) => gh.getDirDownloadUrls(token, owner, repo, dir, ref),
		getRepoHead: (owner, repo) => gh.getRepoHead(token, owner, repo),
		getRepoAccess: (owner, repo) => gh.getRepoAccess(token, owner, repo),
		ensureFork: (owner, repo, opts) => gh.ensureFork(token, owner, repo, opts),
		createBranch: (owner, repo, branch, fromSha) => gh.createBranch(token, owner, repo, branch, fromSha),
		fastForwardBranch: (owner, repo, branch, sha) => gh.fastForwardBranch(token, owner, repo, branch, sha),
		deleteBranch: (owner, repo, branch) => gh.deleteBranch(token, owner, repo, branch),
		createPullRequest: (owner, repo, opts) => gh.createPullRequest(token, owner, repo, opts),
		openChangePr: (owner, repo, opts) => gh.openChangePr(token, owner, repo, opts),
		dispatchWorkflow: (owner, repo, workflow, ref) => gh.dispatchWorkflow(token, owner, repo, workflow, ref),
		getPullRequestState: (owner, repo, number) => gh.getPullRequestState(token, owner, repo, number),
		getLastIssueComment: (owner, repo, number) => gh.getLastIssueComment(token, owner, repo, number),
		getLatestWorkflowRun: (owner, repo, workflow, event) => gh.getLatestWorkflowRun(token, owner, repo, workflow, event),
		getRepoSubscription: (owner, repo) => gh.getRepoSubscription(token, owner, repo),
		ignoreRepoNotifications: (owner, repo) => gh.ignoreRepoNotifications(token, owner, repo)
	};
}
