// The console command layer: every user-facing campaign operation is a named,
// versioned command with JSON-serialisable input, run through invoke(). The
// UI is one caller among possible others (an agent can drive the same
// registry), and every MUTATING command fills the command columns of one row
// in the campaign's append-only tracking/history.csv:
//   - log 'pr':     the mutation travels as a pull request; the envelope rides
//                   in the PR body and the campaign automation folds it into
//                   the history row it authors for the event (volunteers
//                   cannot write to the campaign repo).
//   - log 'direct': the command mutates without a PR (requires push access);
//                   invoke() commits the history row itself after the command ran.
//   - log 'none':   reads — not logged.
// Handlers are self-contained: they read the tracking tables themselves rather
// than relying on caller state. See DESIGN.md §5 (history.csv) & §6.

import type { ForgeClient } from './forge/types.ts';
import {
	parseTaskCsv,
	parseStateCsv,
	parseLockCsv,
	parseHistoryCsv,
	parseCommentCsv,
	serializeStateCsv,
	serializeLockCsv,
	serializeCommentCsv,
	serializeTaskCsv,
	appendComments,
	appendHistory,
	findRow,
	isFinalValidation,
	configString,
	passThresholdOf,
	configFlag,
	configPieces,
	resolveLogins
} from './campaign-tables.ts';
import { checkPlan } from './campaign-plan.ts';
import { resetTaskRows, resolveCommentThread } from './campaign-submit.ts';
import { sendBackTarget } from './campaign-graph.ts';
import type { TaskRow, StateRow, LockRow, HistoryRow, CommentRow, PieceRef } from './campaign-tables.ts';
import { appendEnvelopeToPrBody, envelopeColumns } from './command-envelope.ts';
import type { CommandEnvelope } from './command-envelope.ts';
import { parseFacsimileMei, buildFacsimileMei, buildBlankScoreMei } from './mei-facsimile.ts';
import type { PageModel, ParsedFacsimile, ScoreDefModel } from './mei-facsimile.ts';
import { pieceKindForPath } from './coordinator-policy.ts';
import { resolveFacsimileImageUrls } from './facsimile-images.ts';
import { WorkflowRunWatch } from './run-watch.ts';
import type { ProgressUpdate } from './run-watch.ts';

const TASK_PATH = 'tracking/task.csv';
const STATE_PATH = 'tracking/state.csv';
const LOCK_PATH = 'tracking/lock.csv';
const HISTORY_PATH = 'tracking/history.csv';
const COMMENT_PATH = 'tracking/comment.csv';
const MAX_LOG_ATTEMPTS = 3;
const DEFAULT_MEI_FRIEND_URL = 'https://mei-friend.mdw.ac.at';

/** What a command invocation is run against: the campaign, the user, the forge. */
export interface CommandContext {
	forge: ForgeClient;
	/** The campaign repo's numeric id — the canonical, rename-stable reference. */
	repoId: number;
	/** The repo id's current owner/name, resolved for the GitHub API paths. */
	owner: string;
	repo: string;
	/** The acting user's numeric account id — written to the tracking tables. */
	viewer: string;
	/** The acting user's login — for human-readable PR prose only, never as an id. */
	viewerLogin: string;
	/** Editor instance used for the mei-friend hand-off. */
	meiFriendUrl?: string;
	/**
	 * Progress for a busy indicator: `step` opens a new stage, `detail` says
	 * which part of the running stage is being worked on. Pass a no-op when
	 * headless.
	 */
	progress: (update: ProgressUpdate) => void;
}

/** The result banner a command resolves to (never rejects). */
export type Result = {
	ok?: boolean;
	/** The command finished in the background: the runner holds no overlay and
	 * the PR + verdict are followed through the verdict sink on the task. */
	background?: boolean;
	warn?: boolean;
	error?: string;
	message?: string;
	prUrl?: string;
	meiFriendUrl?: string;
};

interface CommandDef<I, O> {
	id: string;
	version: number;
	log: 'pr' | 'direct' | 'none';
	/** What of the input goes into the envelope; defaults to the input itself. Use to keep bulky payloads (already carried by the PR diff) out of the log. */
	envelopeInput?: (input: I) => Record<string, unknown>;
	run: (input: I, ctx: CommandContext, envelope: CommandEnvelope | null) => Promise<O>;
}

/**
 * Run a command: build its envelope, execute it, and (for 'direct' commands)
 * append the invocation to the campaign's command log.
 */
export async function invoke<I extends Record<string, unknown>, O>(
	def: CommandDef<I, O>,
	input: I,
	ctx: CommandContext
): Promise<O> {
	const envelope: CommandEnvelope | null =
		def.log === 'none'
			? null
			: {
					command: def.id,
					version: def.version,
					user_id: ctx.viewer,
					timestamp: new Date().toISOString(),
					input: def.envelopeInput ? def.envelopeInput(input) : input
				};
	console.log('[command]', def.id, input);
	ctx.progress({ command: def.id });
	const output = await def.run(input, ctx, envelope);
	if (def.log === 'direct' && envelope) await logDirect(ctx, envelope, output as Result);
	return output;
}

// Commit the command's history row directly (only 'direct' commands, which
// require push access anyway). A lost log row is reported, not fatal — the
// command itself already succeeded or failed on its own terms.
async function logDirect(ctx: CommandContext, envelope: CommandEnvelope, result: Result): Promise<void> {
	const { forge: f, owner, repo } = ctx;
	const row: HistoryRow = {
		timestamp: envelope.timestamp,
		task_id: String(envelope.input.task_id ?? ''),
		subtask_id: '',
		user_id: envelope.user_id,
		action: 'dispatch',
		outcome: result?.error ? 'rejected' : 'accepted',
		detail: result?.error ?? '',
		...envelopeColumns(envelope)
	};
	for (let i = 0; i < MAX_LOG_ATTEMPTS; i++) {
		try {
			const { sha } = await f.getRepoHead(owner, repo);
			const csv = await f.getRepoFile(owner, repo, HISTORY_PATH, sha);
			await f.commitFiles(
				owner,
				repo,
				[{ path: HISTORY_PATH, content: appendHistory(csv ?? '', [row]) }],
				`Log command ${envelope.command}`,
				{ baseSha: sha }
			);
			return;
		} catch (e) {
			if (i === MAX_LOG_ATTEMPTS - 1) {
				console.warn(`Could not log ${envelope.command} to ${HISTORY_PATH}: ${(e as Error).message}`);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Shared helpers

const rand = () => crypto.randomUUID().slice(0, 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Mute the repo's notifications for this user before they author their first PR
// against it. GitHub auto-subscribes a PR's author, so the automation's
// comment-and-close on each claim/submission PR would otherwise email them
// ("you authored the thread"). Skipped when this browser already muted the repo
// for this user (the key carries the user's account id, so switching accounts
// in the same browser re-mutes) or when it is already ignored server-side.
// Non-fatal — a token can only mute its own user, and only when granted the
// OAuth 'notifications' scope.
async function muteOnce(ctx: CommandContext): Promise<void> {
	const { forge: f, repoId, owner, repo, viewer } = ctx;
	const key = `lets-encode:muted:${viewer}:${repoId}`;
	const storage = typeof localStorage === 'undefined' ? null : localStorage;
	if (storage?.getItem(key)) return;
	try {
		if (!(await f.getRepoSubscription(owner, repo))?.ignored) {
			await f.ignoreRepoNotifications(owner, repo);
		}
		storage?.setItem(key, '1');
	} catch (e) {
		// The repo-subscription API requires the OAuth 'notifications' scope; a
		// 403/404 here usually means the token was granted without it.
		console.warn(
			`Could not mute ${owner}/${repo} notifications — this user may receive the ` +
				`campaign automation's emails (the OAuth 'notifications' scope is required): ` +
				(e as Error).message
		);
	}
}

// Wait until the campaign automation has processed a PR (it closes the PR
// when done) and return its verdict comment. A timeout means the run is still
// in flight, not failed. Once the PR is closed, a `head` branch
// the console created in the user's fork is deleted: the automation deletes
// the head branches of PRs opened within the campaign repo itself, but it has
// no rights on a fork, so that half of the cleanup happens here with the
// user's own session.
type PrProcessingResult =
	| { state: 'closed'; verdict: string | null }
	| { state: 'run_failed'; runUrl: string }
	| { state: 'timeout' };

async function waitForPrProcessed(
	ctx: CommandContext,
	pr: {
		number: number;
		headSha?: string;
		head?: { owner: string; repo: string; branch: string };
		cleanup?: 'always' | 'accepted';
	}
): Promise<PrProcessingResult> {
	const { forge: f, owner, repo } = ctx;
	ctx.progress({ step: `Campaign automation is processing PR #${pr.number}…` });
	console.log('[pr] waiting for automation to process PR', pr.number);
	// Best-effort narration of the Actions run the PR triggered, identified by
	// the PR's head commit. A watch failure never fails the command — the PR
	// itself stays the source of truth.
	let watch = pr.headSha
		? new WorkflowRunWatch(
				f,
				owner,
				repo,
				{ workflow: 'caller.yml', event: 'pull_request_target', headSha: pr.headSha },
				ctx.progress
			)
		: null;
	const deadline = Date.now() + 90_000;
	// Fast cadence, low cap: the PR-state and run reads are ETag-cached, so an
	// unchanged poll answers 304 and does not count against the API rate limit —
	// the cap trades a few extra free polls for catching the close sooner.
	let delayMs = 1_000;
	while (Date.now() < deadline) {
		await sleep(delayMs);
		// The PR-state read and the run-watch tick are independent reads — one
		// round trip per iteration instead of two.
		const [state] = await Promise.all([
			f.getPullRequestState(owner, repo, pr.number),
			watch
				?.tick()
				.catch((e) => {
					console.warn('[pr] stopped watching the Actions run:', (e as Error).message);
					watch = null;
				})
		]);
		if (state === 'closed') {
			const verdict = await f.getLastIssueComment(owner, repo, pr.number);
			console.log('[pr] PR', pr.number, 'processed; verdict:', verdict);
			if (pr.cleanup !== 'accepted' || verdict?.startsWith('✅')) {
				await cleanupForkHeadBranch(ctx, pr.head);
			}
			return { state: 'closed', verdict };
		}
		// A failed run never closes the PR — report the failure rather than
		// letting the wait time out as if the run were merely slow.
		if (watch?.state.phase === 'completed' && watch.state.run.conclusion !== 'success') {
			console.log('[pr] Actions run for PR', pr.number, 'failed:', watch.state.run.conclusion);
			return { state: 'run_failed', runUrl: watch.state.run.html_url };
		}
		delayMs = Math.min(3_000, Math.ceil(delayMs * 1.5));
	}
	console.log('[pr] PR', pr.number, 'not processed within 90s (still in flight)');
	return { state: 'timeout' };
}

// Delete a closed PR's head branch when it lives in the user's fork. Non-fatal:
// a leftover branch is clutter, not a failure of the command that opened the PR.
async function cleanupForkHeadBranch(
	ctx: CommandContext,
	head: { owner: string; repo: string; branch: string } | undefined
): Promise<void> {
	if (!head || (head.owner === ctx.owner && head.repo === ctx.repo)) return;
	try {
		await ctx.forge.deleteBranch(head.owner, head.repo, head.branch);
		console.log('[pr] deleted fork branch', `${head.owner}/${head.repo}:${head.branch}`);
	} catch (e) {
		console.warn(
			`Could not delete ${head.branch} in ${head.owner}/${head.repo}: ${(e as Error).message}`
		);
	}
}

// Map the automation's verdict on a PR to a result banner: a rejection is an
// error (never shown as success), no verdict yet (timeout) is a warning.
function verdictResult(result: PrProcessingResult, prNumber: number, prUrl: string, fallback: string): Result {
	if (result.state === 'timeout') {
		return {
			ok: true,
			warn: true,
			prUrl,
			message: `${fallback} PR #${prNumber} is still being processed — refresh the tables in a moment.`
		};
	}
	if (result.state === 'run_failed') {
		return {
			error: `The campaign automation run for PR #${prNumber} failed — see ${result.runUrl}.`,
			prUrl
		};
	}
	if (!result.verdict) {
		return { error: `PR #${prNumber} closed without a coordinator verdict.`, prUrl };
	}
	if (result.verdict.startsWith('❌')) return { error: result.verdict, prUrl };
	if (!result.verdict.startsWith('✅')) {
		return { error: `PR #${prNumber} closed with an unrecognised coordinator verdict.`, prUrl };
	}
	return { ok: true, prUrl, message: result.verdict };
}

/**
 * Where background verdicts are reported. The UI store
 * (pending-verdicts.svelte.ts) registers itself through setVerdictSink when it
 * loads; headless callers keep the no-op. This module cannot import the store
 * directly — it uses Svelte runes, which only exist under the Svelte compiler.
 */
export interface PendingVerdictSink {
	begin(entry: {
		label: string;
		/** 0 while the PR is still being opened (state 'opening'). */
		prNumber: number;
		prUrl: string;
		key?: string;
		/** The campaign repo the submission acts on. */
		repoId?: number;
		state?: 'opening' | 'processing';
	}): string;
	/** The background-opened PR exists now; the entry moves to 'processing'. */
	attachPr(id: string, prNumber: number, prUrl: string): void;
	settle(id: string, state: 'accepted' | 'rejected' | 'timeout', message: string): void;
}

// The fallback sink cannot render anything, but a rejection must never
// disappear silently — it is at least an error in the console.
let verdictSink: PendingVerdictSink = {
	begin: () => '',
	attachPr: () => {},
	settle: (_id, state, message) => {
		if (state !== 'accepted') console.error('[pending-verdict] unrendered verdict:', state, message);
	}
};

export function setVerdictSink(sink: PendingVerdictSink): void {
	verdictSink = sink;
}

// Run a submission-shaped PR command entirely in the background: the Result
// returns at once, and both the PR opening and the automation's verdict are
// followed through the verdict sink — they land on the task's run state
// (TaskRunState.svelte), with a rejection taking the viewport over
// (PendingVerdicts.svelte). Claims stay synchronous — their verdict gates the
// user's next step. The background work reports no progress: the overlay
// belongs to the next command by the time anything lands.
function openAndFinishInBackground(
	ctx: CommandContext,
	label: string,
	/** Structured id of the acted-on target, so UIs can hold its controls while the verdict is pending. */
	key: string | undefined,
	open: (bg: CommandContext) => Promise<{
		number: number;
		html_url: string;
		headSha?: string;
		head?: { owner: string; repo: string; branch: string };
		cleanup?: 'always' | 'accepted';
	}>
): Result {
	const id = verdictSink.begin({
		label,
		prNumber: 0,
		prUrl: '',
		key,
		repoId: ctx.repoId,
		state: 'opening'
	});
	const background: CommandContext = { ...ctx, progress: () => {} };
	void (async () => {
		let pr;
		try {
			pr = await open(background);
		} catch (e) {
			console.warn('[pending-verdict]', label, 'PR opening failed:', (e as Error).message);
			verdictSink.settle(id, 'rejected', `${label} failed: ${(e as Error).message}`);
			return;
		}
		verdictSink.attachPr(id, pr.number, pr.html_url);
		let res: Result;
		try {
			const outcome = await waitForPrProcessed(background, pr);
			res = verdictResult(outcome, pr.number, pr.html_url, `${label} processed.`);
		} catch (e) {
			// The poll failed, not necessarily the submission — an indeterminate
			// outcome settles as "still being processed", never as a rejection.
			console.warn('[pending-verdict]', label, 'poll failed:', (e as Error).message);
			res = verdictResult({ state: 'timeout' }, pr.number, pr.html_url, `${label} processed.`);
		}
		const state = res.error ? 'rejected' : res.warn ? 'timeout' : 'accepted';
		console.log('[pending-verdict]', label, 'PR', pr.number, state);
		verdictSink.settle(id, state, res.error ?? res.message ?? `${label} processed.`);
	})();
	// No banner: the task's run state (TaskRunState.svelte) is the visible
	// signal from here on.
	return { ok: true, background: true };
}

// Open a PR that adds a lock row (the Action re-authors who/when), carrying
// the invoking command's envelope in its body. Shared by the claim command
// and "open in mei-friend" (where opening == claiming).
async function openClaimPr(
	ctx: CommandContext,
	task_id: string,
	subtask_id: string,
	kind: string,
	envelope: CommandEnvelope | null
) {
	const { forge: f, owner, repo, viewer, viewerLogin } = ctx;
	await muteOnce(ctx);
	const lockRows = parseLockCsv((await f.getRepoFile(owner, repo, LOCK_PATH)) ?? '');
	lockRows.push({
		task_id,
		subtask_id,
		user_id: viewer,
		timestamp: new Date().toISOString(),
		kind
	});
	const target = subtask_id ? `${task_id}/${subtask_id}` : task_id;
	const body = `Reserves ${target} for ${kind} work by ${viewerLogin}. Opened from the campaign console.`;
	console.log('[claim] opening claim PR', { task_id, subtask_id, kind, user: viewer });
	return f.openChangePr(owner, repo, {
		branch: `claim-${task_id}${subtask_id ? '-' + subtask_id : ''}-${rand()}`,
		files: [{ path: LOCK_PATH, content: serializeLockCsv(lockRows) }],
		message: `Claim ${target} (${kind})`,
		title: `Claim ${target} (${kind})`,
		body: envelope ? appendEnvelopeToPrBody(body, envelope) : body
	});
}

// Open a claim PR and wait for its verdict synchronously — the claim gates the
// user's next step. A poll failure after the PR opened is indeterminate: it
// resolves as the "still being processed" warning, never as a rejection.
async function claimAndWait(
	ctx: CommandContext,
	task_id: string,
	subtask_id: string,
	kind: string,
	envelope: CommandEnvelope | null
): Promise<Result> {
	try {
		ctx.progress({ step: 'Opening claim PR…' });
		const pr = await openClaimPr(ctx, task_id, subtask_id, kind, envelope);
		console.log('[claim] claim PR opened', pr.number, pr.html_url);
		let verdict: PrProcessingResult;
		try {
			verdict = await waitForPrProcessed(ctx, pr);
		} catch (e) {
			console.warn('[claim] verdict poll failed:', (e as Error).message);
			verdict = { state: 'timeout' };
		}
		const target = subtask_id ? `${task_id}/${subtask_id}` : task_id;
		return verdictResult(verdict, pr.number, pr.html_url, `Opened claim PR #${pr.number} for ${target} (${kind}).`);
	} catch (e) {
		return { error: `Claim failed: ${(e as Error).message}` };
	}
}

// ---------------------------------------------------------------------------
// The commands

/** The parsed campaign tables (and privacy/config) the console renders. */
export interface CampaignTables {
	notInitialised: boolean;
	isPrivate: boolean;
	canPush: boolean;
	taskDefs: TaskRow[];
	rows: StateRow[];
	validationColumns: string[];
	locks: LockRow[];
	history: HistoryRow[];
	/** The comment log (fail explanations and discussion); [] when comment.csv is absent. */
	comments: CommentRow[];
	/** The campaign's pieces from config.yaml, in config order; [] when unreadable. */
	pieces: PieceRef[];
	/** campaign.title from config.yaml; '' when unreadable. */
	title: string;
	/** campaign.description from config.yaml; '' when unreadable or unset. */
	description: string;
	/** campaign.license from config.yaml; '' when unreadable. */
	license: string;
	/** validation.pass_threshold from config.yaml, capped by the slot count; the slot count when unreadable. */
	passThreshold: number;
	/** validation.allow_self_validation from config.yaml; false when unreadable. */
	allowSelfValidation: boolean;
	/**
	 * Numeric account id → current login, for every user referenced by the
	 * tables (locks, encoders, history). The tables store the stable numeric id;
	 * this map is how the UI shows a username. Missing entries fall back to the id.
	 */
	logins: Record<string, string>;
}

const readTables: CommandDef<Record<string, never>, CampaignTables> = {
	id: 'campaign.readTables',
	version: 1,
	log: 'none',
	async run(_input, ctx) {
		const { forge: f, owner, repo } = ctx;
		const [taskCsv, stateCsv, lockCsv, historyCsv, commentCsv, configYaml, access] = await Promise.all([
			f.getRepoFile(owner, repo, TASK_PATH),
			f.getRepoFile(owner, repo, STATE_PATH),
			f.getRepoFile(owner, repo, LOCK_PATH),
			f.getRepoFile(owner, repo, HISTORY_PATH),
			f.getRepoFile(owner, repo, COMMENT_PATH),
			f.getRepoFile(owner, repo, 'config.yaml'),
			f.getRepoAccess(owner, repo)
		]);
		if (taskCsv == null || stateCsv == null || lockCsv == null) {
			return {
				notInitialised: true,
				isPrivate: access.isPrivate,
				canPush: access.canPush,
				taskDefs: [],
				rows: [],
				validationColumns: [],
				locks: [],
				history: [],
				comments: [],
				pieces: [],
				title: '',
				description: '',
				license: '',
				passThreshold: 1,
				allowSelfValidation: false,
				logins: {}
			};
		}
		const state = parseStateCsv(stateCsv);
		const locks = parseLockCsv(lockCsv);
		const history = historyCsv ? parseHistoryCsv(historyCsv) : [];
		const comments = commentCsv ? parseCommentCsv(commentCsv) : [];
		return {
			notInitialised: false,
			isPrivate: access.isPrivate,
			canPush: access.canPush,
			taskDefs: parseTaskCsv(taskCsv),
			rows: state.rows,
			validationColumns: state.validationColumns,
			locks,
			history,
			comments,
			pieces: configPieces(configYaml),
			title: configString(configYaml, 'title'),
			description: configString(configYaml, 'description'),
			license: configString(configYaml, 'license'),
			passThreshold: passThresholdOf(configYaml, state.validationColumns.length),
			allowSelfValidation: configFlag(configYaml, 'allow_self_validation'),
			logins: await resolveLogins((n) => f.getUserLogin(n), {
				rows: state.rows,
				locks,
				history,
				comments
			})
		};
	}
};

const claimValidation: CommandDef<{ task_id: string; subtask_id: string }, Result> = {
	id: 'campaign.claimValidation',
	version: 1,
	log: 'pr',
	run: ({ task_id, subtask_id }, ctx, envelope) => claimAndWait(ctx, task_id, subtask_id, 'validation', envelope)
};

// Prepare the task's score for mei-friend and return the hand-off URL; opening
// for editing also opens an encoding claim PR (unless the user already holds
// the lock). The caller decides when to open the tab — never on a rejected or
// still-pending claim.
const openEditor: CommandDef<{ task_id: string }, Result> = {
	id: 'campaign.openEditor',
	version: 1,
	log: 'pr',
	async run({ task_id }, ctx, envelope) {
		const { forge: f, owner, repo, viewer } = ctx;
		try {
			const [taskCsv, stateCsv] = await Promise.all([
				f.getRepoFile(owner, repo, TASK_PATH),
				f.getRepoFile(owner, repo, STATE_PATH)
			]);
			const fragment = findRow(parseTaskCsv(taskCsv ?? ''), task_id, '')?.fragment;
			const task = findRow(parseStateCsv(stateCsv ?? '').rows, task_id, '');
			if (!fragment || !task) return { error: `Unknown task ${task_id}.` };

			ctx.progress({ step: 'Preparing the score for mei-friend…' });
			const { sha, canPush } = await f.getRepoHead(owner, repo);
			console.log('[editor] task', task_id, 'fragment', fragment, 'mainHead', sha, 'canPush', canPush);

			// Both roles commit to a per-task branch `encode-<task_id>`, bound in
			// mei-friend via connect=true: owners/collaborators get it in the
			// campaign repo itself (you can't fork your own repo), volunteers in
			// their fork — which they can push to, so no fork=true handoff is
			// needed. The submission PR later names the same branch, so the two
			// sides always agree without guessing.
			const ref = `encode-${task_id}`;
			const workRepo = canPush ? { owner, repo } : await f.ensureFork(owner, repo);
			try {
				await f.createBranch(workRepo.owner, workRepo.repo, ref, sha);
				console.log('[editor] created branch', ref, 'in', `${workRepo.owner}/${workRepo.repo}`, 'at', sha);
			} catch (e) {
				if (!/already exists/i.test((e as Error).message)) throw e;
				// The branch exists from an earlier open. If it's merely stale
				// (e.g. created before the init commit), fast-forward it to the
				// current head; a branch with its own commits — work in progress —
				// is left untouched.
				const ffed = await f.fastForwardBranch(workRepo.owner, workRepo.repo, ref, sha);
				console.log('[editor] branch', ref, 'already existed; fast-forward to', sha, '=>', ffed);
			}
			const meiParam = '&connect=true';

			// The branch ref was created or moved a moment ago, and GitHub's
			// Contents API can briefly lag ref updates — retry the lookup rather
			// than failing on that race.
			let downloadUrl: string | null = null;
			for (let attempt = 1; attempt <= 5 && !downloadUrl; attempt++) {
				if (attempt > 1) await sleep(1500);
				downloadUrl = await f.getRepoFileDownloadUrl(workRepo.owner, workRepo.repo, fragment, ref);
				console.log('[editor] download URL attempt', { attempt, fragment, ref, available: Boolean(downloadUrl) });
			}
			if (!downloadUrl) {
				return { error: `Could not get a download URL for ${fragment}.` };
			}
			const url = `${ctx.meiFriendUrl ?? DEFAULT_MEI_FRIEND_URL}/?file=${encodeURIComponent(downloadUrl)}${meiParam}`;

			const mine = parseLockCsv((await f.getRepoFile(owner, repo, LOCK_PATH)) ?? '').some(
				(l) => l.task_id === task_id && l.subtask_id === '' && l.kind === 'encoding' && l.user_id === viewer
			);
			let prUrl: string | undefined;
			let message = 'Opening the score in mei-friend. After committing there, use “Submit encoding”.';
			if (task.status === 'encoding_required' && !mine) {
				ctx.progress({ step: 'Opening the encoding claim PR…' });
				const pr = await openClaimPr(ctx, task_id, '', 'encoding', envelope);
				console.log('[editor] encoding claim PR opened', pr.number, pr.html_url);
				prUrl = pr.html_url;
				const verdict = await waitForPrProcessed(ctx, pr);
				const res = verdictResult(verdict, pr.number, pr.html_url, `Opened encoding claim PR #${pr.number}.`);
				if (res?.error) {
					return { error: `The encoding claim was rejected — ${res.error}`, prUrl };
				}
				if (res?.warn) {
					// Claim not confirmed yet — surface the warning with the link
					// instead of opening a tab for a task that may not be theirs.
					return { ok: true, warn: true, meiFriendUrl: url, prUrl, message: `${res.message}` };
				}
				message = `${res?.message} Opening the score in mei-friend — after committing there, use “Submit encoding”.`;
				return { ok: true, meiFriendUrl: url, prUrl, message };
			}
			return { ok: true, meiFriendUrl: url, prUrl, message };
		} catch (e) {
			return { error: `Open in mei-friend failed: ${(e as Error).message}` };
		}
	}
};

// After committing an encoding in mei-friend (which only pushes to a branch),
// open the submission PR that advances the task to validation.
const submitEncoding: CommandDef<{ task_id: string }, Result> = {
	id: 'campaign.submitEncoding',
	version: 1,
	log: 'pr',
	async run({ task_id }, ctx, envelope) {
		const { forge: f, owner, repo, viewerLogin } = ctx;
		return openAndFinishInBackground(ctx, `Encoding of ${task_id}`, `encode:${task_id}`, async () => {
			await muteOnce(ctx);
			const { branch: base, canPush } = await f.getRepoHead(owner, repo);
			// The claim/editor flow put the encoding on `encode-<task_id>` — in the
			// campaign repo for owners/collaborators, in the volunteer's fork
			// otherwise — so the head is fully determined; nothing to guess.
			let head: string;
			let forkHead: { owner: string; repo: string; branch: string } | undefined;
			if (canPush) {
				head = `encode-${task_id}`;
			} else {
				const fork = await f.ensureFork(owner, repo);
				const branch = `encode-${task_id}`;
				head = `${fork.owner}:${branch}`;
				forkHead = { ...fork, branch };
			}
			const body = `Submits the encoding of ${task_id} by ${viewerLogin}, edited in mei-friend. Opened from the campaign console.`;
			console.log('[submitpr] opening PR', { head, base });
			const pr = await f.createPullRequest(owner, repo, {
				title: `Encoding of ${task_id}`,
				head,
				base,
				body: envelope ? appendEnvelopeToPrBody(body, envelope) : body
			});
			console.log('[submitpr] submission PR opened', pr.number, pr.html_url);
			return { ...pr, head: forkHead, cleanup: 'accepted' };
		});
	}
};

/** The measure-anchored explanation a fail verdict must carry. */
export interface FailComment {
	body: string;
	/** 1-based facsimile page the comment anchors to; '' = unanchored. */
	page: string;
	measure_start: string;
	measure_end: string;
}

// Open a PR that sets the subtask's first open validation cell (pass/fail).
// A fail carries its mandatory comment as one appended comment.csv row in the
// same PR; the automation rejects a fail without one.
const submitValidation: CommandDef<
	{ task_id: string; subtask_id: string; verdict: string; comment?: FailComment },
	Result
> = {
	id: 'campaign.submitValidation',
	version: 2,
	log: 'pr',
	envelopeInput: ({ task_id, subtask_id, verdict }) => ({ task_id, subtask_id, verdict }),
	async run({ task_id, subtask_id, verdict, comment }, ctx, envelope) {
		const { forge: f, owner, repo } = ctx;
		if (verdict !== 'pass' && verdict !== 'fail') {
			return { error: `Invalid validation verdict: ${verdict}.` };
		}
		if (verdict === 'fail' && !comment?.body.trim()) {
			return { error: 'A fail needs a comment saying why — nothing was submitted.' };
		}
		const label = `Validation of ${task_id}/${subtask_id} (${verdict})`;
		return openAndFinishInBackground(ctx, label, `validate:${task_id}/${subtask_id}`, async () => {
			await muteOnce(ctx);
			const state = parseStateCsv((await f.getRepoFile(owner, repo, STATE_PATH)) ?? '');
			const row = findRow(state.rows, task_id, subtask_id);
			if (!row) throw new Error(`unknown subtask ${task_id}/${subtask_id}.`);
			const slot = state.validationColumns.find((c) => (row[c] ?? '') === '');
			if (!slot) {
				throw new Error(`no open validation slot on ${task_id}/${subtask_id}.`);
			}
			row[slot] = verdict; // the Action re-authors this to `verdict|user|time`
			const files = [{ path: STATE_PATH, content: serializeStateCsv(state) }];
			if (verdict === 'fail') {
				// The id, author and timestamp are the Action's to write.
				const commentCsv = (await f.getRepoFile(owner, repo, COMMENT_PATH)) ?? '';
				files.push({
					path: COMMENT_PATH,
					content: appendComments(commentCsv, [
						{
							comment_id: '',
							task_id,
							subtask_id,
							kind: 'fail',
							page: comment!.page,
							measure_start: comment!.measure_start,
							measure_end: comment!.measure_end,
							author_id: '',
							timestamp: '',
							resolved: '',
							parent_id: '',
							body: comment!.body.trim()
						}
					])
				});
			}
			const body = `Submits a ${verdict} validation for ${task_id}/${subtask_id}. Opened from the campaign console.`;
			console.log('[validate] opening validation PR', { task_id, subtask_id, verdict, slot });
			const pr = await f.openChangePr(owner, repo, {
				branch: `validate-${task_id}-${subtask_id}-${rand()}`,
				files,
				message: `Validate ${task_id}/${subtask_id} (${verdict})`,
				title: `Validate ${task_id}/${subtask_id} (${verdict})`,
				body: envelope ? appendEnvelopeToPrBody(body, envelope) : body
			});
			console.log('[validate] validation PR opened', pr.number, pr.html_url);
			return pr;
		});
	}
};

// Open a PR that appends one discussion comment (question / addition / reply)
// to comment.csv. The Action re-authors id, author and timestamp.
const submitComment: CommandDef<
	{
		task_id: string;
		subtask_id: string;
		kind: string;
		body: string;
		page: string;
		measure_start: string;
		measure_end: string;
		parent_id: string;
	},
	Result
> = {
	id: 'campaign.submitComment',
	version: 1,
	log: 'pr',
	envelopeInput: ({ task_id, subtask_id, kind, parent_id }) => ({ task_id, subtask_id, kind, parent_id }),
	async run(input, ctx, envelope) {
		const { forge: f, owner, repo } = ctx;
		if (!input.body.trim()) return { error: 'The comment is empty — nothing was sent.' };
		return openAndFinishInBackground(ctx, `Comment on ${input.task_id}`, `comment:${input.task_id}`, async () => {
			await muteOnce(ctx);
			const commentCsv = (await f.getRepoFile(owner, repo, COMMENT_PATH)) ?? '';
			const content = appendComments(commentCsv, [
				{
					comment_id: '',
					task_id: input.task_id,
					subtask_id: input.subtask_id,
					kind: input.kind,
					page: input.page,
					measure_start: input.measure_start,
					measure_end: input.measure_end,
					author_id: '',
					timestamp: '',
					resolved: '',
					parent_id: input.parent_id,
					body: input.body.trim()
				}
			]);
			const body = `Adds a ${input.kind} comment on ${input.task_id}. Opened from the campaign console.`;
			const pr = await f.openChangePr(owner, repo, {
				branch: `comment-${input.task_id}-${rand()}`,
				files: [{ path: COMMENT_PATH, content }],
				message: `Comment on ${input.task_id} (${input.kind})`,
				title: `Comment on ${input.task_id} (${input.kind})`,
				body: envelope ? appendEnvelopeToPrBody(body, envelope) : body
			});
			console.log('[comment] comment PR opened', pr.number, pr.html_url);
			return pr;
		});
	}
};

// Open a PR that marks one comment resolved (author or push access only —
// the automation enforces it).
const resolveComment: CommandDef<{ comment_id: string }, Result> = {
	id: 'campaign.resolveComment',
	version: 1,
	log: 'pr',
	async run({ comment_id }, ctx, envelope) {
		const { forge: f, owner, repo } = ctx;
		let comments;
		try {
			comments = parseCommentCsv((await f.getRepoFile(owner, repo, COMMENT_PATH)) ?? '');
		} catch (e) {
			return { error: `Resolve failed: ${(e as Error).message}` };
		}
		const row = comments.find((c) => c.comment_id === comment_id);
		if (!row) return { error: `Unknown comment ${comment_id}.` };
		if (row.resolved === 'true') return { ok: true, warn: true, message: 'Already resolved.' };
		// A resolved comment takes its replies with it (the automation enforces
		// the same on its side).
		const resolved = resolveCommentThread(comments, comment_id);
		return openAndFinishInBackground(ctx, `Resolution of comment ${comment_id}`, `resolve:${row.task_id}`, async () => {
			await muteOnce(ctx);
			const body = `Resolves comment ${comment_id} on ${row.task_id}. Opened from the campaign console.`;
			const pr = await f.openChangePr(owner, repo, {
				branch: `resolve-${comment_id}-${rand()}`,
				files: [{ path: COMMENT_PATH, content: serializeCommentCsv(resolved) }],
				message: `Resolve comment ${comment_id}`,
				title: `Resolve comment ${comment_id}`,
				body: envelope ? appendEnvelopeToPrBody(body, envelope) : body
			});
			console.log('[comment] resolve PR opened', pr.number, pr.html_url);
			return pr;
		});
	}
};

// Open a PR that sends a failed task back to its work stage (encoding, or
// score setup / measure correction for a pre-task): the task resets to encoding_required,
// its subtasks to pending, and every validation cell clears. Allowed for a
// failing validator or anyone with push access — the automation enforces it.
const sendBack: CommandDef<{ task_id: string }, Result> = {
	id: 'campaign.sendBack',
	version: 1,
	log: 'pr',
	async run({ task_id }, ctx, envelope) {
		const { forge: f, owner, repo } = ctx;
		return openAndFinishInBackground(ctx, `Send-back of ${task_id}`, `sendback:${task_id}`, async () => {
			await muteOnce(ctx);
			const [stateCsv, taskCsv] = await Promise.all([
				f.getRepoFile(owner, repo, STATE_PATH),
				f.getRepoFile(owner, repo, TASK_PATH)
			]);
			const state = parseStateCsv(stateCsv ?? '');
			const row = findRow(state.rows, task_id, '');
			if (!row) throw new Error(`unknown task ${task_id}.`);
			const locator = findRow(parseTaskCsv(taskCsv ?? ''), task_id, '')?.locator ?? '';
			const stage = sendBackTarget(locator);
			resetTaskRows(state.rows, state.validationColumns, task_id);
			const body = `Sends ${task_id} back for ${stage} after a failed validation. Opened from the campaign console.`;
			const pr = await f.openChangePr(owner, repo, {
				branch: `sendback-${task_id}-${rand()}`,
				files: [{ path: STATE_PATH, content: serializeStateCsv(state) }],
				message: `Send ${task_id} back for ${stage}`,
				title: `Send ${task_id} back for ${stage}`,
				body: envelope ? appendEnvelopeToPrBody(body, envelope) : body
			});
			console.log('[sendback] PR opened', pr.number, pr.html_url);
			return pr;
		});
	}
};

// Rewrite the task plan (task.csv + the matching state.csv rows) from the
// console's plan editor. Owner-only: the rewrite is committed directly, so it
// requires push access; checkPlan re-validates against fresh tables so a claim
// that landed while editing rejects the save rather than being overwritten.
const PLAN_REJECTIONS: Record<string, string> = {
	empty_plan: 'The plan has no tasks — a campaign needs at least one.',
	duplicate_row: 'The plan lists the same task twice.',
	missing_task_id: 'A task row has no id.',
	missing_fragment: 'Every task needs a score file (fragment).',
	orphan_subtask: 'A validation subtask points at a task that is not in the plan.',
	unknown_dependency: 'A task depends on a task that is not in the plan.',
	dependency_cycle: 'The dependencies run in a circle — no task could ever be claimed.',
	task_in_progress:
		'A task someone has already worked on or claimed was changed or removed — refresh and edit again.'
};

const savePlan: CommandDef<{ tasks: TaskRow[] }, Result> = {
	id: 'campaign.savePlan',
	version: 1,
	log: 'direct',
	envelopeInput: ({ tasks }) => ({
		tasks: tasks.filter((t) => t.subtask_id === '').map((t) => t.task_id)
	}),
	async run({ tasks }, ctx) {
		const { forge: f, owner, repo } = ctx;
		try {
			ctx.progress({ step: 'Checking the plan against the current tables…' });
			const { sha, canPush } = await f.getRepoHead(owner, repo);
			if (!canPush) return { error: 'Only someone with push access can edit the plan.' };
			const [taskCsv, stateCsv, lockCsv] = await Promise.all([
				f.getRepoFile(owner, repo, TASK_PATH, sha),
				f.getRepoFile(owner, repo, STATE_PATH, sha),
				f.getRepoFile(owner, repo, LOCK_PATH, sha)
			]);
			if (taskCsv == null || stateCsv == null) return { error: 'Could not read the tracking tables.' };
			const state = parseStateCsv(stateCsv);
			const verdict = checkPlan(parseTaskCsv(taskCsv), state, parseLockCsv(lockCsv ?? ''), tasks);
			if (!verdict.ok) {
				return { error: PLAN_REJECTIONS[verdict.reason] ?? `Plan rejected: ${verdict.reason}.` };
			}
			ctx.progress({ step: 'Committing the new plan…' });
			await f.commitFiles(
				owner,
				repo,
				[
					{ path: TASK_PATH, content: serializeTaskCsv(tasks) },
					{ path: STATE_PATH, content: serializeStateCsv({ header: state.header, rows: verdict.stateRows }) }
				],
				'Edit the task plan',
				{ baseSha: sha }
			);
			return { ok: true, message: 'The plan is saved.' };
		} catch (e) {
			return { error: `Saving the plan failed: ${(e as Error).message}` };
		}
	}
};

// Manually dispatch the scheduled reaper, then wait for its run to finish
// (there is no PR to watch — poll the dispatched workflow run instead).
// Dispatching requires push access, so the invocation is logged directly.
const runReaper: CommandDef<Record<string, never>, Result> = {
	id: 'campaign.runReaper',
	version: 1,
	log: 'direct',
	async run(_input, ctx) {
		const { forge: f, owner, repo } = ctx;
		try {
			ctx.progress({ step: 'Dispatching the stale-lock reaper…' });
			const { branch } = await f.getRepoHead(owner, repo);
			const dispatchedAt = Date.now();
			console.log('[reaper] dispatching caller.yml on', branch);
			await f.dispatchWorkflow(owner, repo, 'caller.yml', branch);
			// Only a run created after our dispatch counts (the watch applies
			// clock-skew slack to `since`). The watch narrates the wait for the
			// run itself, starting with the search for it.
			const watch = new WorkflowRunWatch(
				f,
				owner,
				repo,
				{ workflow: 'caller.yml', event: 'workflow_dispatch', since: dispatchedAt },
				ctx.progress
			);
			const deadline = Date.now() + 90_000;
			while (Date.now() < deadline) {
				await sleep(2000);
				await watch.tick();
				if (watch.state.phase === 'completed') {
					const { conclusion, html_url } = watch.state.run;
					console.log('[reaper] run finished with conclusion:', conclusion);
					if (conclusion !== 'success') {
						return { error: `The reaper run finished with "${conclusion}" — see ${html_url}.` };
					}
					return { ok: true, message: 'Stale-lock reaper finished.' };
				}
			}
			return {
				ok: true,
				warn: true,
				message: 'Reaper dispatched; the run hasn’t finished yet — refresh the tables in a moment.'
			};
		} catch (e) {
			return { error: `Reaper dispatch failed: ${(e as Error).message}` };
		}
	}
};

// ---------------------------------------------------------------------------
// The facsimile pre-task commands (zone editor)

/** Everything the zone editor needs about a facsimile pre-task. */
export interface FacsimileTaskData {
	model: ParsedFacsimile;
	/** Per page (same order as model.pages), a direct download URL for its image. */
	imageUrls: string[];
	fragment: string;
	locator: string;
	status: string;
	/** Whether the viewer holds the task's active encoding lock (may edit/submit). */
	holdsLock: boolean;
	/** Who holds the task's active encoding lock ('' when unclaimed). */
	encodingLockUser: string;
	/** The incomplete task this one waits for (task.csv depends_on); '' when none. */
	blockedBy: string;
	/** Who submitted the task's work ('' while unsubmitted). Encoders cannot validate it. */
	encoder: string;
	/** validation.allow_self_validation from config.yaml; false when unreadable. */
	allowSelfValidation: boolean;
	/** Whether the viewer has push access to the campaign repo. */
	canPush: boolean;
	/** The task's validation subtask, so the editor can drive the review too. */
	validation: {
		subtask_id: string;
		status: string;
		/** Who holds the subtask's active validation lock ('' when unclaimed). */
		lockUser: string;
		/** The recorded final verdicts (`pass`/`fail` with author and timestamp), in slot order. */
		verdicts: { verdict: string; user: string; ts: string }[];
		/** Validation slots still empty (claimable while > active locks). */
		openSlots: number;
	} | null;
	/** The task's fail comments from comment.csv, in table order. */
	failComments: CommentRow[];
}

const readFacsimile: CommandDef<{ task_id: string }, FacsimileTaskData> = {
	id: 'campaign.readFacsimile',
	version: 1,
	log: 'none',
	async run({ task_id }, ctx) {
		const { forge: f, owner, repo, viewer } = ctx;
		const [taskCsv, stateCsv, lockCsv, commentCsv, configYaml, head] = await Promise.all([
			f.getRepoFile(owner, repo, TASK_PATH),
			f.getRepoFile(owner, repo, STATE_PATH),
			f.getRepoFile(owner, repo, LOCK_PATH),
			f.getRepoFile(owner, repo, COMMENT_PATH),
			f.getRepoFile(owner, repo, 'config.yaml'),
			f.getRepoHead(owner, repo)
		]);
		const task = findRow(parseTaskCsv(taskCsv ?? ''), task_id, '');
		if (!task) throw new Error(`Unknown task ${task_id}.`);
		const mei = await f.getRepoFile(owner, repo, task.fragment);
		if (mei == null) throw new Error(`Could not read ${task.fragment}.`);
		const model = parseFacsimileMei(mei);
		const imageUrls = await resolveFacsimileImageUrls(
			f,
			owner,
			repo,
			task.fragment,
			model.pages.map((page) => page.image)
		);
		const locks = parseLockCsv(lockCsv ?? '');
		const encodingLock = locks.find(
			(l) => l.task_id === task_id && l.subtask_id === '' && l.kind === 'encoding'
		);
		const holdsLock = viewer !== '' && encodingLock?.user_id === viewer;
		const state = parseStateCsv(stateCsv ?? '');
		const taskState = findRow(state.rows, task_id, '');
		const blockedBy =
			task.depends_on && findRow(state.rows, task.depends_on, '')?.status !== 'completed'
				? task.depends_on
				: '';
		const subRow = state.rows.find((r) => r.task_id === task_id && r.subtask_id !== '');
		const cells = subRow ? state.validationColumns.map((c) => subRow[c] ?? '') : [];
		const validation = subRow
			? {
					subtask_id: subRow.subtask_id,
					status: subRow.status,
					lockUser:
						locks.find(
							(l) =>
								l.task_id === task_id && l.subtask_id === subRow.subtask_id && l.kind === 'validation'
						)?.user_id ?? '',
					verdicts: cells.filter(isFinalValidation).map((cell) => {
						const [verdict, user, ts] = cell.split('|');
						return { verdict, user, ts };
					}),
					openSlots: cells.filter((cell) => cell === '').length
				}
			: null;
		return {
			model,
			imageUrls,
			fragment: task.fragment,
			locator: task.locator,
			status: taskState?.status ?? '',
			holdsLock,
			encodingLockUser: encodingLock?.user_id ?? '',
			blockedBy,
			encoder: taskState?.encoder ?? '',
			allowSelfValidation: configFlag(configYaml, 'allow_self_validation'),
			canPush: head.canPush,
			validation,
			failComments: parseCommentCsv(commentCsv ?? '').filter(
				(c) => c.task_id === task_id && c.kind === 'fail'
			)
		};
	}
};

// Claim a task for encoding-kind work without a mei-friend hand-off — the
// zone editor's claim path for the facsimile pre-tasks.
const claimTask: CommandDef<{ task_id: string }, Result> = {
	id: 'campaign.claimTask',
	version: 1,
	log: 'pr',
	run: ({ task_id }, ctx, envelope) => claimAndWait(ctx, task_id, '', 'encoding', envelope)
};

// Open the PR carrying a rewritten score, wait for the automation's verdict.
// The current file's <meiHead> is carried over verbatim, its score definition
// through the parse.
//
// The submission advances the score to stage C (generated measures, breaks and
// movements), so the submitted content always differs from the file in the
// repo — even when the volunteer changed nothing, since the new stage adds
// elements the previous one lacked. That guaranteed diff is what makes the
// caller's path-filtered pull_request_target trigger; an identical file would
// open an empty PR that never runs the automation.
async function submitFacsimile(
	ctx: CommandContext,
	task_id: string,
	pages: PageModel[],
	envelope: CommandEnvelope | null
): Promise<Result> {
	const { forge: f, owner, repo } = ctx;
	try {
		await muteOnce(ctx);
		const taskCsv = await f.getRepoFile(owner, repo, TASK_PATH);
		const fragment = findRow(parseTaskCsv(taskCsv ?? ''), task_id, '')?.fragment;
		if (!fragment) return { error: `Unknown task ${task_id}.` };
		const current = await f.getRepoFile(owner, repo, fragment);
		if (current == null) return { error: `Could not read ${fragment}.` };
		const parsed = parseFacsimileMei(current);
		const content = buildFacsimileMei(
			{ headXml: parsed.headXml, scoreDef: parsed.scoreDef, pages },
			{ withBreaks: true }
		);
		// A no-op would open an empty PR the path-filtered caller never runs;
		// guard against that rather than leaving the console polling forever.
		if (content === current) {
			return { ok: true, warn: true, message: 'Nothing to submit — the score already matches this step.' };
		}
		ctx.progress({ step: 'Opening the correction PR…' });
		const title = `Correct measure zones (${task_id})`;
		const body = `${title}. Opened from the zone editor.`;
		console.log('[zones] opening PR', { task_id });
		const pr = await f.openChangePr(owner, repo, {
			branch: `zones-${task_id}-${rand()}`,
			files: [{ path: fragment, content }],
			message: title,
			title,
			body: envelope ? appendEnvelopeToPrBody(body, envelope) : body
		});
		console.log('[zones] PR opened', pr.number, pr.html_url);
		// The verdict is awaited here, not in the background: the zone editor
		// navigates away on acceptance, so a rejection must land while the
		// volunteer's corrections are still on screen to retry from.
		const verdict = await waitForPrProcessed(ctx, { ...pr, cleanup: 'accepted' });
		return verdictResult(verdict, pr.number, pr.html_url, `Correction of ${task_id} submitted.`);
	} catch (e) {
		return { error: `Submission failed: ${(e as Error).message}` };
	}
}

// Measure correction: submit stage C — the corrected zones with one generated
// measure per zone (numbered from the zone labels), the page/system breaks,
// and one <mdiv> per marked movement. The validation subtask reviews all of it.
const submitZones: CommandDef<{ task_id: string; pages: PageModel[] }, Result> = {
	id: 'campaign.submitZones',
	version: 2,
	log: 'pr',
	envelopeInput: ({ task_id, pages }) => ({
		task_id,
		measures: pages.reduce((n, p) => n + p.zones.length, 0),
		systems: pages.reduce((n, p) => n + p.zones.filter((z) => z.sb).length, 0),
		movements: 1 + pages.reduce((n, p) => n + p.zones.filter((z) => z.mdiv).length, 0)
	}),
	run: ({ task_id, pages }, ctx, envelope) =>
		submitFacsimile(ctx, task_id, pages, envelope)
};

// Score setup: submit the piece's initial score definition — staves with their
// clefs and instrument labels, key signature and meter — by rebuilding the
// score around it. A facsimile piece is rebuilt at the stage it is already at,
// with its header, pages and breaks carried over; a physical piece's blank
// score is rebuilt with its page count read from the file's <pb> markers. The
// validation subtask reviews the entered values.
const submitScoreSetup: CommandDef<{ task_id: string; scoreDef: ScoreDefModel }, Result> = {
	id: 'campaign.submitScoreSetup',
	version: 1,
	log: 'pr',
	envelopeInput: ({ task_id, scoreDef }) => ({
		task_id,
		staves: scoreDef.staves.length,
		groups: scoreDef.groups.length,
		keysig: scoreDef.keysig,
		meter: scoreDef.meterSym || `${scoreDef.meterCount}/${scoreDef.meterUnit}`
	}),
	async run({ task_id, scoreDef }, ctx, envelope) {
		const { forge: f, owner, repo } = ctx;
		try {
			await muteOnce(ctx);
			const [taskCsv, configYaml] = await Promise.all([
				f.getRepoFile(owner, repo, TASK_PATH),
				f.getRepoFile(owner, repo, 'config.yaml')
			]);
			const fragment = findRow(parseTaskCsv(taskCsv ?? ''), task_id, '')?.fragment;
			if (!fragment) return { error: `Unknown task ${task_id}.` };
			const current = await f.getRepoFile(owner, repo, fragment);
			if (current == null) return { error: `Could not read ${fragment}.` };
			const parsed = parseFacsimileMei(current);
			const content =
				pieceKindForPath(configYaml, fragment) === 'physical-only'
					? buildBlankScoreMei(parsed.headXml, (current.match(/<pb\b/g) ?? []).length, scoreDef)
					: buildFacsimileMei(
							{ headXml: parsed.headXml, scoreDef, pages: parsed.pages },
							{ withBreaks: parsed.hasBreaks }
						);
			// A no-op would open an empty PR the path-filtered caller never runs;
			// guard against that rather than leaving the console polling forever.
			if (content === current) {
				return {
					ok: true,
					warn: true,
					message: 'Nothing to submit — the score already matches this setup.'
				};
			}
			ctx.progress({ step: 'Opening the setup PR…' });
			const title = `Set up the score (${task_id})`;
			const body = `${title}. Opened from the score setup editor.`;
			console.log('[setup] opening PR', { task_id });
			const pr = await f.openChangePr(owner, repo, {
				branch: `setup-${task_id}-${rand()}`,
				files: [{ path: fragment, content }],
				message: title,
				title,
				body: envelope ? appendEnvelopeToPrBody(body, envelope) : body
			});
			console.log('[setup] PR opened', pr.number, pr.html_url);
			// The verdict is awaited here, not in the background: the setup editor
			// navigates away on acceptance, so a rejection must land while the
			// entered values are still on screen to retry from.
			const verdict = await waitForPrProcessed(ctx, { ...pr, cleanup: 'accepted' });
			return verdictResult(verdict, pr.number, pr.html_url, `Score setup of ${task_id} submitted.`);
		} catch (e) {
			return { error: `Submission failed: ${(e as Error).message}` };
		}
	}
};

/** The console command registry. */
export const commands = {
	readTables,
	claimValidation,
	openEditor,
	submitEncoding,
	submitValidation,
	submitComment,
	resolveComment,
	sendBack,
	savePlan,
	runReaper,
	readFacsimile,
	claimTask,
	submitZones,
	submitScoreSetup
};
