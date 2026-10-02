import { test } from "node:test";
import assert from "node:assert/strict";

import { type TaskRow } from "../campaign-tables.ts";
import {
  addedRowFromPatch,
  appendedCommentsFromPatch,
  classifyPullRequest,
  touchesCampaignPaths,
  pieceFieldForPath,
  pieceKindForPath,
  priorDecision,
  removedRowFromPatch,
  resolveEncodingTask,
  resolvedCommentFromPatch,
  shouldCleanupSubmission,
  taskResetFromPatch,
  validationIntentFromPatch,
  validationVerdict,
} from "../coordinator-policy.ts";

const STATE_HEADER = [
  "task_id",
  "subtask_id",
  "status",
  "encoder",
  "encoded_at",
  "validate_status_1",
];

test("claim intent accepts exactly one added row and no removals", () => {
  assert.equal(
    addedRowFromPatch(
      "--- a/tracking/lock.csv\n+++ b/tracking/lock.csv\n@@ -1 +1,2 @@\n context\n+T0001,,user,time,encoding",
    ),
    "T0001,,user,time,encoding",
  );
  assert.equal(addedRowFromPatch("@@\n+one\n+two"), null);
  assert.equal(addedRowFromPatch("@@\n-old\n+new"), null);
  assert.equal(addedRowFromPatch(undefined), null);
});

test("release intent is exactly one removed row and no additions", () => {
  assert.equal(
    removedRowFromPatch(
      "--- a/tracking/lock.csv\n+++ b/tracking/lock.csv\n@@ -1,2 +1 @@\n context\n-T0001,,user,time,encoding",
    ),
    "T0001,,user,time,encoding",
  );
  assert.equal(removedRowFromPatch("@@\n-one\n-two"), null);
  assert.equal(removedRowFromPatch("@@\n-old\n+new"), null);
  assert.equal(removedRowFromPatch("@@\n+new"), null);
  assert.equal(removedRowFromPatch(undefined), null);
});

test("validation intent is one changed cell in the PR patch (merge-base relative)", () => {
  const patch =
    "@@ -2,2 +2,2 @@\n" +
    " T0001,,validation_required,encoder,t,\n" +
    "-T0001,S0001,validation_required,encoder,t,\n" +
    "+T0001,S0001,validation_required,encoder,t,pass";
  assert.deepEqual(validationIntentFromPatch(patch, STATE_HEADER), {
    task_id: "T0001",
    subtask_id: "S0001",
    column: "validate_status_1",
    value: "pass",
  });

  // Two changed cells in one row are not a verdict.
  assert.equal(
    validationIntentFromPatch(
      "@@\n-T0001,S0001,validation_required,encoder,t,\n+T0001,S0001,completed,encoder,t,pass",
      STATE_HEADER,
    ),
    null,
  );
  // Two changed rows are not a verdict.
  assert.equal(
    validationIntentFromPatch(
      "@@\n-T0001,,validation_required,encoder,t,\n-T0001,S0001,validation_required,encoder,t,\n" +
        "+T0001,,completed,encoder,t,\n+T0001,S0001,validation_required,encoder,t,pass",
      STATE_HEADER,
    ),
    null,
  );
  // A row addition or removal is not a verdict.
  assert.equal(
    validationIntentFromPatch(
      "@@\n+T0002,S0001,validation_required,,,pass",
      STATE_HEADER,
    ),
    null,
  );
  assert.equal(validationIntentFromPatch(undefined, STATE_HEADER), null);
  // A second slot column leaves the intent on the changed column.
  assert.deepEqual(
    validationIntentFromPatch(
      "@@\n-T0001,S0001,validation_required,,,,\n+T0001,S0001,validation_required,,,pass,",
      [...STATE_HEADER, "validate_status_2"],
    ),
    {
      task_id: "T0001",
      subtask_id: "S0001",
      column: "validate_status_1",
      value: "pass",
    },
  );
});

test("validation verdicts are exact, not pass/fail prefixes", () => {
  assert.equal(validationVerdict("pass"), "pass");
  assert.equal(validationVerdict("fail"), "fail");
  assert.equal(validationVerdict("passing"), null);
  assert.equal(validationVerdict("fail|user|time"), null);
});

test("pull requests are classified by their mutation table", () => {
  assert.equal(touchesCampaignPaths(["README.md", "docs/x.md"]), false);
  assert.equal(
    touchesCampaignPaths(["README.md", "sources/piece-1/score.mei"]),
    true,
  );
  assert.equal(classifyPullRequest(["tracking/lock.csv"]), "claim");
  assert.equal(classifyPullRequest(["tracking/state.csv"]), "validation");
  assert.equal(classifyPullRequest(["sources/score.mei"]), "encoding");
  assert.equal(
    classifyPullRequest(["sources/score.mei", "tracking/lock.csv"]),
    "claim",
  );
  assert.equal(classifyPullRequest(["tracking/comment.csv"]), "comment");
  // A fail validation carries its comment in the same PR — still a validation.
  assert.equal(
    classifyPullRequest(["tracking/state.csv", "tracking/comment.csv"]),
    "validation",
  );
});

test("a send-back patch reads as the reset of exactly one task", () => {
  const resetPatch =
    "@@ -2,3 +2,3 @@\n" +
    "-T0001,,validation_required,encoder,t,\n" +
    "-T0001,S0001,validation_required,,,fail|carol|t\n" +
    "+T0001,,encoding_required,,,\n" +
    "+T0001,S0001,pending,,,\n" +
    " T0002,,encoding_required,,,\n";
  assert.deepEqual(
    taskResetFromPatch(resetPatch, STATE_HEADER, ["validate_status_1"]),
    { task_id: "T0001" },
  );
  // A reset that also touches another task is not a send-back.
  assert.equal(
    taskResetFromPatch(
      resetPatch
        .replace(" T0002", "-T0002")
        .replace(/$/, "+T0002,,completed,,,\n"),
      STATE_HEADER,
      ["validate_status_1"],
    ),
    null,
  );
  // A "reset" that keeps the encoder is malformed.
  assert.equal(
    taskResetFromPatch(
      resetPatch.replace(
        "+T0001,,encoding_required,,,",
        "+T0001,,encoding_required,encoder,,",
      ),
      STATE_HEADER,
      ["validate_status_1"],
    ),
    null,
  );
  // A single-cell verdict is not a reset.
  assert.equal(
    taskResetFromPatch(
      "@@\n-T0001,S0001,validation_required,,,\n+T0001,S0001,validation_required,,,pass",
      STATE_HEADER,
      ["validate_status_1"],
    ),
    null,
  );
  assert.equal(
    taskResetFromPatch(undefined, STATE_HEADER, ["validate_status_1"]),
    null,
  );
});

test("a comment patch is a pure append or a set of resolve flips", () => {
  // One appended row; the base rows show up only as context.
  const added = appendedCommentsFromPatch(
    "@@ -1,2 +1,3 @@\n c1,T0001,S0001,comment,,,,carol,t1,,,Question?\n+,T0001,,comment,,,,me,,,,A note",
  );
  assert.equal(added?.length, 1);
  assert.equal(added?.[0].kind, "comment");
  assert.equal(added?.[0].body, "A note");
  // A quoted body spanning several patch lines is one appended row.
  const multiline = appendedCommentsFromPatch(
    '@@\n+,T0001,,comment,,,,me,,,,"line 1\n+line 2"',
  );
  assert.equal(multiline?.length, 1);
  assert.equal(multiline?.[0].body, "line 1\nline 2");
  // Rewriting an existing row is not an append.
  assert.equal(
    appendedCommentsFromPatch(
      "@@\n-c1,T0001,S0001,comment,,,,carol,t1,,,Question?\n+c1,T0001,S0001,comment,,,,carol,t1,,,Edited",
    ),
    null,
  );
  assert.equal(appendedCommentsFromPatch(undefined), null);
});

test("a resolve patch flips resolved on one top-level comment (replies may ride along)", () => {
  const c1 = "c1,T0001,S0001,comment,,,,carol,t1,,,Question?";
  const c1Resolved = "c1,T0001,S0001,comment,,,,carol,t1,true,,Question?";
  const reply = "c2,T0001,S0001,reply,,,,dave,t2,,c1,An answer";
  const replyResolved = "c2,T0001,S0001,reply,,,,dave,t2,true,c1,An answer";

  assert.deepEqual(resolvedCommentFromPatch(`@@\n-${c1}\n+${c1Resolved}`), {
    comment_id: "c1",
  });
  // The console flips the root and its replies together — the root is the intent.
  assert.deepEqual(
    resolvedCommentFromPatch(
      `@@\n-${c1}\n-${reply}\n+${c1Resolved}\n+${replyResolved}`,
    ),
    { comment_id: "c1" },
  );
  // Any other edit alongside the flip is rejected.
  assert.equal(
    resolvedCommentFromPatch(
      `@@\n-${c1}\n+c1,T0001,S0001,comment,,,,carol,t1,true,,Edited`,
    ),
    null,
  );
  // Two top-level flips carry no single intent.
  const c3 = "c3,T0001,,comment,,,,erin,t3,,,A note";
  const c3Resolved = "c3,T0001,,comment,,,,erin,t3,true,,A note";
  assert.equal(
    resolvedCommentFromPatch(
      `@@\n-${c1}\n-${c3}\n+${c1Resolved}\n+${c3Resolved}`,
    ),
    null,
  );
  // A reply-only flip has no top-level intent.
  assert.equal(
    resolvedCommentFromPatch(`@@\n-${reply}\n+${replyResolved}`),
    null,
  );
  assert.equal(resolvedCommentFromPatch(undefined), null);
});

test("a resolve patch that rewrites a table without the fragment column still names its root", () => {
  const oldHeader =
    "comment_id,task_id,subtask_id,kind,page,measure_start,measure_end,author_id,timestamp,resolved,parent_id,body";
  const c1 = "c1,T0001,,comment,,,,carol,t1,,,Question?";
  const c3 = "c3,T0001,,comment,,,,erin,t3,,,A note";
  assert.deepEqual(
    resolvedCommentFromPatch(
      `@@\n-${oldHeader}\n-${c1}\n-${c3}\n+${oldHeader},fragment\n+c1,T0001,,comment,,,,carol,t1,true,,Question?,\n+${c3},`,
    ),
    { comment_id: "c1" },
  );
});

test("rejected encoding branches are retained for correction", () => {
  assert.equal(shouldCleanupSubmission("encoding", false), false);
  assert.equal(shouldCleanupSubmission("encoding", true), true);
  assert.equal(shouldCleanupSubmission("validation", false), true);
});

test("an encoding submission resolves by its envelope, else its task branch", () => {
  const task = (task_id: string, locator = ""): TaskRow => ({
    task_id,
    subtask_id: "",
    fragment: "sources/score.mei",
    locator,
    allowlist: "",
    blocklist: "",
    depends_on: "",
  });
  const tasks = [task("P0001", "omr-layout"), task("T0001", "surface-1")];
  const envelope = (task_id: string) => ({
    command: "campaign.submitZones",
    version: 2,
    user_id: "alice",
    timestamp: "2026-01-01T00:00:00.000Z",
    input: { task_id },
  });

  assert.equal(
    resolveEncodingTask({
      tasks,
      envelope: envelope("P0001"),
      headRef: "encode-T0001",
    })?.task_id,
    "P0001",
  );
  assert.equal(
    resolveEncodingTask({ tasks, envelope: null, headRef: "encode-T0001" })
      ?.task_id,
    "T0001",
  );
  assert.equal(
    resolveEncodingTask({ tasks, envelope: null, headRef: "unrelated" }),
    undefined,
  );
  assert.equal(
    resolveEncodingTask({
      tasks,
      envelope: envelope("T9999"),
      headRef: "encode-T0001",
    }),
    undefined,
  );
});

test("pieceFieldForPath and pieceKindForPath read one quoted field of the piece at a path", () => {
  const config =
    "pieces:\n" +
    '  - id: "piece-01"\n' +
    '    kind: "facsimile"\n' +
    '    preparation: "omr"\n' +
    '    path: "sources/piece-01/score.mei"\n' +
    "    zones: []\n" +
    '  - id: "piece-02"\n' +
    '    kind: "physical-only"\n' +
    '    path: "sources/piece-02/score.mei"\n' +
    "    pages: 3\n" +
    "    zones: []\n";
  assert.equal(
    pieceKindForPath(config, "sources/piece-01/score.mei"),
    "facsimile",
  );
  assert.equal(
    pieceKindForPath(config, "sources/piece-02/score.mei"),
    "physical-only",
  );
  assert.equal(
    pieceFieldForPath(config, "sources/piece-01/score.mei", "preparation"),
    "omr",
  );
  // A piece without the field, and a path no piece carries.
  assert.equal(
    pieceFieldForPath(config, "sources/piece-02/score.mei", "preparation"),
    null,
  );
  assert.equal(
    pieceFieldForPath(config, "sources/piece-03/score.mei", "kind"),
    null,
  );
  assert.equal(pieceKindForPath(config, "sources/piece-09/score.mei"), null);
  assert.equal(pieceKindForPath(null, "sources/piece-01/score.mei"), null);
});

test("priorDecision: the last history row of the pull request, or null", () => {
  const row = (pr: string, outcome: string) => ({
    timestamp: "t",
    task_id: "T0001",
    subtask_id: "",
    user_id: "7",
    action: "claim_encoding",
    outcome,
    detail: "",
    pr,
  });
  const history = [
    row("", "released"),
    row("12", "rejected"),
    row("4", "accepted"),
    row("12", "accepted"),
  ];
  assert.equal(priorDecision(history, 12), history[3]);
  assert.equal(priorDecision(history, 4), history[2]);
  assert.equal(priorDecision(history, 5), null);
  assert.equal(priorDecision([row("", "released")], 0), null);
});
