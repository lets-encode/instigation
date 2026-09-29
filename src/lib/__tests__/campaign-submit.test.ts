import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseTaskCsv,
  parseStateCsv,
  parseLockCsv,
  serializeStateCsv,
  serializeLockCsv,
  findRow,
} from "../campaign-tables.ts";
import type { ParsedState, LockRow, CommentRow } from "../campaign-tables.ts";
import {
  checkComment,
  checkEncoding,
  checkResolveComment,
  checkSendBack,
  checkValidation,
  resolveCommentThread,
} from "../campaign-submit.ts";
import type {
  CheckEncodingArgs,
  CheckValidationArgs,
} from "../campaign-submit.ts";

// A relaxed view of the submit result for assertions, where the accepted-branch
// fields are read directly without narrowing each result.
type SubmitView = {
  ok: boolean;
  reason?: string;
  state?: ParsedState;
  locks?: LockRow[];
};

const enc = (args: CheckEncodingArgs): SubmitView => checkEncoding(args);
const val = (
  args: Omit<CheckValidationArgs, "failComment"> & {
    failComment?: CommentRow | null;
  },
): SubmitView => checkValidation({ failComment: null, ...args });
const commentReason = (args: Parameters<typeof checkComment>[0]) =>
  (checkComment(args) as SubmitView).reason;
const resolveReason = (args: Parameters<typeof checkResolveComment>[0]) =>
  (checkResolveComment(args) as SubmitView).reason;

const comment = (over: Partial<CommentRow>): CommentRow => ({
  comment_id: "",
  task_id: "T0001",
  subtask_id: "S0001",
  kind: "fail",
  page: "12",
  measure_start: "34",
  measure_end: "35",
  author_id: "",
  timestamp: "",
  resolved: "",
  parent_id: "",
  body: "Slur missing in m. 34–35.",
  ...over,
});

const NOW = "2026-06-25T10:00:00Z";
const LOCK_HEADER = "task_id,subtask_id,user_id,timestamp,kind\n";
const STATE_HEADER =
  "task_id,subtask_id,status,encoder,encoded_at,validate_status_1\n";

const TASKS = parseTaskCsv(
  "task_id,subtask_id,fragment,locator,allowlist,blocklist,depends_on\n" +
    "T0001,,sources/score.mei,,,,\n" +
    "T0001,S0001,sources/score.mei,,,,\n",
);

const encodingState = () =>
  parseStateCsv(
    STATE_HEADER + "T0001,,encoding_required,,,\n" + "T0001,S0001,pending,,,\n",
  );

test("a task without validation subtasks completes on its accepted submission", () => {
  const tasks = parseTaskCsv(
    "task_id,subtask_id,fragment,locator,allowlist,blocklist,depends_on\n" +
      "P0002,,sources/score.mei,,,,P0001\n",
  );
  const state = parseStateCsv(STATE_HEADER + "P0002,,encoding_required,,,\n");
  const locks = parseLockCsv(
    LOCK_HEADER + "P0002,,bob,2026-06-25T09:00:00Z,encoding\n",
  );
  const v = checkEncoding({
    tasks,
    state,
    locks,
    intent: { task_id: "P0002" },
    author: "bob",
    changedPaths: ["sources/score.mei"],
    meiValid: true,
    now: NOW,
  });
  assert.equal(v.ok, true);
  if (v.ok) {
    const row = v.state.rows[0];
    assert.equal(row.status, "completed");
    assert.equal(row.encoder, "bob");
    assert.equal(v.locks.length, 0);
  }
});
const validationState = () =>
  parseStateCsv(
    STATE_HEADER +
      "T0001,,validation_required,bob,2026-06-25T09:00:00Z,\n" +
      "T0001,S0001,validation_required,,,\n",
  );
const encodingLock = parseLockCsv(
  LOCK_HEADER + "T0001,,bob,2026-06-25T08:00:00Z,encoding\n",
);
const validationLock = parseLockCsv(
  LOCK_HEADER + "T0001,S0001,carol,2026-06-25T09:30:00Z,validation\n",
);

// --- Encoding submission ---------------------------------------------------

test("encoding: accepted submission advances the task and its subtasks, clears the lock", () => {
  const v = enc({
    tasks: TASKS,
    state: encodingState(),
    locks: encodingLock,
    intent: { task_id: "T0001" },
    author: "bob",
    changedPaths: ["sources/score.mei"],
    meiValid: true,
    now: NOW,
  });
  assert.equal(v.ok, true);
  assert.equal(
    serializeStateCsv(v.state!),
    STATE_HEADER +
      `T0001,,validation_required,bob,${NOW},\n` +
      "T0001,S0001,validation_required,,,\n",
  );
  assert.equal(serializeLockCsv(v.locks!), LOCK_HEADER);
});

const encBase: CheckEncodingArgs = {
  tasks: TASKS,
  state: encodingState(),
  locks: encodingLock,
  intent: { task_id: "T0001" },
  author: "bob",
  changedPaths: ["sources/score.mei"],
  meiValid: true,
  now: NOW,
};

test("encoding: side files are accepted only for the locator that owns them", () => {
  const tasksWithLocator = (locator: string) =>
    parseTaskCsv(
      "task_id,subtask_id,fragment,locator,allowlist,blocklist,depends_on\n" +
        `T0001,,sources/score.mei,${locator},,,\n` +
        "T0001,S0001,sources/score.mei,,,,\n",
    );
  // [locator, changed paths, expected reason or undefined for accepted]
  const cases: [string, string[], string | undefined][] = [
    ["omr-layout", ["sources/score.mei", "sources/layout.json"], undefined],
    [
      "omr-layout",
      [
        "sources/score.mei",
        "sources/layout-corrected.json",
        "sources/layout.json",
      ],
      undefined,
    ],
    ["omr-layout", ["sources/layout-corrected.json"], undefined],
    [
      "measure-zones",
      ["sources/score.mei", "sources/layout-corrected.json"],
      "out_of_bounds",
    ],
    ["", ["sources/score.mei", "sources/layout.json"], "out_of_bounds"],
    ["score-setup", ["sources/score.mei", "sources/omr.xml"], undefined],
    ["score-setup", ["sources/omr.xml"], undefined],
    [
      "score-setup",
      ["sources/score.mei", "sources/layout.json"],
      "out_of_bounds",
    ],
  ];
  for (const [locator, changedPaths, reason] of cases) {
    const label = `${locator || "(none)"}: ${changedPaths.join(", ")}`;
    const v = enc({
      ...encBase,
      tasks: tasksWithLocator(locator),
      changedPaths,
    });
    assert.equal(v.ok, reason === undefined, label);
    assert.equal(v.reason, reason, label);
  }
});

test("encoding: rejects out-of-bounds changes, non-lock-holders, invalid MEI, the wrong state and unknown tasks", () => {
  const cases: [string, Partial<CheckEncodingArgs>, string | undefined][] = [
    ["no file changed", { changedPaths: [] }, undefined],
    [
      "file outside the fragment",
      { changedPaths: ["sources/score.mei", "tracking/state.csv"] },
      "out_of_bounds",
    ],
    [
      "author without the encoding lock",
      { author: "mallory" },
      "not_lock_holder",
    ],
    [
      "validation lock instead of an encoding lock",
      { locks: parseLockCsv(LOCK_HEADER + "T0001,S0001,bob,t,validation\n") },
      "not_lock_holder",
    ],
    ["invalid MEI", { meiValid: false }, "mei_invalid"],
    ["task in validation", { state: validationState() }, "wrong_state"],
    ["unknown task", { intent: { task_id: "T9999" } }, "unknown_task"],
  ];
  for (const [label, over, reason] of cases) {
    const v = enc({ ...encBase, ...over });
    assert.equal(v.ok, reason === undefined, label);
    assert.equal(v.reason, reason, label);
  }
});

// --- Validation outcome ----------------------------------------------------

test("validation: a pass meeting the threshold completes the subtask AND the task", () => {
  const v = val({
    state: validationState(),
    locks: validationLock,
    intent: { task_id: "T0001", subtask_id: "S0001", verdict: "pass" },
    author: "carol",
    changedPaths: ["tracking/state.csv"],
    passThreshold: 1,
    now: NOW,
  });
  assert.equal(v.ok, true);
  assert.equal(
    serializeStateCsv(v.state!),
    STATE_HEADER +
      "T0001,,completed,bob,2026-06-25T09:00:00Z,\n" +
      `T0001,S0001,completed,,,pass|carol|${NOW}\n`,
  );
  assert.equal(serializeLockCsv(v.locks!), LOCK_HEADER);
});

test("validation: the task stays open while another subtask is unfinished", () => {
  const state = parseStateCsv(
    STATE_HEADER +
      "T0001,,validation_required,bob,t,\n" +
      "T0001,S0001,validation_required,,,\n" +
      "T0001,S0002,validation_required,,,\n",
  );
  const v = val({
    state,
    locks: validationLock,
    intent: { task_id: "T0001", subtask_id: "S0001", verdict: "pass" },
    author: "carol",
    changedPaths: ["tracking/state.csv"],
    passThreshold: 1,
    now: NOW,
  });
  assert.equal(findRow(v.state!.rows, "T0001", "S0001")!.status, "completed");
  assert.equal(
    findRow(v.state!.rows, "T0001", "S0002")!.status,
    "validation_required",
  );
  assert.equal(
    findRow(v.state!.rows, "T0001", "")!.status,
    "validation_required",
  );
});

test("validation: a fail with its comment is recorded in place — the task stays in validation", () => {
  const state = parseStateCsv(
    "task_id,subtask_id,status,encoder,encoded_at,validate_status_1,validate_status_2\n" +
      "T0001,,validation_required,bob,t,,\n" +
      "T0001,S0001,validation_required,,,,\n",
  );
  const locks = parseLockCsv(
    LOCK_HEADER +
      "T0001,S0001,carol,2026-06-25T09:30:00Z,validation\n" +
      "T0001,S0001,dave,2026-06-25T09:35:00Z,validation\n",
  );
  const v = val({
    state,
    locks,
    intent: { task_id: "T0001", subtask_id: "S0001", verdict: "fail" },
    author: "carol",
    changedPaths: ["tracking/state.csv", "tracking/comment.csv"],
    passThreshold: 2,
    failComment: comment({}),
    now: NOW,
  });
  assert.equal(v.ok, true);
  const row = findRow(v.state!.rows, "T0001", "S0001")!;
  const task = findRow(v.state!.rows, "T0001", "")!;
  assert.equal(row.validate_status_1, `fail|carol|${NOW}`);
  assert.equal(row.status, "validation_required");
  assert.equal(task.status, "validation_required");
  assert.equal(task.encoder, "bob");
  // Only carol's own review lock is released; dave keeps reviewing.
  assert.equal(
    v.locks!.some((lock) => lock.user_id === "carol"),
    false,
  );
  assert.equal(
    v.locks!.some((lock) => lock.user_id === "dave"),
    true,
  );
});

test("validation: a fail without its comment row is rejected", () => {
  const base = {
    state: validationState(),
    locks: validationLock,
    intent: { task_id: "T0001", subtask_id: "S0001", verdict: "fail" },
    author: "carol",
    passThreshold: 1,
    now: NOW,
  };
  // No comment.csv change at all.
  assert.equal(
    val({ ...base, changedPaths: ["tracking/state.csv"] }).reason,
    "fail_without_comment",
  );
  // comment.csv changed, but not a clean single-row append.
  assert.equal(
    val({
      ...base,
      changedPaths: ["tracking/state.csv", "tracking/comment.csv"],
      failComment: null,
    }).reason,
    "fail_without_comment",
  );
  // An empty body does not count as saying why.
  assert.equal(
    val({
      ...base,
      changedPaths: ["tracking/state.csv", "tracking/comment.csv"],
      failComment: comment({ body: "   " }),
    }).reason,
    "fail_without_comment",
  );
  // The comment must address the failed subtask.
  assert.equal(
    val({
      ...base,
      changedPaths: ["tracking/state.csv", "tracking/comment.csv"],
      failComment: comment({ subtask_id: "S0002" }),
    }).reason,
    "fail_without_comment",
  );
});

test("validation: a pass may not carry a comment.csv change", () => {
  const v = val({
    state: validationState(),
    locks: validationLock,
    intent: { task_id: "T0001", subtask_id: "S0001", verdict: "pass" },
    author: "carol",
    changedPaths: ["tracking/state.csv", "tracking/comment.csv"],
    passThreshold: 1,
    now: NOW,
  });
  assert.equal(v.reason, "out_of_bounds");
});

// --- Send back for encoding --------------------------------------------------

const failedState = () =>
  parseStateCsv(
    STATE_HEADER +
      "T0001,,validation_required,bob,t,\n" +
      "T0001,S0001,validation_required,,,fail|carol|2026-06-25T09:45:00Z\n",
  );

test("send-back: a failing validator resets the task to encoding", () => {
  const locks = parseLockCsv(
    LOCK_HEADER +
      "T0001,S0001,dave,2026-06-25T09:35:00Z,validation\n" +
      "T0002,,erin,2026-06-25T09:40:00Z,encoding\n",
  );
  const v: SubmitView = checkSendBack({
    state: failedState(),
    locks,
    intent: { task_id: "T0001" },
    author: "carol",
    changedPaths: ["tracking/state.csv"],
    isCollaborator: false,
  });
  assert.equal(v.ok, true);
  const task = findRow(v.state!.rows, "T0001", "")!;
  const row = findRow(v.state!.rows, "T0001", "S0001")!;
  assert.equal(task.status, "encoding_required");
  assert.equal(task.encoder, "");
  assert.equal(task.encoded_at, "");
  assert.equal(row.status, "pending");
  assert.equal(row.validate_status_1, "");
  assert.equal(
    v.locks!.some((lock) => lock.task_id === "T0001"),
    false,
  );
  assert.equal(
    v.locks!.some((lock) => lock.task_id === "T0002"),
    true,
  );
});

test("send-back: allowed for push access, rejected for bystanders and without a recorded fail", () => {
  const base = {
    state: failedState(),
    locks: [] as LockRow[],
    intent: { task_id: "T0001" },
    changedPaths: ["tracking/state.csv"],
  };
  assert.equal(
    checkSendBack({ ...base, author: "owner", isCollaborator: true }).ok,
    true,
  );
  assert.equal(
    (
      checkSendBack({
        ...base,
        author: "mallory",
        isCollaborator: false,
      }) as SubmitView
    ).reason,
    "not_permitted",
  );
  assert.equal(
    (
      checkSendBack({
        ...base,
        state: validationState(),
        author: "carol",
        isCollaborator: false,
      }) as SubmitView
    ).reason,
    "no_recorded_fail",
  );
  assert.equal(
    (
      checkSendBack({
        ...base,
        state: encodingState(),
        author: "carol",
        isCollaborator: false,
      }) as SubmitView
    ).reason,
    "wrong_state",
  );
});

// --- Comments ----------------------------------------------------------------

test("comments: a discussion comment is re-authored by the automation", () => {
  const added = comment({
    kind: "question",
    body: "Cue-size notes in m. 38?",
    author_id: "forged",
    timestamp: "forged",
  });
  const v = checkComment({
    state: validationState(),
    comments: [],
    added,
    author: "mallory-proof",
    changedPaths: ["tracking/comment.csv"],
    now: NOW,
    newId: "c1",
  });
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.equal(v.row.comment_id, "c1");
    assert.equal(v.row.author_id, "mallory-proof");
    assert.equal(v.row.timestamp, NOW);
    assert.equal(v.row.resolved, "");
  }
});

test("comments: rejects bad kinds, empty bodies, unknown tasks and replies to anything but a top-level discussion comment", () => {
  const base = {
    state: validationState(),
    comments: [
      comment({ comment_id: "c1", kind: "question" }),
      comment({ comment_id: "c2", kind: "reply", parent_id: "c1" }),
      comment({ comment_id: "c3", kind: "fail" }),
    ],
    author: "carol",
    changedPaths: ["tracking/comment.csv"],
    now: NOW,
    newId: "c4",
  };
  const cases: [string, CommentRow | null, string][] = [
    ["no row", null, "malformed_comment"],
    ["fail kind", comment({ kind: "fail" }), "invalid_kind"],
    ["blank body", comment({ kind: "question", body: " " }), "empty_comment"],
    [
      "unknown task",
      comment({ kind: "question", task_id: "T9999" }),
      "unknown_task",
    ],
    [
      "reply to a missing parent",
      comment({ kind: "reply", parent_id: "nope" }),
      "unknown_parent",
    ],
    [
      "question with a parent",
      comment({ kind: "question", parent_id: "c1" }),
      "invalid_parent",
    ],
    // A reply to a reply has no thread to render under.
    [
      "reply to a reply",
      comment({ kind: "reply", parent_id: "c2" }),
      "invalid_parent",
    ],
    // Fail comments live in the validation record, not the discussion threads.
    [
      "reply to a fail",
      comment({ kind: "reply", parent_id: "c3" }),
      "invalid_parent",
    ],
  ];
  for (const [label, added, reason] of cases) {
    assert.equal(commentReason({ ...base, added }), reason, label);
  }
  assert.equal(
    checkComment({
      ...base,
      added: comment({ kind: "reply", parent_id: "c1" }),
    }).ok,
    true,
  );
});

test("comments: resolving a root resolves its reply chain with it", () => {
  const comments = [
    comment({ comment_id: "c1", kind: "question", author_id: "carol" }),
    comment({
      comment_id: "c2",
      kind: "reply",
      parent_id: "c1",
      author_id: "dave",
    }),
    comment({
      comment_id: "c3",
      kind: "reply",
      parent_id: "c2",
      author_id: "erin",
    }),
    comment({ comment_id: "c4", kind: "question", author_id: "carol" }),
  ];
  const v = checkResolveComment({
    comments,
    comment_id: "c1",
    author: "carol",
    changedPaths: ["tracking/comment.csv"],
    isCollaborator: false,
  });
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.equal(v.row.comment_id, "c1");
    assert.deepEqual(
      v.comments.map((c) => c.resolved),
      ["true", "true", "true", ""],
    );
  }
  // The pure helper leaves rows outside the thread untouched.
  assert.deepEqual(
    resolveCommentThread(comments, "c4").map((c) => c.resolved),
    ["", "", "", "true"],
  );
});

test("comments: resolving is author- or push-access-only", () => {
  const comments = [
    comment({ comment_id: "c1", kind: "question", author_id: "carol" }),
  ];
  const base = {
    comments,
    comment_id: "c1",
    changedPaths: ["tracking/comment.csv"],
  };
  assert.equal(
    checkResolveComment({ ...base, author: "carol", isCollaborator: false }).ok,
    true,
  );
  assert.equal(
    checkResolveComment({ ...base, author: "owner", isCollaborator: true }).ok,
    true,
  );
  assert.equal(
    resolveReason({ ...base, author: "mallory", isCollaborator: false }),
    "not_permitted",
  );
  const resolved = [
    comment({
      comment_id: "c1",
      kind: "question",
      author_id: "carol",
      resolved: "true",
    }),
  ];
  assert.equal(
    resolveReason({
      ...base,
      comments: resolved,
      author: "carol",
      isCollaborator: false,
    }),
    "already_resolved",
  );
});

test("validation: below threshold stays validation_required, writing the next open slot", () => {
  const state = parseStateCsv(
    "task_id,subtask_id,status,encoder,encoded_at,validate_status_1,validate_status_2\n" +
      "T0001,,validation_required,bob,t,,\n" +
      "T0001,S0001,validation_required,,,,\n",
  );
  const v = val({
    state,
    locks: validationLock,
    intent: { task_id: "T0001", subtask_id: "S0001", verdict: "pass" },
    author: "carol",
    changedPaths: ["tracking/state.csv"],
    passThreshold: 2,
    now: NOW,
  });
  const row = findRow(v.state!.rows, "T0001", "S0001")!;
  assert.equal(row.validate_status_1, `pass|carol|${NOW}`);
  assert.equal(row.validate_status_2, "");
  assert.equal(row.status, "validation_required");
});

test("validation: malformed pass-like cells do not satisfy the threshold", () => {
  const state = parseStateCsv(
    "task_id,subtask_id,status,encoder,encoded_at,validate_status_1,validate_status_2\n" +
      "T0001,,validation_required,bob,t,,\n" +
      "T0001,S0001,validation_required,,,pass||t,\n",
  );
  const v = val({
    state,
    locks: validationLock,
    intent: { task_id: "T0001", subtask_id: "S0001", verdict: "pass" },
    author: "carol",
    changedPaths: ["tracking/state.csv"],
    passThreshold: 2,
    now: NOW,
  });
  assert.equal(v.ok, true);
  assert.equal(
    findRow(v.state!.rows, "T0001", "S0001")!.status,
    "validation_required",
  );
  assert.equal(
    findRow(v.state!.rows, "T0001", "")!.status,
    "validation_required",
  );
});

test("validation: rejects invalid verdicts, out-of-bounds changes, wrong states, and non-lock-holders", () => {
  const base = {
    locks: validationLock,
    author: "carol",
    changedPaths: ["tracking/state.csv"],
    passThreshold: 1,
    now: NOW,
  };
  assert.equal(
    val({
      ...base,
      state: validationState(),
      intent: { task_id: "T0001", subtask_id: "S0001", verdict: "maybe" },
    }).reason,
    "invalid_verdict",
  );
  assert.equal(
    val({
      ...base,
      state: encodingState(),
      intent: { task_id: "T0001", subtask_id: "S0001", verdict: "pass" },
    }).reason,
    "wrong_state",
  );
  assert.equal(
    val({
      ...base,
      state: validationState(),
      changedPaths: ["tracking/state.csv", "sources/score.mei"],
      intent: { task_id: "T0001", subtask_id: "S0001", verdict: "pass" },
    }).reason,
    "out_of_bounds",
  );
  assert.equal(
    val({
      ...base,
      state: validationState(),
      author: "eve",
      intent: { task_id: "T0001", subtask_id: "S0001", verdict: "pass" },
    }).reason,
    "not_lock_holder",
  );
});

test("validation: rejects the task row as a target", () => {
  const v = val({
    state: validationState(),
    locks: validationLock,
    intent: { task_id: "T0001", subtask_id: "", verdict: "pass" },
    author: "carol",
    changedPaths: ["tracking/state.csv"],
    passThreshold: 1,
    now: NOW,
  });
  assert.equal(v.reason, "unknown_task");
});

test("validation: rejects when no open slot remains", () => {
  const state = parseStateCsv(
    STATE_HEADER +
      "T0001,,validation_required,bob,t,\n" +
      "T0001,S0001,validation_required,,,fail|dave|t\n",
  );
  const v = val({
    state,
    locks: validationLock,
    intent: { task_id: "T0001", subtask_id: "S0001", verdict: "pass" },
    author: "carol",
    changedPaths: ["tracking/state.csv"],
    passThreshold: 1,
    now: NOW,
  });
  assert.equal(v.reason, "no_open_validation_slot");
});
