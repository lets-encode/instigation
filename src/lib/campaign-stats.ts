// Cross-campaign statistics for the dashboard views: per campaign, the
// tracking tables condensed into the numbers a tile or card shows (progress,
// claimable tasks, activity), plus the raw tables so the personal dashboard
// can pull one user's work out of them. Derivations are pure functions of the
// tables; loadCampaignStats does the fetching and caches per repo id.

import { blockedBy, buildGraph, isPreTask, taskThreshold } from './campaign-graph.ts';
import type { GraphData } from './campaign-graph.ts';
import { cardTitle } from './campaign-board.ts';
import {
	configFlag,
	configNumber,
	configPieces,
	passThresholdOf,
	configString,
	findRow,
	isFinalValidation,
	parseCommentCsv,
	parseHistoryCsv,
	parseLockCsv,
	parseStateCsv,
	parseTaskCsv,
	pieceNamesOf,
	resolveLogins
} from './campaign-tables.ts';
import type { CommentRow, HistoryRow, LockRow, PieceNames, StateRow, TaskRow } from './campaign-tables.ts';
import { parseMeiHeader } from './mei-header.ts';
import { parseFacsimileMei } from './mei-facsimile.ts';
import { resolveFacsimileImageUrls } from './facsimile-images.ts';
import type { ForgeClient } from './forge/types.ts';
import { RateLimitError } from './forge/github-rest.ts';
import type { RepoSummary } from './forge/github-rest.ts';

/** One campaign's tracking tables condensed for the dashboard views. */
export interface CampaignStats {
	repoId: number;
	owner: string;
	repo: string;
	/** The campaign's slug — its /<name> address. */
	name: string;
	isPrivate: boolean;
	/** campaign.title from config.yaml; falls back to the repo name. */
	title: string;
	composer: string;
	/** Facsimile page count; 0 when unknown. */
	pages: number;
	done: number;
	total: number;
	/** Tasks claimable right now: encoding_required, unlocked, not blocked. */
	ready: number;
	/** Tasks with a validation slot open to claim right now. */
	toValidate: number;
	nearlyDone: boolean;
	/** Distinct account ids the history records, most recent first. */
	contributorIds: string[];
	/** Account id → login for the ids above (missing = show the id). */
	logins: Record<string, string>;
	/** ISO timestamp of the last history entry; '' when there is none. */
	lastActivity: string;
	/** The repository's creation time (first history entry as fallback); '' unknown. */
	createdAt: string;
	/** locking.stale_after_minutes from config.yaml. */
	staleAfterMinutes: number;
	/** validation.allow_self_validation from config.yaml. */
	allowSelfValidation: boolean;
	/** A facsimile page image for the tile preview, or null. */
	preview: { url: string; page: number } | null;
	/** Fragment path → piece display name, from the config's pieces list. */
	pieceNames: PieceNames;
	// The raw tables, for the my-work projections.
	taskDefs: TaskRow[];
	rows: StateRow[];
	validationColumns: string[];
	locks: LockRow[];
	history: HistoryRow[];
	comments: CommentRow[];
	passThreshold: number;
}

/** Tasks claimable right now (unclaimed, unblocked encoding_required). */
export function readyCount(d: Pick<GraphData, 'taskDefs' | 'rows' | 'locks'>): number {
	return d.rows.filter(
		(r) =>
			r.subtask_id === '' &&
			r.status === 'encoding_required' &&
			!blockedBy(d as GraphData, r.task_id) &&
			!d.locks.some((l) => l.task_id === r.task_id && l.subtask_id === '' && l.kind === 'encoding')
	).length;
}

/** Tasks with a validation slot open to claim (a slot neither decided nor locked). */
export function validationReadyCount(
	d: Pick<GraphData, 'rows' | 'validationColumns' | 'locks'>
): number {
	const hasOpenSlot = (r: StateRow): boolean => {
		const finals = d.validationColumns.filter((c) => isFinalValidation(r[c] ?? '')).length;
		const held = d.locks.filter(
			(l) => l.task_id === r.task_id && l.subtask_id === r.subtask_id && l.kind === 'validation'
		).length;
		return finals + held < d.validationColumns.length;
	};
	const tasks = new Set(
		d.rows
			.filter((r) => r.subtask_id !== '' && r.status === 'validation_required' && hasOpenSlot(r))
			.map((r) => r.task_id)
	);
	return tasks.size;
}

// A campaign counts as nearly done from 80% task completion.
export const isNearlyDone = (done: number, total: number): boolean =>
	total > 0 && done < total && done / total >= 0.8;

/** A campaign's suggested next task on the overview listing. */
export interface NextTask {
	task: string;
	title: string;
	locator: string;
	pre: boolean;
	/**
	 * What acting on the task means for the viewer: claim the encoding, claim
	 * the open review slot, or continue work they already hold. '' when the
	 * task is open to others but not this viewer — shown without an action.
	 */
	action: 'encode' | 'review' | 'continue' | '';
	/** The open review slot's subtask id (action 'review'); '' otherwise. */
	subtask: string;
	/** The work's stage, for labelling the suggestion. */
	kind: 'score setup' | 'measure correction' | 'encoding' | 'validation';
}

const workKind = (locator: string): NextTask['kind'] =>
	locator === 'score-setup'
		? 'score setup'
		: locator === 'measure-zones'
			? 'measure correction'
			: 'encoding';

/**
 * The campaign's suggested next task: the first task the viewer can act on
 * (work they hold, an open encoding claim, or a validation slot they may
 * take), else the first task open to anyone — for logged-out viewers, and for
 * viewers the remaining open tasks are closed to. Null when nothing is open.
 */
export function nextTask(stats: CampaignStats, viewer: string): NextTask | null {
	const d: GraphData = {
		taskDefs: stats.taskDefs,
		rows: stats.rows,
		validationColumns: stats.validationColumns,
		locks: stats.locks,
		passThreshold: stats.passThreshold,
		allowSelfValidation: stats.allowSelfValidation
	};
	const nodes = buildGraph(d, viewer);
	const describe = (task: string): Omit<NextTask, 'action' | 'subtask' | 'kind'> => {
		const def = findRow(stats.taskDefs, task, '');
		const locator = def?.locator ?? '';
		return {
			task,
			title: def ? cardTitle(def.fragment, locator, stats.pieceNames) : task,
			locator,
			pre: isPreTask(locator)
		};
	};
	const mine = nodes.find((n) => n.nextUp);
	if (mine) {
		const base = describe(mine.task);
		if (mine.statusKey === 'encoding_required')
			return { ...base, action: 'encode', subtask: '', kind: workKind(base.locator) };
		const slot = mine.slots.find((s) => s.claimable);
		if (slot) return { ...base, action: 'review', subtask: slot.sub, kind: 'validation' };
		// Held work: the lock says whether the viewer encodes or validates.
		const held = stats.locks.find((l) => l.task_id === mine.task && l.user_id === viewer);
		return {
			...base,
			action: 'continue',
			subtask: '',
			kind: held?.kind === 'validation' ? 'validation' : workKind(base.locator)
		};
	}
	const open = nodes.find(
		(n) =>
			n.statusKey === 'encoding_required' ||
			(n.statusKey === 'validation_required' && n.slots.some((s) => s.key === 'open'))
	);
	if (!open) return null;
	const base = describe(open.task);
	return {
		...base,
		action: '',
		subtask: '',
		kind: open.statusKey === 'validation_required' ? 'validation' : workKind(base.locator)
	};
}

// ---------------------------------------------------------------------------
// Fetching

const cache = new Map<number, Promise<CampaignStats>>();

/** Drop the cached stats so the next load re-reads the tables. */
export function invalidateStats(repoId?: number): void {
	if (repoId === undefined) cache.clear();
	else cache.delete(repoId);
}

/**
 * Load one campaign's stats, cached per repo id for the session. `withPreview`
 * additionally fetches the first fragment's facsimile for a tile image (two
 * extra requests); a cached entry without a preview is upgraded when one is
 * asked for.
 */
export function loadCampaignStats(
	f: ForgeClient,
	summary: RepoSummary,
	withPreview = false
): Promise<CampaignStats> {
	const cached = cache.get(summary.id);
	if (cached) {
		if (!withPreview) return cached;
		const upgraded = cached.then(async (stats) => {
			if (stats.preview) return stats;
			return { ...stats, preview: await loadPreview(f, stats) };
		});
		cache.set(summary.id, upgraded);
		return upgraded;
	}
	const loading = fetchStats(f, summary, withPreview);
	cache.set(summary.id, loading);
	loading.catch(() => cache.delete(summary.id));
	return loading;
}

/** The campaign listing: what loaded, and how many repositories did not. */
export interface CampaignListing {
	stats: CampaignStats[];
	/** Repositories the search found whose tables could not be read. */
	failed: number;
	/** Why (the first failure — a rate-limit one preferred); '' when none. */
	failureMessage: string;
}

/**
 * Load the stats of every campaign the topic search finds. A failed search
 * throws; an unreadable repository is skipped rather than taking the listing
 * down, but reported in the result so the caller can say so — and when the
 * search found repositories and not one of them could be read, that is a
 * failure of the listing itself (typically the anonymous rate limit), and it
 * throws rather than posing as an empty database. `onEach` streams results as
 * they land, for grids that fill in progressively.
 */
export async function loadAllCampaignStats(
	f: ForgeClient,
	topic: string,
	opts: { withPreview?: boolean; onEach?: (stats: CampaignStats) => void } = {}
): Promise<CampaignListing> {
	const repos = await f.searchReposByTopic(topic);
	const errors: unknown[] = [];
	const all = await Promise.all(
		repos.map(async (repo) => {
			try {
				const stats = await loadCampaignStats(f, repo, opts.withPreview ?? false);
				opts.onEach?.(stats);
				return stats;
			} catch (err) {
				errors.push(err);
				return null;
			}
		})
	);
	const loaded = all.filter((stats): stats is CampaignStats => stats !== null);
	// A rate-limit error carries the retry time — surface that one first.
	const cause = errors.find((e) => e instanceof RateLimitError) ?? errors[0];
	if (repos.length > 0 && loaded.length === 0) throw cause;
	return {
		stats: loaded,
		failed: errors.length,
		failureMessage: errors.length ? ((cause as Error)?.message ?? String(cause)) : ''
	};
}

async function fetchStats(
	f: ForgeClient,
	summary: RepoSummary,
	withPreview: boolean
): Promise<CampaignStats> {
	const owner = summary.owner ?? summary.full_name.split('/')[0];
	const repo = summary.name;
	const [taskCsv, stateCsv, lockCsv, historyCsv, commentCsv, configYaml] = await Promise.all([
		f.getRepoFile(owner, repo, 'tracking/task.csv'),
		f.getRepoFile(owner, repo, 'tracking/state.csv'),
		f.getRepoFile(owner, repo, 'tracking/lock.csv'),
		f.getRepoFile(owner, repo, 'tracking/history.csv'),
		f.getRepoFile(owner, repo, 'tracking/comment.csv'),
		f.getRepoFile(owner, repo, 'config.yaml')
	]);
	const taskDefs = taskCsv ? parseTaskCsv(taskCsv) : [];
	const state = stateCsv ? parseStateCsv(stateCsv) : { header: [], validationColumns: [], rows: [] };
	const locks = lockCsv ? parseLockCsv(lockCsv) : [];
	const history = historyCsv ? parseHistoryCsv(historyCsv) : [];
	const comments = commentCsv ? parseCommentCsv(commentCsv) : [];
	const yaml = configYaml ?? '';

	const tasks = state.rows.filter((r) => r.subtask_id === '');
	const done = tasks.filter((r) => r.status === 'completed').length;

	// Contributors, most recent first.
	const contributorIds: string[] = [];
	for (let i = history.length - 1; i >= 0; i--) {
		const id = history[i].user_id;
		if (id && !contributorIds.includes(id)) contributorIds.push(id);
	}
	// Everyone the dashboard may need to name; lookups are memoised in the
	// forge client.
	const logins = await resolveLogins((n) => f.getUserLogin(n), {
		rows: state.rows,
		locks,
		history,
		comments
	});

	// Page count: the highest per-page locator, when the plan has any.
	const pages = taskDefs.reduce((max, t) => {
		const m = /^surface-(\d+)$/.exec(t.locator);
		return m ? Math.max(max, Number(m[1])) : max;
	}, 0);

	const passThreshold = passThresholdOf(yaml, state.validationColumns.length);
	const staleAfterMinutes = configNumber(yaml, 'stale_after_minutes', 0);

	// The composer from config's source header; the score header is the
	// fallback, read together with the preview to avoid an extra fetch.
	let composer = configString(yaml, 'composer');

	const stats: CampaignStats = {
		repoId: summary.id,
		owner,
		repo,
		// The slug comes from the config (campaign.name), which — like the
		// registry — survives a repo rename; the repo name is the fallback.
		name: configString(yaml, 'name') || summary.name,
		isPrivate: summary.private,
		title: configString(yaml, 'title') || summary.name,
		composer,
		pages,
		done,
		total: tasks.length,
		ready: readyCount({ taskDefs, rows: state.rows, locks }),
		toValidate: validationReadyCount({
			rows: state.rows,
			validationColumns: state.validationColumns,
			locks
		}),
		nearlyDone: isNearlyDone(done, tasks.length),
		contributorIds,
		logins,
		lastActivity: history.at(-1)?.timestamp ?? '',
		createdAt: summary.created_at || history[0]?.timestamp || '',
		staleAfterMinutes,
		allowSelfValidation: configFlag(yaml, 'allow_self_validation'),
		preview: null,
		pieceNames: pieceNamesOf(configPieces(yaml)),
		taskDefs,
		rows: state.rows,
		validationColumns: state.validationColumns,
		locks,
		history,
		comments,
		passThreshold
	};
	if (withPreview) {
		const loaded = await loadScoreExtras(f, stats);
		stats.preview = loaded.preview;
		if (!stats.composer) stats.composer = loaded.composer;
	}
	return stats;
}

// The first fragment's facsimile image (for the tile) and its header composer.
async function loadScoreExtras(
	f: ForgeClient,
	stats: Pick<CampaignStats, 'owner' | 'repo' | 'taskDefs'>
): Promise<{ preview: CampaignStats['preview']; composer: string }> {
	const fragment = stats.taskDefs.find((t) => t.fragment)?.fragment;
	if (!fragment) return { preview: null, composer: '' };
	try {
		const mei = await f.getRepoFile(stats.owner, stats.repo, fragment);
		if (!mei) return { preview: null, composer: '' };
		const composer = parseMeiHeader(mei)?.composer ?? '';
		const model = parseFacsimileMei(mei);
		const pageIndex = model.pages.findIndex((p) => p.image);
		if (pageIndex < 0) return { preview: null, composer };
		const urls = await resolveFacsimileImageUrls(f, stats.owner, stats.repo, fragment, [
			model.pages[pageIndex].image
		]);
		return {
			preview: urls[0] ? { url: urls[0], page: pageIndex + 1 } : null,
			composer
		};
	} catch {
		return { preview: null, composer: '' };
	}
}

async function loadPreview(f: ForgeClient, stats: CampaignStats): Promise<CampaignStats['preview']> {
	return (await loadScoreExtras(f, stats)).preview;
}

// ---------------------------------------------------------------------------
// One user's work across campaigns

/** One task of the viewer's, grouped for the personal dashboard. */
export interface MyTask {
	group: 'fix' | 'encoding' | 'validating' | 'awaiting' | 'done';
	campaign: string;
	campaignSlug: string;
	repoPath: string;
	task: string;
	title: string;
	/** The claim's ISO timestamp (encoding group). */
	claimedAt: string;
	/** When the claim goes stale (ISO); '' when the reaper is not configured. */
	expiresAt: string;
	/** Fail/awaiting groups: validation progress on the task's subtasks. */
	passes: number;
	threshold: number;
	/** Slot dots for the awaiting group. */
	dots: Array<'pass' | 'fail' | 'open'>;
	/** The latest unresolved fail comment (fix group), or null. */
	failComment: CommentRow | null;
	/** When the encoding was submitted (awaiting/done groups). */
	submittedAt: string;
	logins: Record<string, string>;
}

/** One entry of the comments feed: a comment on a task the viewer encoded. */
export interface FeedComment {
	comment: CommentRow;
	campaignSlug: string;
	task: string;
	taskTitle: string;
	logins: Record<string, string>;
}

/** Tasks whose latest validation round records a fail (fix requested). */
export function attentionCount(stats: CampaignStats): number {
	return stats.rows.filter(
		(r) =>
			r.subtask_id === '' &&
			r.status === 'validation_required' &&
			taskFailCells(stats, r.task_id).length > 0
	).length;
}

const taskFailCells = (stats: CampaignStats, task: string): string[] =>
	stats.rows
		.filter((r) => r.task_id === task && r.subtask_id !== '')
		.flatMap((r) => stats.validationColumns.map((c) => r[c] ?? ''))
		.filter((cell) => isFinalValidation(cell) && cell.startsWith('fail|'));

/** The viewer's tasks in one campaign, grouped by what needs doing. */
export function myTasksIn(stats: CampaignStats, viewer: string): MyTask[] {
	if (!viewer) return [];
	const out: MyTask[] = [];
	const base = (task: string): Omit<MyTask, 'group'> => {
		const def = findRow(stats.taskDefs, task, '');
		const subRows = stats.rows.filter((r) => r.task_id === task && r.subtask_id !== '');
		const cells = subRows.flatMap((r) => stats.validationColumns.map((c) => r[c] ?? ''));
		const dots = cells.map((cell) =>
			isFinalValidation(cell) ? (cell.startsWith('pass|') ? ('pass' as const) : ('fail' as const)) : ('open' as const)
		);
		return {
			campaign: stats.title,
			campaignSlug: stats.name,
			repoPath: `${stats.owner}/${stats.repo}`,
			task,
			title: def ? cardTitle(def.fragment, def.locator, stats.pieceNames) : task,
			claimedAt: '',
			expiresAt: '',
			passes: dots.filter((d) => d === 'pass').length,
			threshold: taskThreshold(stats.passThreshold, subRows.length),
			dots,
			failComment: null,
			submittedAt: findRow(stats.rows, task, '')?.encoded_at ?? '',
			logins: stats.logins
		};
	};

	// Held claims → "encoding now" / "validating now", with the reaper-derived expiry.
	const lockExpiry = (lock: LockRow): string =>
		stats.staleAfterMinutes > 0 && Number.isFinite(Date.parse(lock.timestamp))
			? new Date(Date.parse(lock.timestamp) + stats.staleAfterMinutes * 60_000).toISOString()
			: '';
	for (const lock of stats.locks) {
		if (lock.user_id !== viewer) continue;
		if (lock.kind === 'encoding' && lock.subtask_id === '') {
			out.push({ ...base(lock.task_id), group: 'encoding', claimedAt: lock.timestamp, expiresAt: lockExpiry(lock) });
		} else if (lock.kind === 'validation') {
			out.push({ ...base(lock.task_id), group: 'validating', claimedAt: lock.timestamp, expiresAt: lockExpiry(lock) });
		}
	}

	// Tasks the viewer encoded: failed → fix requested, else awaiting / done.
	for (const row of stats.rows) {
		if (row.subtask_id !== '' || row.encoder !== viewer) continue;
		if (row.status === 'completed') {
			out.push({ ...base(row.task_id), group: 'done' });
			continue;
		}
		if (row.status !== 'validation_required') continue;
		const fails = taskFailCells(stats, row.task_id);
		if (fails.length > 0) {
			const failTs = new Set(fails.map((cell) => cell.split('|')[2]));
			const comment =
				stats.comments
					.filter(
						(c) =>
							c.task_id === row.task_id && c.kind === 'fail' && c.resolved !== 'true' && failTs.has(c.timestamp)
					)
					.at(-1) ??
				stats.comments.filter((c) => c.task_id === row.task_id && c.kind === 'fail').at(-1) ??
				null;
			out.push({ ...base(row.task_id), group: 'fix', failComment: comment });
		} else {
			out.push({ ...base(row.task_id), group: 'awaiting' });
		}
	}
	return out;
}

/** Comments on the viewer's encodings in one campaign, written by others. */
export function commentsOnMyWork(stats: CampaignStats, viewer: string): FeedComment[] {
	if (!viewer) return [];
	const myTasks = new Set(
		stats.rows.filter((r) => r.subtask_id === '' && r.encoder === viewer).map((r) => r.task_id)
	);
	return stats.comments
		.filter((c) => myTasks.has(c.task_id) && c.author_id !== viewer)
		.map((c) => {
			const def = findRow(stats.taskDefs, c.task_id, '');
			return {
				comment: c,
				campaignSlug: stats.name,
				task: c.task_id,
				taskTitle: def ? cardTitle(def.fragment, def.locator, stats.pieceNames) : c.task_id,
				logins: stats.logins
			};
		});
}
