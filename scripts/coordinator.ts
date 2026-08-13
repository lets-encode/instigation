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
  configFlag,
  passThresholdOf,
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
import { recordContribution } from "../src/lib/mei-provenance.ts";
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
  getCommitMessage,
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

// Human explanations for the rejection codes, appended to the PR comment
// (which the console shows verbatim). The code itself stays in the comment
// and in the history row.
const REASON_TEXT: Record<string, string> = {
  malformed_claim: "the PR does not add exactly one lock row",
  malformed_validation:
    "the PR is neither a single verdict nor a clean send-back reset",
  malformed_comment: "the PR does not append or resolve exactly one comment row",
  out_of_bounds: "the PR changes files outside the ones this operation may touch",
  invalid_kind: "unknown claim or comment kind",
  invalid_target: "the claim addresses the wrong row for its kind",
  unknown_task: "no such task",
  dependency_incomplete: "this task opens once the task it depends on is completed",
  wrong_state: "the task is not in the right state for this operation",
  already_locked: "someone already holds this claim",
  self_validation: "the encoder cannot validate their own work",
  already_validated: "this person already recorded a verdict on this subtask",
  no_open_validation_slot: "no validation slot is open",
  not_lock_holder: "the author does not hold the required claim",
  mei_invalid: "the submitted MEI failed the machine check",
  invalid_verdict: "a validation verdict must be pass or fail",
  fail_without_comment: "a fail must carry a comment saying why",
  no_recorded_fail: "the task has no recorded fail to send it back for",
  not_permitted: "only a failing validator or a maintainer may do this",
  empty_comment: "the comment is empty",
  unknown_parent: "the reply's parent comment does not exist",
  invalid_parent: "only a reply carries a parent comment",
  unknown_comment: "no such comment",
  already_resolved: "the comment is already resolved",
  no_changes: "the PR changes nothing",
};

// "`code` — explanation" for a rejection comment; just the code when unmapped.
const explainReason = (reason: string | undefined): string => {
  const code = reason ?? "rejected";
  const text = REASON_TEXT[code];
  return text ? `\`${code}\` — ${text}` : `\`${code}\``;
};

// ---------------------------------------------------------------------------
// Shared helpers

// Random id for a comment row the automation authors.
const newCommentId = (): string => crypto.randomUUID().slice(0, 8);

// Log the wall-clock seconds since `startedAt` as a `[phase-timing]` line —
// the form the run profiler (scripts/profile-actions.ts) extracts.
const logPhase = (phase: string, startedAt: number): void =>
  console.info(
    `[phase-timing] ${phase} ${((Date.now() - startedAt) / 1000).toFixed(2)}s`,
  );

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
  const readStart = Date.now();
  const { branch, sha } = await getRepoHead(token, owner, repo);
  const [taskCsv, stateCsv, lockCsv, historyCsv, configText] =
    await Promise.all([
      getRepoFile(token, owner, repo, TASK_PATH, sha),
      getRepoFile(token, owner, repo, STATE_PATH, sha),
      getRepoFile(token, owner, repo, LOCK_PATH, sha),
      getRepoFile(token, owner, repo, HISTORY_PATH, sha),
      getRepoFile(token, owner, repo, CONFIG_PATH, sha),
    ]);
  logPhase("read_tables", readStart);
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
        allowSelfValidation: configFlag(configText, "allow_self_validation"),
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
  const commitStart = Date.now();
  await commitFiles(token, owner, repo, files, message, {
    baseSha: sha,
    branch,
  });
  logPhase("commit", commitStart);
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
    : `❌ Claim rejected: ${explainReason(verdict.reason)}. No changes were made.`;
  const closeStart = Date.now();
  // Branch cleanup is independent of the comment/close pair and overlaps it.
  await Promise.all([
    commentAndClosePr(token, owner, repo, prNumber, body),
    cleanupHeadBranch(),
  ]);
  logPhase("comment_and_close", closeStart);
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
  const readStart = Date.now();
  const [forkMei, baseMei, configText, commitMessage] = await Promise.all([
    getRepoFile(token, headOwner, headRepo, task.fragment, headSha),
    isPageTask ? getRepoFile(token, owner, repo, task.fragment, sha) : null,
    isPageTask ? getRepoFile(token, owner, repo, CONFIG_PATH, sha) : null,
    getCommitMessage(token, headOwner, headRepo, headSha),
  ]);
  logPhase("read_pr_files", readStart);
  const checkStart = Date.now();
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
  // Record the contribution in the assembled score's header — the revision,
  // the contributor, and the editing application — before the machine check,
  // so the updated header is validated with the rest of the file. Encodings
  // are edited in mei-friend; a zones submission comes from the console
  // itself, whose <application> entry every generated score already carries.
  if (mei != null) {
    mei = recordContribution(mei, {
      name: authorLabel,
      message: commitMessage ?? `Encoding of ${task.task_id} accepted.`,
      isodate: now.slice(0, 10),
      application:
        envelope?.command === "campaign.submitZones" ? undefined : "mei-friend",
    });
  }

  let meiValid = false;
  if (mei != null) {
    const check = await validateMei(mei);
    meiValid = check.ok;
    if (!check.ok) detail = `${task.fragment}:${check.error}`;
  }
  logPhase("mei_check", checkStart);

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
  // Everything the decision might need is read in one parallel batch: the
  // comment tables only when the PR touches them (a fail's mandatory comment),
  // the config always (pass_threshold). A send-back over-reads two files.
  const wantsComments = changedPaths.includes(COMMENT_PATH);
  const readStart = Date.now();
  const [headStateCsv, configText, baseCommentCsv, headCommentCsv] =
    await Promise.all([
      getRepoFile(token, headOwner, headRepo, STATE_PATH, headSha),
      getRepoFile(token, owner, repo, CONFIG_PATH, sha),
      wantsComments ? getRepoFile(token, owner, repo, COMMENT_PATH, sha) : null,
      wantsComments
        ? getRepoFile(token, headOwner, headRepo, COMMENT_PATH, headSha)
        : null,
    ]);
  logPhase("read_pr_files", readStart);
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
  if (wantsComments) {
    baseComments = parseCommentCsv(baseCommentCsv ?? "");
    const added =
      headCommentCsv == null
        ? null
        : appendedComments(baseComments, parseCommentCsv(headCommentCsv));
    failComment = added?.length === 1 ? added[0] : null;
  }

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
    passThreshold: passThresholdOf(configText, state.validationColumns.length),
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
  const readStart = Date.now();
  const { branch, sha } = await getRepoHead(token, owner, repo);
  const [taskCsv, stateCsv, lockCsv, historyCsv] = await Promise.all([
    getRepoFile(token, owner, repo, TASK_PATH, sha),
    getRepoFile(token, owner, repo, STATE_PATH, sha),
    getRepoFile(token, owner, repo, LOCK_PATH, sha),
    getRepoFile(token, owner, repo, HISTORY_PATH, sha),
  ]);
  logPhase("read_tables", readStart);
  const tasks = parseTaskCsv(taskCsv ?? "");
  const state = parseStateCsv(stateCsv ?? "");
  const locks = parseLockCsv(lockCsv ?? "");
  const now = new Date().toISOString();

  const decideStart = Date.now();
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
  logPhase("decide", decideStart);

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
  const commitStart = Date.now();
  await commitFiles(token, owner, repo, files, message, {
    baseSha: sha,
    branch,
  });
  logPhase("commit", commitStart);
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
    : `❌ Submission rejected: ${explainReason(verdict.reason)}. No changes were made.` +
      (verdict.detail ? ` ${verdict.detail}` : "");
  const closeStart = Date.now();
  await Promise.all([
    commentAndClosePr(token, owner, repo, prNumber, body),
    shouldCleanupSubmission(kind, verdict.ok) ? cleanupHeadBranch() : null,
  ]);
  logPhase("comment_and_close", closeStart);
}

// ---------------------------------------------------------------------------
// Comment (a PR appending one discussion row to comment.csv, or resolving one)

async function attemptComment(
  changedPaths: string[],
  envelope: CommandEnvelope | null,
): Promise<Verdict & { action: string }> {
  const readStart = Date.now();
  const { branch, sha } = await getRepoHead(token, owner, repo);
  const [stateCsv, commentCsv, historyCsv, headCommentCsv] = await Promise.all([
    getRepoFile(token, owner, repo, STATE_PATH, sha),
    getRepoFile(token, owner, repo, COMMENT_PATH, sha),
    getRepoFile(token, owner, repo, HISTORY_PATH, sha),
    getRepoFile(token, headOwner, headRepo, COMMENT_PATH, headSha),
  ]);
  logPhase("read_tables", readStart);
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
  const commitStart = Date.now();
  await commitFiles(token, owner, repo, files, message, {
    baseSha: sha,
    branch,
  });
  logPhase("commit", commitStart);
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
    : `❌ Comment rejected: ${explainReason(verdict.reason)}. No changes were made.`;
  const closeStart = Date.now();
  await Promise.all([
    commentAndClosePr(token, owner, repo, prNumber, body),
    cleanupHeadBranch(),
  ]);
  logPhase("comment_and_close", closeStart);
}

// ---------------------------------------------------------------------------
// Reaper (scheduled / manually dispatched)

async function attemptReap(): Promise<void> {
  const readStart = Date.now();
  const { branch, sha } = await getRepoHead(token, owner, repo);
  const [lockCsv, historyCsv, configText] = await Promise.all([
    getRepoFile(token, owner, repo, LOCK_PATH, sha),
    getRepoFile(token, owner, repo, HISTORY_PATH, sha),
    getRepoFile(token, owner, repo, CONFIG_PATH, sha),
  ]);
  logPhase("read_tables", readStart);
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
  const commitStart = Date.now();
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
  logPhase("commit", commitStart);
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

  const readStart = Date.now();
  const details = await getPullRequestDetails(token, owner, repo, prNumber);
  const files = await getPullRequestFiles(
    token,
    owner,
    repo,
    prNumber,
    details.changedFiles,
  );
  logPhase("read_pr", readStart);
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
    // JSON on one line, so log collectors can extract the whole summary.
    console.info(
      "[github-api-summary]",
      JSON.stringify(getGitHubRequestTelemetry()),
    ),
  );
