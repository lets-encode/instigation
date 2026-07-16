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
import { meiFriendUrl } from './forge/config.ts';
import {
	parseTaskCsv,
	parseStateCsv,
	parseLockCsv,
	parseHistoryCsv,
	serializeStateCsv,
	serializeLockCsv,
	appendHistory,
	findRow
} from './campaign-tables.ts';
import type { TaskRow, StateRow, LockRow, HistoryRow } from './campaign-tables.ts';
import { appendEnvelopeToPrBody, envelopeColumns } from './command-envelope.ts';
import type { CommandEnvelope } from './command-envelope.ts';
import { parseFacsimileMei, buildFacsimileMei } from './mei-facsimile.ts';
import type { PageModel, ParsedFacsimile } from './mei-facsimile.ts';

const TASK_PATH = 'tracking/task.csv';
const STATE_PATH = 'tracking/state.csv';
const LOCK_PATH = 'tracking/lock.csv';
const HISTORY_PATH = 'tracking/history.csv';
const MAX_LOG_ATTEMPTS = 3;

/** What a command invocation is run against: the campaign, the user, the forge. */
export interface CommandContext {
	forge: ForgeClient;
	owner: string;
	repo: string;
	viewer: string;
	/** Progress messages for a busy indicator; pass a no-op when headless. */
	progress: (message: string) => void;
}

/** The result banner a command resolves to (never rejects). */
export type Result = {
	ok?: boolean;
	warn?: boolean;
	error?: string;
	message?: string;
	prUrl?: string;
	meiFriendUrl?: string;
	rawUrl?: string;
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
// Shared helpers (moved from the campaign console page)

const rand = () => crypto.randomUUID().slice(0, 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Mute the campaign repo's notifications for this user, once per browser:
// skipped when this browser has muted it before, or when the repo is already
// ignored server-side. GitHub auto-subscribes users to repos they own or are
// mentioned in, so a plain subscription is not treated as a deliberate opt-in
// to watch — only an existing "ignored" state is left alone. Non-fatal — each
// token can only mute its own user.
async function muteOnce(f: ForgeClient, owner: string, repo: string): Promise<void> {
	const key = `lets-encode:muted:${owner}/${repo}`;
	if (localStorage.getItem(key)) return;
	try {
		if (!(await f.getRepoSubscription(owner, repo))?.ignored) {
			await f.ignoreRepoNotifications(owner, repo);
		}
		localStorage.setItem(key, '1');
	} catch (e) {
		console.warn('Could not mute repo notifications:', (e as Error).message);
	}
}

// Wait until the campaign automation has processed a PR (it closes the PR
// when done) and return its verdict comment. Null on timeout — the run is
// then still in flight, not failed.
async function waitForPrProcessed(ctx: CommandContext, prNumber: number): Promise<string | null> {
	const { forge: f, owner, repo } = ctx;
	ctx.progress(`Campaign automation is processing PR #${prNumber}…`);
	console.log('[pr] waiting for automation to process PR', prNumber);
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		await sleep(3000);
		if ((await f.getPullRequestState(owner, repo, prNumber)) === 'closed') {
			const verdict = await f.getLastIssueComment(owner, repo, prNumber);
			console.log('[pr] PR', prNumber, 'processed; verdict:', verdict);
			return verdict;
		}
	}
	console.log('[pr] PR', prNumber, 'not processed within 120s (still in flight)');
	return null;
}

// Map the automation's verdict on a PR to a result banner: a rejection is an
// error (never shown as success), no verdict yet (timeout) is a warning.
function verdictResult(verdict: string | null, prNumber: number, prUrl: string, fallback: string): Result {
	if (verdict == null) {
		return {
			ok: true,
			warn: true,
			prUrl,
			message: `${fallback} PR #${prNumber} is still being processed — refresh the tables in a moment.`
		};
	}
	if (verdict.startsWith('❌')) return { error: verdict, prUrl };
	return { ok: true, prUrl, message: verdict };
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
	const { forge: f, owner, repo, viewer } = ctx;
	// Claiming is a user's first interaction with a campaign: mute the repo's
	// notifications for them, or the automation's PR comments would email
	// every participant.
	await muteOnce(f, owner, repo);
	const lockRows = parseLockCsv((await f.getRepoFile(owner, repo, LOCK_PATH)) ?? '');
	lockRows.push({
		task_id,
		subtask_id,
		user_id: viewer,
		timestamp: new Date().toISOString(),
		kind
	});
	const target = subtask_id ? `${task_id}/${subtask_id}` : task_id;
	const body = `Reserves ${target} for ${kind} work by @${viewer}. Opened from the campaign console.`;
	console.log('[claim] opening claim PR', { task_id, subtask_id, kind, user: viewer });
	return f.openChangePr(owner, repo, {
		branch: `claim-${task_id}${subtask_id ? '-' + subtask_id : ''}-${rand()}`,
		files: [{ path: LOCK_PATH, content: serializeLockCsv(lockRows) }],
		message: `Claim ${target} (${kind})`,
		title: `Claim ${target} (${kind})`,
		body: envelope ? appendEnvelopeToPrBody(body, envelope) : body
	});
}

// ---------------------------------------------------------------------------
// The commands

/** The parsed campaign tables (and privacy/config) the console renders. */
export interface CampaignTables {
	notInitialised: boolean;
	isPrivate: boolean;
	taskDefs: TaskRow[];
	rows: StateRow[];
	validationColumns: string[];
	locks: LockRow[];
	history: HistoryRow[];
	/** campaign.title from config.yaml; '' when unreadable. */
	title: string;
	/** validation.pass_threshold from config.yaml; 1 when unreadable. */
	passThreshold: number;
}

const readTables: CommandDef<Record<string, never>, CampaignTables> = {
	id: 'campaign.readTables',
	version: 1,
	log: 'none',
	async run(_input, ctx) {
		const { forge: f, owner, repo } = ctx;
		const [taskCsv, stateCsv, lockCsv, historyCsv, configYaml, isPrivate] = await Promise.all([
			f.getRepoFile(owner, repo, TASK_PATH),
			f.getRepoFile(owner, repo, STATE_PATH),
			f.getRepoFile(owner, repo, LOCK_PATH),
			f.getRepoFile(owner, repo, HISTORY_PATH),
			f.getRepoFile(owner, repo, 'config.yaml'),
			f.getRepoIsPrivate(owner, repo)
		]);
		const title = configYaml?.match(/^\s*title:\s*(?:"([^"]*)"|([^#\n]+))/m);
		const passThreshold = configYaml?.match(/^\s*pass_threshold:\s*(\d+)/m);
		if (taskCsv == null || stateCsv == null || lockCsv == null) {
			return {
				notInitialised: true,
				isPrivate,
				taskDefs: [],
				rows: [],
				validationColumns: [],
				locks: [],
				history: [],
				title: '',
				passThreshold: 1
			};
		}
		const state = parseStateCsv(stateCsv);
		return {
			notInitialised: false,
			isPrivate,
			taskDefs: parseTaskCsv(taskCsv),
			rows: state.rows,
			validationColumns: state.validationColumns,
			locks: parseLockCsv(lockCsv),
			history: historyCsv ? parseHistoryCsv(historyCsv) : [],
			title: (title?.[1] ?? title?.[2] ?? '').trim(),
			passThreshold: passThreshold ? Math.max(1, Number(passThreshold[1])) : 1
		};
	}
};

const claimValidation: CommandDef<{ task_id: string; subtask_id: string }, Result> = {
	id: 'campaign.claimValidation',
	version: 1,
	log: 'pr',
	async run({ task_id, subtask_id }, ctx, envelope) {
		try {
			ctx.progress('Opening claim PR…');
			const pr = await openClaimPr(ctx, task_id, subtask_id, 'validation', envelope);
			console.log('[claim] claim PR opened', pr.number, pr.html_url);
			const verdict = await waitForPrProcessed(ctx, pr.number);
			return verdictResult(
				verdict,
				pr.number,
				pr.html_url,
				`Opened claim PR #${pr.number} for ${task_id}/${subtask_id} (validation).`
			);
		} catch (e) {
			return { error: `Claim failed: ${(e as Error).message}` };
		}
	}
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

			ctx.progress('Preparing the score for mei-friend…');
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
				console.log('[editor] downloadUrl attempt', attempt, 'for', fragment, '@', `${workRepo.owner}/${workRepo.repo}#${ref}`, '=>', downloadUrl);
			}
			if (!downloadUrl) {
				return { error: `Could not get a download URL for ${fragment}.` };
			}
			const url = `${meiFriendUrl}/?file=${encodeURIComponent(downloadUrl)}${meiParam}`;

			const mine = parseLockCsv((await f.getRepoFile(owner, repo, LOCK_PATH)) ?? '').some(
				(l) => l.task_id === task_id && l.subtask_id === '' && l.kind === 'encoding' && l.user_id === viewer
			);
			let prUrl: string | undefined;
			let message = 'Opening the score in mei-friend. After committing there, use “Submit encoding”.';
			if (task.status === 'encoding_required' && !mine) {
				ctx.progress('Opening the encoding claim PR…');
				const pr = await openClaimPr(ctx, task_id, '', 'encoding', envelope);
				console.log('[editor] encoding claim PR opened', pr.number, pr.html_url);
				prUrl = pr.html_url;
				const verdict = await waitForPrProcessed(ctx, pr.number);
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
		const { forge: f, owner, repo, viewer } = ctx;
		try {
			ctx.progress('Opening the submission PR…');
			const { branch: base, canPush } = await f.getRepoHead(owner, repo);
			// The claim/editor flow put the encoding on `encode-<task_id>` — in the
			// campaign repo for owners/collaborators, in the volunteer's fork
			// otherwise — so the head is fully determined; nothing to guess.
			let head: string;
			if (canPush) {
				head = `encode-${task_id}`;
			} else {
				const fork = await f.ensureFork(owner, repo);
				head = `${fork.owner}:encode-${task_id}`;
			}
			const body = `Submits the encoding of ${task_id} by @${viewer}, edited in mei-friend. Opened from the campaign console.`;
			console.log('[submitpr] opening PR', { head, base });
			const pr = await f.createPullRequest(owner, repo, {
				title: `Encoding of ${task_id}`,
				head,
				base,
				body: envelope ? appendEnvelopeToPrBody(body, envelope) : body
			});
			console.log('[submitpr] submission PR opened', pr.number, pr.html_url);
			const verdict = await waitForPrProcessed(ctx, pr.number);
			return verdictResult(verdict, pr.number, pr.html_url, `Opened submission PR #${pr.number} for ${task_id}.`);
		} catch (e) {
			return { error: `Submission PR failed: ${(e as Error).message}` };
		}
	}
};

// Open a PR that sets the subtask's first open validation cell (pass/fail).
const submitValidation: CommandDef<{ task_id: string; subtask_id: string; verdict: string }, Result> = {
	id: 'campaign.submitValidation',
	version: 1,
	log: 'pr',
	async run({ task_id, subtask_id, verdict }, ctx, envelope) {
		const { forge: f, owner, repo } = ctx;
		try {
			const state = parseStateCsv((await f.getRepoFile(owner, repo, STATE_PATH)) ?? '');
			const row = findRow(state.rows, task_id, subtask_id);
			if (!row) return { error: `Unknown subtask ${task_id}/${subtask_id}.` };
			const slot = state.validationColumns.find((c) => (row[c] ?? '') === '');
			if (!slot) {
				return { error: `No open validation slot on ${task_id}/${subtask_id}.` };
			}
			row[slot] = verdict; // the Action re-authors this to `verdict|user|time`
			ctx.progress('Opening the validation PR…');
			const body = `Submits a ${verdict} validation for ${task_id}/${subtask_id}. Opened from the campaign console.`;
			console.log('[validate] opening validation PR', { task_id, subtask_id, verdict, slot });
			const pr = await f.openChangePr(owner, repo, {
				branch: `validate-${task_id}-${subtask_id}-${rand()}`,
				files: [{ path: STATE_PATH, content: serializeStateCsv(state) }],
				message: `Validate ${task_id}/${subtask_id} (${verdict})`,
				title: `Validate ${task_id}/${subtask_id} (${verdict})`,
				body: envelope ? appendEnvelopeToPrBody(body, envelope) : body
			});
			console.log('[validate] validation PR opened', pr.number, pr.html_url);
			const outcome = await waitForPrProcessed(ctx, pr.number);
			return verdictResult(
				outcome,
				pr.number,
				pr.html_url,
				`Opened validation PR #${pr.number} for ${task_id}/${subtask_id} (${verdict}).`
			);
		} catch (e) {
			return { error: `Validate failed: ${(e as Error).message}` };
		}
	}
};

// Just the tokenised raw URL of the score (no claim).
const rawLink: CommandDef<{ task_id: string }, Result> = {
	id: 'campaign.rawLink',
	version: 1,
	log: 'none',
	async run({ task_id }, ctx) {
		const { forge: f, owner, repo } = ctx;
		try {
			const taskCsv = await f.getRepoFile(owner, repo, TASK_PATH);
			const fragment = findRow(parseTaskCsv(taskCsv ?? ''), task_id, '')?.fragment;
			if (!fragment) return { error: `Unknown task ${task_id}.` };
			ctx.progress('Fetching the raw link…');
			console.log('[rawlink] fetching raw link for', task_id, 'fragment', fragment);
			const rawUrl = await f.getRepoFileDownloadUrl(owner, repo, fragment);
			if (!rawUrl) return { error: `Could not get a raw link for ${fragment}.` };
			return { ok: true, rawUrl, message: `Raw link for ${fragment}:` };
		} catch (e) {
			return { error: `Raw link failed: ${(e as Error).message}` };
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
			ctx.progress('Dispatching the stale-lock reaper…');
			const { branch } = await f.getRepoHead(owner, repo);
			const dispatchedAt = Date.now();
			console.log('[reaper] dispatching caller.yml on', branch);
			await f.dispatchWorkflow(owner, repo, 'caller.yml', branch);
			ctx.progress('Waiting for the reaper run to finish…');
			const deadline = Date.now() + 90_000;
			while (Date.now() < deadline) {
				await sleep(3000);
				const runInfo = await f.getLatestWorkflowRun(owner, repo, 'caller.yml', 'workflow_dispatch');
				// Only a run created after our dispatch counts (15s clock-skew slack).
				if (
					runInfo &&
					Date.parse(runInfo.created_at) >= dispatchedAt - 15_000 &&
					runInfo.status === 'completed'
				) {
					console.log('[reaper] run finished with conclusion:', runInfo.conclusion);
					if (runInfo.conclusion !== 'success') {
						return {
							error: `The reaper run finished with "${runInfo.conclusion}" — check the repository's Actions log.`
						};
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
	/** Who submitted the task's work ('' while unsubmitted). Encoders cannot validate it. */
	encoder: string;
	/** The task's validation subtask, so the editor can drive the review too. */
	validation: {
		subtask_id: string;
		status: string;
		/** Who holds the subtask's active validation lock ('' when unclaimed). */
		lockUser: string;
	} | null;
}

const readFacsimile: CommandDef<{ task_id: string }, FacsimileTaskData> = {
	id: 'campaign.readFacsimile',
	version: 1,
	log: 'none',
	async run({ task_id }, ctx) {
		const { forge: f, owner, repo, viewer } = ctx;
		const [taskCsv, stateCsv, lockCsv] = await Promise.all([
			f.getRepoFile(owner, repo, TASK_PATH),
			f.getRepoFile(owner, repo, STATE_PATH),
			f.getRepoFile(owner, repo, LOCK_PATH)
		]);
		const task = findRow(parseTaskCsv(taskCsv ?? ''), task_id, '');
		if (!task) throw new Error(`Unknown task ${task_id}.`);
		const mei = await f.getRepoFile(owner, repo, task.fragment);
		if (mei == null) throw new Error(`Could not read ${task.fragment}.`);
		const model = parseFacsimileMei(mei);
		// graphic @target is resolved relative to the score file (MEI spec).
		const dir = task.fragment.replace(/[^/]*$/, '');
		const imageUrls = await Promise.all(
			model.pages.map((p) => f.getRepoFileDownloadUrl(owner, repo, dir + p.image).then((u) => u ?? ''))
		);
		const locks = parseLockCsv(lockCsv ?? '');
		const holdsLock = locks.some(
			(l) => l.task_id === task_id && l.subtask_id === '' && l.kind === 'encoding' && l.user_id === viewer
		);
		const stateRows = parseStateCsv(stateCsv ?? '').rows;
		const taskState = findRow(stateRows, task_id, '');
		const subRow = stateRows.find((r) => r.task_id === task_id && r.subtask_id !== '');
		const validation = subRow
			? {
					subtask_id: subRow.subtask_id,
					status: subRow.status,
					lockUser:
						locks.find(
							(l) =>
								l.task_id === task_id && l.subtask_id === subRow.subtask_id && l.kind === 'validation'
						)?.user_id ?? ''
				}
			: null;
		return {
			model,
			imageUrls,
			fragment: task.fragment,
			locator: task.locator,
			status: taskState?.status ?? '',
			holdsLock,
			encoder: taskState?.encoder ?? '',
			validation
		};
	}
};

// Claim a task for encoding-kind work without a mei-friend hand-off — the
// zone editor's claim path for the facsimile pre-tasks.
const claimTask: CommandDef<{ task_id: string }, Result> = {
	id: 'campaign.claimTask',
	version: 1,
	log: 'pr',
	async run({ task_id }, ctx, envelope) {
		try {
			ctx.progress('Opening claim PR…');
			const pr = await openClaimPr(ctx, task_id, '', 'encoding', envelope);
			console.log('[claim] claim PR opened', pr.number, pr.html_url);
			const verdict = await waitForPrProcessed(ctx, pr.number);
			return verdictResult(verdict, pr.number, pr.html_url, `Opened claim PR #${pr.number} for ${task_id} (encoding).`);
		} catch (e) {
			return { error: `Claim failed: ${(e as Error).message}` };
		}
	}
};

// Open the PR carrying a rewritten score, wait for the automation's verdict.
// Shared by the pre-task submissions; the current file's <meiHead> is carried
// over verbatim.
//
// Each pre-task advances the score by at least one stage (measure correction →
// stage C with generated measures, breaks and movements; the legacy breaks
// task → stage C from stage B), so the submitted content always differs from
// the file in the repo — even when the volunteer changed nothing, since the
// new stage adds elements the previous one lacked. That guaranteed diff is
// what makes the caller's path-filtered pull_request_target trigger; an
// identical file would open an empty PR that never runs the automation.
async function submitFacsimile(
	ctx: CommandContext,
	task_id: string,
	pages: PageModel[],
	envelope: CommandEnvelope | null,
	build: { withMeasures?: boolean; withBreaks?: boolean },
	what: 'zones' | 'breaks'
): Promise<Result> {
	const { forge: f, owner, repo } = ctx;
	try {
		const taskCsv = await f.getRepoFile(owner, repo, TASK_PATH);
		const fragment = findRow(parseTaskCsv(taskCsv ?? ''), task_id, '')?.fragment;
		if (!fragment) return { error: `Unknown task ${task_id}.` };
		const current = await f.getRepoFile(owner, repo, fragment);
		if (current == null) return { error: `Could not read ${fragment}.` };
		const content = buildFacsimileMei({ headXml: parseFacsimileMei(current).headXml, pages }, build);
		// A no-op would open an empty PR the path-filtered caller never runs;
		// guard against that rather than leaving the console polling forever.
		if (content === current) {
			return { ok: true, warn: true, message: 'Nothing to submit — the score already matches this step.' };
		}
		ctx.progress(`Opening the ${what} PR…`);
		const title = what === 'breaks'
			? `Add page/system breaks (${task_id})`
			: `Correct measure zones (${task_id})`;
		const body = `${title}. Opened from the zone editor.`;
		console.log(`[${what}] opening PR`, { task_id });
		const pr = await f.openChangePr(owner, repo, {
			branch: `${what}-${task_id}-${rand()}`,
			files: [{ path: fragment, content }],
			message: title,
			title,
			body: envelope ? appendEnvelopeToPrBody(body, envelope) : body
		});
		console.log(`[${what}] PR opened`, pr.number, pr.html_url);
		const verdict = await waitForPrProcessed(ctx, pr.number);
		return verdictResult(verdict, pr.number, pr.html_url, `Opened submission PR #${pr.number} for ${task_id}.`);
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
		submitFacsimile(ctx, task_id, pages, envelope, { withBreaks: true }, 'zones')
};

// Breaks: submit stage C — the measures plus a <pb/> per page and an <sb/>
// before each measure flagged as starting a system.
const submitBreaks: CommandDef<{ task_id: string; pages: PageModel[] }, Result> = {
	id: 'campaign.submitBreaks',
	version: 1,
	log: 'pr',
	envelopeInput: ({ task_id, pages }) => ({
		task_id,
		systems: pages.reduce((n, p) => n + p.zones.filter((z) => z.sb).length, 0)
	}),
	run: ({ task_id, pages }, ctx, envelope) =>
		submitFacsimile(ctx, task_id, pages, envelope, { withBreaks: true }, 'breaks')
};

/** The console command registry. */
export const commands = {
	readTables,
	claimValidation,
	openEditor,
	submitEncoding,
	submitValidation,
	rawLink,
	runReaper,
	readFacsimile,
	claimTask,
	submitZones,
	submitBreaks
};
