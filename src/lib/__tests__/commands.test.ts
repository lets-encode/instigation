import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";

import {
  commands,
  invoke,
  setVerdictSink,
  type CommandContext,
} from "../commands.ts";
import { envelopeFromPrBody } from "../command-envelope.ts";
import type { ForgeClient, OpenedChangeRequest } from "../forge/types.ts";
import { fakeForge, type ForgeOverrides } from "./fake-forge.ts";

function context(forge: ForgeClient): CommandContext {
  // viewer is the acting user's numeric id (written to the tables); viewerLogin
  // is their login (human-readable PR prose only).
  return {
    forge,
    repoId: 555,
    owner: "campaign-owner",
    repo: "campaign",
    viewer: "9001",
    viewerLogin: "volunteer",
    meiFriendUrl: "https://mei-friend.example",
    omr: {
      layoutModel: { name: "layout", version: "1" },
      staffPipeline: { name: "staff", version: "1" },
    },
    progress: () => {},
  };
}

async function withImmediateTimeouts<T>(run: () => Promise<T>): Promise<T> {
  const original = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void) => {
    queueMicrotask(callback);
    return 0;
  }) as typeof setTimeout;
  try {
    return await run();
  } finally {
    globalThis.setTimeout = original;
  }
}

const lockHeader = "task_id,subtask_id,user_id,timestamp,kind\n";
// What an encoding submission reads before opening its PR: the task table for
// the fragment path, and the fragment itself from the encode branch.
const encodingFiles: Record<string, string> = {
  "tracking/task.csv":
    "task_id,subtask_id,fragment,locator,allowlist,blocklist,depends_on\nT0001,,sources/score.mei,,,,\n",
  "sources/score.mei":
    '<mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="5.1"/>',
};
// Take the schema download away, so the browser-side pre-check reports itself
// unavailable and the submission proceeds to the automation's check.
function offline(t: TestContext): void {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("offline");
  });
}

// Capture the background settlement of an optimistic PR command: the promise
// resolves when the command's verdict lands in the sink.
function captureVerdict(): Promise<{ state: string; message: string }> {
  return new Promise((resolve) => {
    setVerdictSink({
      begin: () => "test",
      attachPr: () => {},
      settle: (_id, state, message) => resolve({ state, message }),
    });
  });
}

// The forge a claim on P0001 reads and writes: an empty lock table and a PR
// opened from the volunteer's fork with the given number. `pr` fields are
// merged into the opened PR.
function claimForge(
  number: number,
  { pr, ...overrides }: ForgeOverrides & { pr?: Partial<OpenedChangeRequest> },
): ForgeClient {
  return fakeForge({
    getRepoSubscription: async () => ({ subscribed: false, ignored: true }),
    getRepoFile: async () => lockHeader,
    openChangePr: async () => ({
      number,
      html_url: `https://example.test/pr/${number}`,
      head: {
        owner: "volunteer",
        repo: "campaign",
        branch: "claim-P0001-abcd",
      },
      ...pr,
    }),
    ...overrides,
  });
}

// Submit T0001 as a volunteer encoding from a fork, with the schema download
// unavailable, and wait for the background settlement of its PR.
function runEncoding(t: TestContext, overrides: ForgeOverrides) {
  offline(t);
  const forge = fakeForge({
    getRepoSubscription: async () => ({ subscribed: false, ignored: true }),
    getRepoHead: async () => ({
      branch: "main",
      sha: "base-sha",
      treeSha: "base-sha-tree",
      canPush: false,
    }),
    ensureFork: async () => ({ owner: "volunteer", repo: "campaign" }),
    getRepoFile: async (_owner, _repo, path) => encodingFiles[path] ?? null,
    ...overrides,
  });
  const settled = captureVerdict();
  return withImmediateTimeouts(async () => {
    const result = await invoke(
      commands.submitEncoding,
      { task_id: "T0001" },
      context(forge),
    );
    return { result, verdict: await settled };
  });
}

test("readTables decodes generated quoted config values", async () => {
  const files: Record<string, string> = {
    "tracking/task.csv":
      "task_id,subtask_id,fragment,locator,allowlist,blocklist,depends_on\nT0001,,sources/score.mei,,,,\n",
    "tracking/state.csv":
      "task_id,subtask_id,status,encoder,encoded_at,validate_status_1,validate_status_2\nT0001,,encoding_required,,,,\n",
    "tracking/lock.csv": lockHeader,
    "tracking/history.csv":
      "timestamp,task_id,subtask_id,user_id,action,outcome,detail,command,command_version,command_input\n",
    "config.yaml":
      'campaign:\n  title: "A \\"quoted\\" \\\\ title\\nsecond line"\n  license: "CC-BY-4.0"\nvalidation:\n  pass_threshold: 2\n',
  };
  const forge = fakeForge({
    getRepoFile: async (_owner, _repo, path) => files[path] ?? null,
    getRepoAccess: async () => ({ isPrivate: true, canPush: false }),
  });

  const result = await invoke(commands.readTables, {}, context(forge));

  assert.equal(result.title, 'A "quoted" \\ title\nsecond line');
  assert.equal(result.license, "CC-BY-4.0");
  assert.equal(result.passThreshold, 2);
  assert.equal(result.isPrivate, true);
});

test("submitValidation rejects an invalid verdict before opening a PR", async () => {
  const result = await invoke(
    commands.submitValidation,
    { task_id: "T0001", subtask_id: "S0001", verdict: "passing" },
    context(fakeForge({})),
  );

  assert.equal(result.error, "Invalid review verdict: passing.");
});

test("a headless claim carries its envelope and cleans its fork branch after acceptance", async () => {
  let openedBody = "";
  let deleted: string[] = [];
  const opened: OpenedChangeRequest = {
    number: 12,
    html_url: "https://example.test/pr/12",
    head: { owner: "volunteer", repo: "campaign", branch: "claim-P0001-abcd" },
  };
  const forge = fakeForge({
    getRepoSubscription: async () => ({ subscribed: false, ignored: true }),
    getRepoFile: async (_owner, _repo, path) =>
      path === "tracking/lock.csv" ? lockHeader : null,
    openChangePr: async (_owner, _repo, options) => {
      openedBody = options.body;
      return opened;
    },
    getPullRequestState: async () => "closed",
    getLastIssueComment: async () => "✅ Claim accepted.",
    deleteBranch: async (owner, repo, branch) => {
      deleted = [owner, repo, branch];
    },
  });

  const result = await withImmediateTimeouts(() =>
    invoke(commands.claimTask, { task_id: "P0001" }, context(forge)),
  );
  const envelope = envelopeFromPrBody(openedBody);

  assert.equal(result.ok, true);
  assert.equal(envelope?.command, "campaign.claimTask");
  assert.equal(envelope?.user_id, "9001");
  assert.deepEqual(envelope?.input, { task_id: "P0001" });
  assert.deepEqual(deleted, ["volunteer", "campaign", "claim-P0001-abcd"]);
});

test("a failed automation run surfaces as an error while the PR stays open", async () => {
  const forge = claimForge(21, {
    pr: { headSha: "abc123" },
    getPullRequestState: async () => "open",
    listWorkflowRuns: async (_owner, _repo, _workflow, filter) => {
      assert.equal(filter?.headSha, "abc123");
      return [
        {
          id: 7,
          status: "completed",
          conclusion: "failure",
          created_at: new Date().toISOString(),
          html_url: "https://example.test/run/7",
        },
      ];
    },
  });

  const result = await withImmediateTimeouts(() =>
    invoke(commands.claimTask, { task_id: "P0001" }, context(forge)),
  );

  assert.match(result.error ?? "", /automation run for submission #21 failed/);
  assert.match(result.error ?? "", /example\.test\/run\/7/);
});

test("a skipped automation run is explained and its PR closed by the console", async () => {
  let closed = 0;
  const forge = claimForge(22, {
    pr: { headSha: "def456" },
    getPullRequestState: async () => "open",
    listWorkflowRuns: async () => [
      {
        id: 8,
        status: "completed",
        conclusion: "skipped",
        created_at: new Date().toISOString(),
        html_url: "https://example.test/run/8",
      },
    ],
    closePullRequest: async (_owner, _repo, number) => {
      assert.equal(number, 22);
      closed++;
    },
  });

  const result = await withImmediateTimeouts(() =>
    invoke(commands.claimTask, { task_id: "P0001" }, context(forge)),
  );

  assert.match(
    result.error ?? "",
    /did not run for submission #22: a submission must change at most three files/,
  );
  assert.match(result.error ?? "", /was closed/);
  assert.equal(closed, 1);
});

test("a closed PR without a coordinator verdict fails closed", async () => {
  const forge = claimForge(13, {
    pr: {
      head: {
        owner: "campaign-owner",
        repo: "campaign",
        branch: "claim-P0001-abcd",
      },
    },
    getPullRequestState: async () => "closed",
    getLastIssueComment: async () => null,
  });

  const result = await withImmediateTimeouts(() =>
    invoke(commands.claimTask, { task_id: "P0001" }, context(forge)),
  );

  assert.equal(
    result.error,
    "Submission #13 closed without a coordinator verdict.",
  );
  assert.equal(result.warn, undefined);
});

test("a volunteer encoding submission cleans the encode branch in their fork", async (t) => {
  let pullHead = "";
  let deleted: string[] = [];
  const { result, verdict } = await runEncoding(t, {
    createPullRequest: async (_owner, _repo, options) => {
      pullHead = options.head;
      return { number: 14, html_url: "https://example.test/pr/14" };
    },
    getPullRequestState: async () => "closed",
    getLastIssueComment: async () => "✅ Submission accepted (encoding).",
    deleteBranch: async (owner, repo, branch) => {
      deleted = [owner, repo, branch];
    },
  });

  assert.equal(result.ok, true);
  assert.equal(pullHead, "volunteer:encode-T0001");
  assert.equal(verdict.state, "accepted");
  assert.deepEqual(deleted, ["volunteer", "campaign", "encode-T0001"]);
});

test("a poll failure settles a background submission as timeout, not rejection", async (t) => {
  const { result, verdict } = await runEncoding(t, {
    createPullRequest: async () => ({
      number: 16,
      html_url: "https://example.test/pr/16",
    }),
    getPullRequestState: async () => {
      throw new Error("network down");
    },
  });

  assert.equal(result.ok, true);
  assert.equal(verdict.state, "timeout");
  assert.match(verdict.message, /still being processed/);
});

test("a poll failure leaves a claim as still-processing, not rejected", async () => {
  const forge = claimForge(17, {
    getPullRequestState: async () => {
      throw new Error("network down");
    },
  });

  const result = await withImmediateTimeouts(() =>
    invoke(commands.claimTask, { task_id: "P0001" }, context(forge)),
  );

  assert.equal(result.error, undefined);
  assert.equal(result.ok, true);
  assert.equal(result.warn, true);
  assert.match(result.message ?? "", /still being processed/);
});

test("resolving a comment flips its replies in the PR payload too", async () => {
  const commentCsv =
    "comment_id,task_id,subtask_id,kind,page,measure_start,measure_end,author_id,timestamp,resolved,parent_id,body\n" +
    "c1,T0001,,question,,,,9001,t1,,,Answered?\n" +
    "c2,T0001,,reply,,,,7,t2,,c1,Yes\n" +
    "c3,T0001,,question,,,,9001,t3,,,Other thread\n";
  let serialized = "";
  const forge = fakeForge({
    getRepoSubscription: async () => ({ subscribed: false, ignored: true }),
    getRepoFile: async () => commentCsv,
    openChangePr: async (_owner, _repo, options) => {
      serialized = options.files[0].content ?? "";
      return {
        number: 18,
        html_url: "https://example.test/pr/18",
        head: {
          owner: "campaign-owner",
          repo: "campaign",
          branch: "resolve-c1-abcd",
        },
      };
    },
    getPullRequestState: async () => "closed",
    getLastIssueComment: async () => "✅ Comment resolved.",
  });

  const settled = captureVerdict();
  const { result } = await withImmediateTimeouts(async () => {
    const result = await invoke(
      commands.resolveComment,
      { comment_id: "c1" },
      context(forge),
    );
    return { result, verdict: await settled };
  });

  assert.equal(result.ok, true);
  assert.match(serialized, /c1,T0001,,question,,,,9001,t1,true,,Answered\?/);
  assert.match(serialized, /c2,T0001,,reply,,,,7,t2,true,c1,Yes/);
  assert.match(serialized, /c3,T0001,,question,,,,9001,t3,,,Other thread/);
});

test("a rejected volunteer encoding keeps its fork branch for correction", async (t) => {
  let deleted = false;
  const { result, verdict } = await runEncoding(t, {
    createPullRequest: async () => ({
      number: 15,
      html_url: "https://example.test/pr/15",
    }),
    getPullRequestState: async () => "closed",
    getLastIssueComment: async () => "❌ Submission rejected: `invalid_mei`.",
    deleteBranch: async () => {
      deleted = true;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(verdict.state, "rejected");
  assert.match(verdict.message, /invalid_mei/);
  assert.equal(deleted, false);
});

// What opening the editor reads: the task and its state, and the lock table.
function editorFiles(lockCsv: string): Record<string, string> {
  return {
    "tracking/task.csv":
      "task_id,subtask_id,fragment,locator,allowlist,blocklist,depends_on\nT0001,,sources/score.mei,,,,\n",
    "tracking/state.csv":
      "task_id,subtask_id,status,encoder,encoded_at,validate_status_1\nT0001,,encoding_required,,,\n",
    "tracking/lock.csv": lockCsv,
  };
}

test("openEditor claims first, then starts the task branch from the current score", async () => {
  const files = editorFiles(lockHeader);
  const calls: string[] = [];
  const forge = fakeForge({
    getRepoSubscription: async () => ({ subscribed: false, ignored: true }),
    getRepoFile: async (_owner, _repo, path) => files[path] ?? null,
    openChangePr: async () => {
      calls.push("claim");
      return {
        number: 3,
        html_url: "https://example.test/pr/3",
        head: { owner: "volunteer", repo: "campaign", branch: "claim-x" },
      };
    },
    getPullRequestState: async () => "closed",
    getLastIssueComment: async () => "✅ Claim accepted.",
    getRepoHead: async () => ({
      sha: "head1",
      treeSha: "tree1",
      branch: "main",
      canPush: false,
    }),
    ensureFork: async () => ({ owner: "volunteer", repo: "campaign" }),
    deleteBranch: async (_owner, _repo, branch) => {
      calls.push(`delete ${branch}`);
    },
    createBranch: async (owner, _repo, branch, sha) => {
      calls.push(`create ${owner}/${branch}@${sha}`);
    },
    getRepoFileDownloadUrl: async () => "https://raw.example/score.mei",
  });

  const result = await withImmediateTimeouts(() =>
    invoke(
      commands.openEditor,
      { task_id: "T0001", campaign: "my-campaign", base: "https://le.test" },
      context(forge),
    ),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    "claim",
    "delete encode-T0001",
    "delete claim-x",
    "create volunteer/encode-T0001@head1",
  ]);
  const url = new URL(result.meiFriendUrl!);
  assert.equal(url.origin, "https://mei-friend.example");
  assert.equal(url.searchParams.get("file"), "https://raw.example/score.mei");
  assert.equal(url.searchParams.get("le_campaignname"), "my-campaign");
  assert.equal(url.searchParams.get("le_taskid"), "T0001");
  assert.equal(url.searchParams.get("le_base"), "https://le.test");
});

test("openEditor keeps the holder's work on an existing task branch", async () => {
  const files = editorFiles(
    lockHeader + "T0001,,9001,2026-09-01T00:00:00Z,encoding\n",
  );
  const calls: string[] = [];
  const forge = fakeForge({
    getRepoFile: async (_owner, _repo, path) => files[path] ?? null,
    getRepoHead: async () => ({
      sha: "head1",
      treeSha: "tree1",
      branch: "main",
      canPush: true,
    }),
    createBranch: async () => {
      throw new Error("Reference already exists");
    },
    fastForwardBranch: async () => {
      calls.push("fast-forward");
      return false;
    },
    getRepoFileDownloadUrl: async () => "https://raw.example/score.mei",
  });

  const result = await withImmediateTimeouts(() =>
    invoke(
      commands.openEditor,
      { task_id: "T0001", campaign: "my-campaign", base: "https://le.test" },
      context(forge),
    ),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["fast-forward"]);
});

test("openEditor leaves the task branch alone while someone else holds the claim", async () => {
  const files = editorFiles(
    lockHeader + `T0001,,4242,${new Date().toISOString()},encoding\n`,
  );
  const forge = fakeForge({
    getRepoFile: async (_owner, _repo, path) => files[path] ?? null,
  });

  const result = await invoke(
    commands.openEditor,
    { task_id: "T0001", campaign: "my-campaign", base: "https://le.test" },
    context(forge),
  );

  assert.equal(result.error, "Someone else holds the claim on T0001.");
});

test("an encoding completed without changes gets a commit so its PR can open", async (t) => {
  const calls: string[] = [];
  const { verdict } = await runEncoding(t, {
    getRepoHead: async () => ({
      sha: "head1",
      treeSha: "tree1",
      branch: "main",
      canPush: true,
    }),
    createPullRequest: async () => {
      calls.push("pr");
      if (calls.length === 1)
        throw new Error(
          "Validation Failed: No commits between main and encode-T0001 (422 POST /pulls)",
        );
      return {
        number: 9,
        html_url: "https://example.test/pr/9",
        headSha: "c2",
      };
    },
    commitFiles: async (_owner, _repo, files, _message, opts) => {
      calls.push(`commit ${files[0].path} on ${opts?.branch}`);
      return "c2";
    },
    getPullRequestState: async () => "closed",
    getLastIssueComment: async () => "✅ Submission accepted (encoding).",
    listWorkflowRuns: async () => [],
    deleteBranch: async () => {},
  });

  assert.deepEqual(calls, [
    "pr",
    "commit sources/score.mei on encode-T0001",
    "pr",
  ]);
  assert.equal(verdict.state, "accepted");
});
