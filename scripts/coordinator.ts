// Campaign coordinator — the single entry point the generic caller runs.
// It branches on the triggering event (EVENT_NAME) and, for pull requests, on
// the PR's changed paths, then hands the decision to the pure modules and
// applies the result with optimistic concurrency. Every outcome — accepted,
// rejected, reaped — is appended to the campaign's history table.
// See DESIGN.md §4 (the caller) & §6 (PR contract).
//
// Runs in the BASE (campaign) repo's context with a write token. The pull
// request is treated purely as DATA: we read its changed-file patches and
// blobs via the API and never check out or execute anything the fork supplies.
//
// Env: GH_TOKEN, BASE_REPO ("owner/repo"), EVENT_NAME;
//      for pull_request_target additionally PR_NUMBER, PR_AUTHOR (numeric
//      account id — the canonical identity written to the tables), PR_AUTHOR_LOGIN
//      (login, for commit messages only), HEAD_REPO ("owner/repo" of the PR head),
//      HEAD_SHA, HEAD_REF.

import {
  parseTaskCsv,
  parseStateCsv,
  parseLockCsv,
  parseCommentCsv,
  serializeStateCsv,
  serializeLockCsv,
  serializeCommentCsv,
  appendComments,
  appendHistory,
} from "../src/lib/campaign-tables.ts";
import type {
  ParsedState,
  TaskRow,
  LockRow,
  HistoryRow,
  CommentRow,
} from "../src/lib/campaign-tables.ts";
import {
  envelopeFromPrBody,
  envelopeColumns,
} from "../src/lib/command-envelope.ts";
import type { CommandEnvelope } from "../src/lib/command-envelope.ts";
import { checkClaim } from "../src/lib/campaign-claim.ts";
import {
  checkComment,
  checkEncoding,
  checkResolveComment,
  checkSendBack,
  checkValidation,
} from "../src/lib/campaign-submit.ts";
import { splicePage, splicePageSpan } from "../src/lib/mei-page-splice.ts";
import { reapLocks } from "../src/lib/campaign-reaper.ts";
import {
  addedRowFromPatch,
  appendedComments,
  classifyPullRequest,
  numberFromConfig,
  pieceKindForPath,
  resolveEncodingTask,
  resolvedCommentDiff,
  shouldCleanupSubmission,
  singleCellDiff,
  taskResetDiff,
  validationVerdict,
} from "../src/lib/coordinator-policy.ts";
import {
  getRepoFile,
  getRepoHead,
  getPullRequestFiles,
  getPullRequestDetails,
  getCollaboratorCanPush,
  commitFiles,
  commentAndClosePr,
  deleteBranch,
  getGitHubRequestTelemetry,
} from "../src/lib/forge/github-rest.ts";
import type { FileChange } from "../src/lib/forge/github-rest.ts";
import { validateMei } from "./mei-validate.ts";

const token = process.env.GH_TOKEN ?? "";
const [owner, repo] = (process.env.BASE_REPO ?? "").split("/");
const eventName = process.env.EVENT_NAME ?? "";
const prNumber = Number(process.env.PR_NUMBER);
// The PR author's stable numeric account id — the identity written to the
// tracking tables (lock.user_id, state.encoder, validate_status, history).
const author = process.env.PR_AUTHOR ?? "";
// The PR author's login — for human-readable commit messages / co-author
// trailers only, never as a stored identity. Falls back to the id if absent.
const authorLogin = process.env.PR_AUTHOR_LOGIN ?? "";
const authorLabel = authorLogin || author;
const [headOwner, headRepo] = (process.env.HEAD_REPO ?? "").split("/");
const headSha = process.env.HEAD_SHA ?? "";
const headRef = process.env.HEAD_REF ?? "";

const TASK_PATH = "tracking/task.csv";
const STATE_PATH = "tracking/state.csv";
const LOCK_PATH = "tracking/lock.csv";
const HISTORY_PATH = "tracking/history.csv";
const COMMENT_PATH = "tracking/comment.csv";
const CONFIG_PATH = "config.yaml";
const MAX_ATTEMPTS = 3;
const DEFAULT_STALE_MINUTES = 120;

// A rejection's `reason` is the machine-readable code recorded in the history
// table; `detail` is the human explanation behind it, for the PR comment only.
type Verdict = { ok: boolean; reason?: string; detail?: string };

// ---------------------------------------------------------------------------
// Shared helpers

// Random id for a comment row the automation authors.
const newCommentId = (): string => crypto.randomUUID().slice(0, 8);

// Whether the PR author can push to the campaign repo — the privilege behind
// owner-only operations (send-back without a fail of one's own, resolving
// someone else's comment). A failed lookup means no.
async function authorCanPush(): Promise<boolean> {
  if (!authorLogin) return false;
  try {
    return await getCollaboratorCanPush(token, owner, repo, authorLogin);
  } catch (e) {
    console.warn(
      `Collaborator lookup for ${authorLogin} failed: ${(e as Error).message}`,
    );
    return false;
  }
}

// Delete the PR's head branch once we've closed it — but only when it lives in
// this repo (owner/collaborator PR). A volunteer's branch lives in their fork,
// which this token can't touch; it stays harmlessly in the fork.
async function cleanupHeadBranch(): Promise<void> {
  if (headOwner !== owner || headRepo !== repo || !headRef) return;
  try {
    await deleteBranch(token, owner, repo, headRef);
  } catch (e) {
    console.warn(`Branch cleanup skipped: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Claim (a PR adding one row to lock.csv)

async function attemptClaim(
  changedPaths: string[],
  intent: { task_id: string; subtask_id: string; kind: string } | null,
  envelope: CommandEnvelope | null,
): Promise<Verdict & { lock?: LockRow }> {
  const { branch, sha } = await getRepoHead(token, owner, repo);
  const [taskCsv, stateCsv, lockCsv, historyCsv, configText] =
    await Promise.all([
      getRepoFile(token, owner, repo, TASK_PATH, sha),
      getRepoFile(token, owner, repo, STATE_PATH, sha),
      getRepoFile(token, owner, repo, LOCK_PATH, sha),
      getRepoFile(token, owner, repo, HISTORY_PATH, sha),
      getRepoFile(token, owner, repo, CONFIG_PATH, sha),
    ]);
  const now = new Date().toISOString();
  const { kept: locks, removed } = reapLocks({
    locks: parseLockCsv(lockCsv ?? ""),
    staleAfterMinutes: numberFromConfig(
      configText,
      "stale_after_minutes",
      DEFAULT_STALE_MINUTES,
    ),
    now,
  });

  const verdict: Verdict & { lock?: LockRow } = intent
    ? checkClaim({
        tasks: parseTaskCsv(taskCsv ?? ""),
        state: parseStateCsv(stateCsv ?? ""),
        locks,
        intent,
        author,
        changedPaths,
        now,
      })
    : { ok: false, reason: "malformed_claim" };

  const reapedHistory: HistoryRow[] = removed.map((lock) => ({
    timestamp: now,
    task_id: lock.task_id,
    subtask_id: lock.subtask_id,
    user_id: lock.user_id,
    action: "reap",
    outcome: "released",
    detail: lock.kind,
  }));
  const history: HistoryRow = {
    timestamp: now,
    task_id: intent?.task_id ?? "",
    subtask_id: intent?.subtask_id ?? "",
    user_id: author,
    action: `claim_${intent?.kind || "unknown"}`,
    outcome: verdict.ok ? "accepted" : "rejected",
    detail: verdict.ok ? "" : verdict.reason!,
    ...envelopeColumns(envelope),
  };
  const files: FileChange[] = [
    {
      path: HISTORY_PATH,
      content: appendHistory(historyCsv ?? "", [...reapedHistory, history]),
    },
  ];
  if (verdict.ok || removed.length) {
    files.push({
      path: LOCK_PATH,
      content: serializeLockCsv(verdict.ok ? [...locks, verdict.lock!] : locks),
    });
  }

  const message = verdict.ok
    ? `Lock ${verdict.lock!.task_id}${verdict.lock!.subtask_id && "/" + verdict.lock!.subtask_id} for ${authorLabel} (${verdict.lock!.kind})`
    : `Reject claim by ${authorLabel} (${verdict.reason})`;
  // Non-fast-forward update fails if `main` moved since `sha` → we retry.
  await commitFiles(token, owner, repo, files, message, {
    baseSha: sha,
    branch,
  });
  return verdict;
}

async function runClaim(
  files: Awaited<ReturnType<typeof getPullRequestFiles>>,
  envelope: CommandEnvelope | null,
): Promise<void> {
  const changedPaths = files.map((f) => f.filename);
  const lockFile = files.find((f) => f.filename === LOCK_PATH);
  const addedRow = lockFile && addedRowFromPatch(lockFile.patch);
  const cells = addedRow ? addedRow.split(",") : null;
  const intent = cells
    ? {
        task_id: cells[0]?.trim() ?? "",
        subtask_id: cells[1]?.trim() ?? "",
        kind: cells[4]?.trim() ?? "",
      }
    : null;

  let verdict: Verdict & { lock?: LockRow } = {
    ok: false,
    reason: "malformed_claim",
  };
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    try {
      verdict = await attemptClaim(changedPaths, intent, envelope);
      break;
    } catch (e) {
      if (i === MAX_ATTEMPTS - 1) throw e;
      console.warn(
        `Apply raced (attempt ${i + 1}), retrying: ${(e as Error).message}`,
      );
    }
  }

  const target = verdict.lock
    ? `\`${verdict.lock.task_id}${verdict.lock.subtask_id && "/" + verdict.lock.subtask_id}\``
    : "";
  const body = verdict.ok
    ? `✅ Claim accepted — ${target} locked for ${authorLabel} (${verdict.lock!.kind}).`
    : `❌ Claim rejected: \`${verdict.reason}\`. No changes were made.`;
  await commentAndClosePr(token, owner, repo, prNumber, body);
  await cleanupHeadBranch();
}

// ---------------------------------------------------------------------------
// Submission (encoding: the PR edits the task's fragment; validation: the PR
// records a pass/fail in state.csv)

interface SubmitOutcome extends Verdict {
  files: FileChange[];
  message: string;
  history: HistoryRow;
}

async function decideEncoding(
  sha: string,
  tasks: TaskRow[],
  state: ParsedState,
  locks: LockRow[],
  changedPaths: string[],
  envelope: CommandEnvelope | null,
  now: string,
): Promise<
  Omit<SubmitOutcome, "files" | "message" | "history"> & Partial<SubmitOutcome>
> {
  const task = resolveEncodingTask({
    tasks,
    locks,
    changedPaths,
    envelope,
    headRef,
    author,
  });
  if (!task) return { ok: false, reason: "unknown_task" };

  // A page task (locator `surface-N`) contributes only its page: we splice the
  // fork's page into the base score, leaving other pages as they stand. A
  // facsimile piece's page is joined measure by measure (matched by xml:id —
  // its measure grid is fixed by the measure correction); a physical piece has
  // no grid, so its page span is taken from the fork wholesale. Whole-file
  // tasks (empty locator) and pre-tasks take the fork verbatim.
  //
  // Failing to assemble the MEI at all and assembling one the schema rejects
  // are both `mei_invalid` submissions; which of the two it was survives only
  // in `detail`, since the reason code is what the tables record.
  const isPageTask = task.locator.startsWith("surface-");
  const [forkMei, baseMei, configText] = await Promise.all([
    getRepoFile(token, headOwner, headRepo, task.fragment, headSha),
    isPageTask ? getRepoFile(token, owner, repo, task.fragment, sha) : null,
    isPageTask ? getRepoFile(token, owner, repo, CONFIG_PATH, sha) : null,
  ]);
  let mei = forkMei;
  let detail =
    forkMei == null ? `${task.fragment} is missing from the fork.` : "";
  if (forkMei != null && isPageTask) {
    if (baseMei == null) {
      mei = null;
      detail = `${task.fragment} is missing from the campaign.`;
    } else {
      try {
        const physical =
          pieceKindForPath(configText, task.fragment) === "physical-only";
        mei = physical
          ? splicePageSpan(baseMei, forkMei, task.locator)
          : splicePage(baseMei, forkMei, task.locator);
      } catch (err) {
        const message = (err as Error).message;
        console.warn(
          `Page splice failed for ${task.task_id} (${task.locator}): ${message}`,
        );
        mei = null;
        detail = `Could not splice page ${task.locator} into ${task.fragment}: ${message}`;
      }
    }
  }
  let meiValid = false;
  if (mei != null) {
    const check = await validateMei(mei);
    meiValid = check.ok;
    if (!check.ok) detail = `${task.fragment}:${check.error}`;
  }

  const verdict = checkEncoding({
    tasks,
    state,
    locks,
    intent: { task_id: task.task_id },
    author,
    changedPaths,
    meiValid,
    now,
  });

  const history: HistoryRow = {
    timestamp: now,
    task_id: task.task_id,
    subtask_id: "",
    user_id: author,
    action: "submit_encoding",
    outcome: verdict.ok ? "accepted" : "rejected",
    detail: verdict.ok ? "" : verdict.reason,
  };
  if (!verdict.ok) {
    return {
      ok: false,
      reason: verdict.reason,
      detail: verdict.reason === "mei_invalid" ? detail : "",
      history,
    };
  }

  return {
    ok: true,
    history,
    files: [
      { path: task.fragment, content: mei! },
      { path: STATE_PATH, content: serializeStateCsv(verdict.state) },
      { path: LOCK_PATH, content: serializeLockCsv(verdict.locks) },
    ],
    message: `Accept encoding of ${task.task_id} by ${authorLabel}\n\nCo-authored-by: ${authorLabel} <${author}+${authorLogin}@users.noreply.github.com>`,
  };
}

async function decideValidation(
  sha: string,
  state: ParsedState,
  locks: LockRow[],
  changedPaths: string[],
  now: string,
): Promise<
  Omit<SubmitOutcome, "files" | "message" | "history"> & Partial<SubmitOutcome>
> {
  const headStateCsv = await getRepoFile(
    token,
    headOwner,
    headRepo,
    STATE_PATH,
    headSha,
  );
  const headState = headStateCsv == null ? null : parseStateCsv(headStateCsv);
  const diff = headState == null ? null : singleCellDiff(state, headState);
  if (!diff) {
    // Not a single-verdict PR — a whole-task reset is a send-back.
    const reset = headState == null ? null : taskResetDiff(state, headState);
    if (reset)
      return decideSendBack(reset.task_id, state, locks, changedPaths, now);
    return { ok: false, reason: "malformed_validation" };
  }
  if (!state.validationColumns.includes(diff.column)) {
    return { ok: false, reason: "malformed_validation" };
  }
  const status = validationVerdict(diff.value);
  if (!status) return { ok: false, reason: "invalid_verdict" };

  // A fail's mandatory comment rides the same PR as one appended comment row.
  // The automation re-authors it — id, author and timestamp are never the
  // fork's values.
  let baseComments: CommentRow[] = [];
  let failComment: CommentRow | null = null;
  if (changedPaths.includes(COMMENT_PATH)) {
    const [baseCommentCsv, headCommentCsv] = await Promise.all([
      getRepoFile(token, owner, repo, COMMENT_PATH, sha),
      getRepoFile(token, headOwner, headRepo, COMMENT_PATH, headSha),
    ]);
    baseComments = parseCommentCsv(baseCommentCsv ?? "");
    const added =
      headCommentCsv == null
        ? null
        : appendedComments(baseComments, parseCommentCsv(headCommentCsv));
    failComment = added?.length === 1 ? added[0] : null;
  }

  const configText = await getRepoFile(token, owner, repo, CONFIG_PATH, sha);
  const verdict = checkValidation({
    state,
    locks,
    intent: {
      task_id: diff.task_id,
      subtask_id: diff.subtask_id,
      verdict: status,
    },
    author,
    changedPaths,
    passThreshold: numberFromConfig(
      configText,
      "pass_threshold",
      state.validationColumns.length,
    ),
    failComment,
    now,
  });

  const history: HistoryRow = {
    timestamp: now,
    task_id: diff.task_id,
    subtask_id: diff.subtask_id,
    user_id: author,
    action: "submit_validation",
    outcome: verdict.ok ? "accepted" : "rejected",
    detail: verdict.ok ? status : verdict.reason,
  };
  if (!verdict.ok) return { ok: false, reason: verdict.reason, history };

  const files: FileChange[] = [
    { path: STATE_PATH, content: serializeStateCsv(verdict.state) },
    { path: LOCK_PATH, content: serializeLockCsv(verdict.locks) },
  ];
  if (status === "fail") {
    const authoredComment: CommentRow = {
      ...failComment!,
      comment_id: newCommentId(),
      author_id: author,
      timestamp: now,
      resolved: "",
      parent_id: "",
    };
    files.push({
      path: COMMENT_PATH,
      content: serializeCommentCsv([...baseComments, authoredComment]),
    });
  }
  const message = `Record ${status} validation of ${diff.task_id}/${diff.subtask_id} by ${authorLabel}`;

  return { ok: true, history, files, message };
}

// A send-back PR: state.csv reset of one failed task, returning it to
// encoding. Allowed for a validator who recorded one of the task's fails, or
// anyone with push access.
async function decideSendBack(
  task_id: string,
  state: ParsedState,
  locks: LockRow[],
  changedPaths: string[],
  now: string,
): Promise<
  Omit<SubmitOutcome, "files" | "message" | "history"> & Partial<SubmitOutcome>
> {
  const verdict = checkSendBack({
    state,
    locks,
    intent: { task_id },
    author,
    changedPaths,
    isCollaborator: await authorCanPush(),
  });
  const history: HistoryRow = {
    timestamp: now,
    task_id,
    subtask_id: "",
    user_id: author,
    action: "send_back",
    outcome: verdict.ok ? "accepted" : "rejected",
    detail: verdict.ok ? "" : verdict.reason,
  };
  if (!verdict.ok) return { ok: false, reason: verdict.reason, history };
  return {
    ok: true,
    history,
    files: [
      { path: STATE_PATH, content: serializeStateCsv(verdict.state) },
      { path: LOCK_PATH, content: serializeLockCsv(verdict.locks) },
    ],
    message: `Send ${task_id} back for encoding (by ${authorLabel})`,
  };
}

// One decide-and-apply pass, pinned to the branch head we read. Throws only if
// the commit races (caller retries); returns the verdict otherwise.
async function attemptSubmit(
  kind: "encoding" | "validation",
  changedPaths: string[],
  envelope: CommandEnvelope | null,
): Promise<Verdict> {
  const { branch, sha } = await getRepoHead(token, owner, repo);
  const [taskCsv, stateCsv, lockCsv, historyCsv] = await Promise.all([
    getRepoFile(token, owner, repo, TASK_PATH, sha),
    getRepoFile(token, owner, repo, STATE_PATH, sha),
    getRepoFile(token, owner, repo, LOCK_PATH, sha),
    getRepoFile(token, owner, repo, HISTORY_PATH, sha),
  ]);
  const tasks = parseTaskCsv(taskCsv ?? "");
  const state = parseStateCsv(stateCsv ?? "");
  const locks = parseLockCsv(lockCsv ?? "");
  const now = new Date().toISOString();

  const outcome =
    kind === "validation"
      ? await decideValidation(sha, state, locks, changedPaths, now)
      : await decideEncoding(
          sha,
          tasks,
          state,
          locks,
          changedPaths,
          envelope,
          now,
        );

  const history: HistoryRow = {
    ...(outcome.history ?? {
      timestamp: now,
      task_id: "",
      subtask_id: "",
      user_id: author,
      action: `submit_${kind}`,
      outcome: "rejected",
      detail: outcome.reason ?? "rejected",
    }),
    ...envelopeColumns(envelope),
  };
  const files: FileChange[] = [
    ...(outcome.files ?? []),
    { path: HISTORY_PATH, content: appendHistory(historyCsv ?? "", [history]) },
  ];
  const message = outcome.ok
    ? outcome.message!
    : `Reject ${kind} submission by ${authorLabel} (${outcome.reason})`;
  await commitFiles(token, owner, repo, files, message, {
    baseSha: sha,
    branch,
  });
  return outcome;
}

async function runSubmit(
  kind: "encoding" | "validation",
  files: Awaited<ReturnType<typeof getPullRequestFiles>>,
  envelope: CommandEnvelope | null,
): Promise<void> {
  const changedPaths = files.map((f) => f.filename);

  let verdict: Verdict = { ok: false, reason: "no_changes" };
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    try {
      verdict = await attemptSubmit(kind, changedPaths, envelope);
      break;
    } catch (e) {
      if (i === MAX_ATTEMPTS - 1) throw e;
      console.warn(
        `Apply raced (attempt ${i + 1}), retrying: ${(e as Error).message}`,
      );
    }
  }

  const body = verdict.ok
    ? `✅ Submission accepted (${kind}).`
    : `❌ Submission rejected: \`${verdict.reason}\`. No changes were made.` +
      (verdict.detail ? ` ${verdict.detail}` : "");
  await commentAndClosePr(token, owner, repo, prNumber, body);
  if (shouldCleanupSubmission(kind, verdict.ok)) await cleanupHeadBranch();
}

// ---------------------------------------------------------------------------
// Comment (a PR appending one discussion row to comment.csv, or resolving one)

async function attemptComment(
  changedPaths: string[],
  envelope: CommandEnvelope | null,
): Promise<Verdict & { action: string }> {
  const { branch, sha } = await getRepoHead(token, owner, repo);
  const [stateCsv, commentCsv, historyCsv, headCommentCsv] = await Promise.all([
    getRepoFile(token, owner, repo, STATE_PATH, sha),
    getRepoFile(token, owner, repo, COMMENT_PATH, sha),
    getRepoFile(token, owner, repo, HISTORY_PATH, sha),
    getRepoFile(token, headOwner, headRepo, COMMENT_PATH, headSha),
  ]);
  const state = parseStateCsv(stateCsv ?? "");
  const comments = parseCommentCsv(commentCsv ?? "");
  const headComments =
    headCommentCsv == null ? null : parseCommentCsv(headCommentCsv);
  const now = new Date().toISOString();

  const added = headComments && appendedComments(comments, headComments);
  const resolved = headComments && resolvedCommentDiff(comments, headComments);
  let action = "submit_comment";
  let verdict: ReturnType<typeof checkComment>;
  let nextComments = comments;
  if (added) {
    verdict = checkComment({
      state,
      comments,
      added: added.length === 1 ? added[0] : null,
      author,
      changedPaths,
      now,
      newId: newCommentId(),
    });
    if (verdict.ok) nextComments = [...comments, verdict.row];
  } else if (resolved) {
    action = "resolve_comment";
    verdict = checkResolveComment({
      comments,
      comment_id: resolved.comment_id,
      author,
      changedPaths,
      isCollaborator: await authorCanPush(),
    });
    if (verdict.ok) {
      const resolvedRow = verdict.row;
      nextComments = comments.map((c) =>
        c.comment_id === resolved.comment_id ? resolvedRow : c,
      );
    }
  } else {
    verdict = { ok: false, reason: "malformed_comment" };
  }

  const row = verdict.ok ? verdict.row : null;
  const history: HistoryRow = {
    timestamp: now,
    task_id: row?.task_id ?? "",
    subtask_id: row?.subtask_id ?? "",
    user_id: author,
    action,
    outcome: verdict.ok ? "accepted" : "rejected",
    detail: verdict.ok ? row!.kind : verdict.reason,
    ...envelopeColumns(envelope),
  };
  const files: FileChange[] = [
    { path: HISTORY_PATH, content: appendHistory(historyCsv ?? "", [history]) },
  ];
  if (verdict.ok)
    files.push({
      path: COMMENT_PATH,
      content: serializeCommentCsv(nextComments),
    });
  const message = verdict.ok
    ? action === "resolve_comment"
      ? `Resolve comment ${row!.comment_id} (by ${authorLabel})`
      : `Record ${row!.kind} comment on ${row!.task_id} by ${authorLabel}`
    : `Reject comment by ${authorLabel} (${verdict.reason})`;
  await commitFiles(token, owner, repo, files, message, {
    baseSha: sha,
    branch,
  });
  return {
    ok: verdict.ok,
    reason: verdict.ok ? undefined : verdict.reason,
    action,
  };
}

async function runComment(
  files: Awaited<ReturnType<typeof getPullRequestFiles>>,
  envelope: CommandEnvelope | null,
): Promise<void> {
  const changedPaths = files.map((f) => f.filename);
  let verdict: Verdict & { action: string } = {
    ok: false,
    reason: "malformed_comment",
    action: "submit_comment",
  };
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    try {
      verdict = await attemptComment(changedPaths, envelope);
      break;
    } catch (e) {
      if (i === MAX_ATTEMPTS - 1) throw e;
      console.warn(
        `Apply raced (attempt ${i + 1}), retrying: ${(e as Error).message}`,
      );
    }
  }
  const body = verdict.ok
    ? verdict.action === "resolve_comment"
      ? "✅ Comment resolved."
      : "✅ Comment recorded."
    : `❌ Comment rejected: \`${verdict.reason}\`. No changes were made.`;
  await commentAndClosePr(token, owner, repo, prNumber, body);
  await cleanupHeadBranch();
}

// ---------------------------------------------------------------------------
// Reaper (scheduled / manually dispatched)

async function attemptReap(): Promise<void> {
  const { branch, sha } = await getRepoHead(token, owner, repo);
  const [lockCsv, historyCsv, configText] = await Promise.all([
    getRepoFile(token, owner, repo, LOCK_PATH, sha),
    getRepoFile(token, owner, repo, HISTORY_PATH, sha),
    getRepoFile(token, owner, repo, CONFIG_PATH, sha),
  ]);
  const now = new Date().toISOString();

  const { kept, removed } = reapLocks({
    locks: parseLockCsv(lockCsv ?? ""),
    staleAfterMinutes: numberFromConfig(
      configText,
      "stale_after_minutes",
      DEFAULT_STALE_MINUTES,
    ),
    now,
  });
  if (removed.length === 0) {
    console.log("No stale locks.");
    return;
  }

  const history: HistoryRow[] = removed.map((l) => ({
    timestamp: now,
    task_id: l.task_id,
    subtask_id: l.subtask_id,
    user_id: l.user_id,
    action: "reap",
    outcome: "released",
    detail: l.kind,
  }));
  await commitFiles(
    token,
    owner,
    repo,
    [
      { path: LOCK_PATH, content: serializeLockCsv(kept) },
      { path: HISTORY_PATH, content: appendHistory(historyCsv ?? "", history) },
    ],
    `Release ${removed.length} stale lock(s): ${removed.map((l) => l.task_id).join(", ")}`,
    { baseSha: sha, branch },
  );
  console.log(`Released ${removed.length} stale lock(s).`);
}

async function runReap(): Promise<void> {
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    try {
      await attemptReap();
      return;
    } catch (e) {
      if (i === MAX_ATTEMPTS - 1) throw e;
      console.warn(
        `Reap raced (attempt ${i + 1}), retrying: ${(e as Error).message}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Entry: route by event, then (for PRs) by the operation the changed paths imply
// — lock.csv → claim, state.csv → validation (or send-back), comment.csv alone
// → comment, anything else → encoding. The boundary check inside each decision
// rejects mixed or out-of-bounds PRs.

async function run(): Promise<void> {
  if (eventName === "schedule" || eventName === "workflow_dispatch") {
    return runReap();
  }
  if (eventName !== "pull_request_target") {
    throw new Error(`Unsupported event: ${eventName}`);
  }

  const details = await getPullRequestDetails(token, owner, repo, prNumber);
  const files = await getPullRequestFiles(
    token,
    owner,
    repo,
    prNumber,
    details.changedFiles,
  );
  // The PR body may carry the console command's envelope; treated as data,
  // it feeds the command columns of the history row this run authors.
  const envelope = envelopeFromPrBody(details.body);
  const changedPaths = files.map((f) => f.filename);
  const kind = classifyPullRequest(changedPaths);
  if (kind === "claim") return runClaim(files, envelope);
  if (kind === "comment") return runComment(files, envelope);
  return runSubmit(kind, files, envelope);
}

run()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() =>
    console.info("[github-api-summary]", getGitHubRequestTelemetry()),
  );
