import { test, before, type TestContext } from "node:test";
import assert from "node:assert/strict";

import {
  SESSION,
  routeSessionVia,
  getRepoAccess,
  getRepoFile,
  getPullRequest,
  getPullRequestDetails,
  getPullRequestFiles,
  getLastIssueComment,
  searchReposByTopic,
  commentAndClosePr,
  commitFiles,
  ensureFork,
  fastForwardBranch,
  deleteBranch,
  openChangePr,
  RateLimitError,
  getGitHubRequestTelemetry,
  resetGitHubRequestTelemetry,
} from "../forge/github-rest.ts";

before(() => routeSessionVia("/auth/proxy/api.github.com"));

const file = (index: number) => ({
  filename: `sources/${index}.mei`,
  status: "modified",
});

type RecordedCall = {
  url: string;
  method: string;
  body: unknown;
  headers: Headers;
};

// Mock fetch with the Git Data API routes a commit goes through: the base
// commit lookup, blob, tree and commit creation, and the ref update. `extra`
// answers a request before those routes; every request is pushed to `record`.
function gitDataMock(
  t: TestContext,
  {
    record,
    extra,
  }: {
    record?: RecordedCall[];
    extra?: (url: string, method: string) => Response | undefined;
  } = {},
): void {
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      record?.push({
        url,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : null,
        headers: new Headers(init?.headers),
      });
      const answered = extra?.(url, method);
      if (answered) return answered;
      if (url.endsWith("/git/commits/base-sha"))
        return Response.json({ tree: { sha: "base-tree" } });
      if (url.endsWith("/git/blobs"))
        return Response.json({ sha: "binary-blob" });
      if (url.endsWith("/git/trees")) return Response.json({ sha: "new-tree" });
      if (url.endsWith("/git/commits"))
        return Response.json({ sha: "new-commit" });
      if (url.includes("/git/refs/heads/") && method === "PATCH")
        return Response.json({});
      throw new Error(`Unexpected request: ${method} ${url}`);
    },
  );
}

test("getPullRequestFiles reads every page before returning the PR boundary", async (t) => {
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return Response.json([file(100)]);
  });

  const files = await getPullRequestFiles(
    "token",
    "owner",
    "repo",
    7,
    101,
    Array.from({ length: 100 }, (_, i) => file(i)),
  );
  assert.equal(files.length, 101);
  assert.deepEqual(
    urls.map((url) => new URL(url).searchParams.get("page")),
    ["2"],
  );
});

test("getPullRequestFiles fails closed when GitHub returns a partial list", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json([]));
  await assert.rejects(
    getPullRequestFiles("token", "owner", "repo", 7, 101, [file(0)]),
    /Incomplete pull-request file list: expected 101, received 1/,
  );
});

test("getPullRequestFiles rejects PRs beyond GitHub’s inspection limit without fetching", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () =>
    Response.json([]),
  );
  await assert.rejects(
    getPullRequestFiles("token", "owner", "repo", 7, -1, []),
    /invalid changed-file count/,
  );
  await assert.rejects(
    getPullRequestFiles("token", "owner", "repo", 7, 1.5, []),
    /invalid changed-file count/,
  );
  await assert.rejects(
    getPullRequestFiles("token", "owner", "repo", 7, 3001, []),
    /3,000-file inspection limit/,
  );
  assert.equal(fetch.mock.callCount(), 0);
});

test("getLastIssueComment follows the Link header to the newest comment", async (t) => {
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const page = new URL(url).searchParams.get("page");
    if (page === "3") return Response.json([{ body: "newest verdict" }]);
    return Response.json([{ body: "oldest comment" }], {
      headers: {
        Link: '<https://api.github.com/repos/owner/paged/issues/7/comments?per_page=1&page=2>; rel="next", <https://api.github.com/repos/owner/paged/issues/7/comments?per_page=1&page=3>; rel="last"',
      },
    });
  });
  assert.equal(
    await getLastIssueComment("token", "owner", "paged", 7),
    "newest verdict",
  );
  assert.deepEqual(
    urls.map((url) => new URL(url).searchParams.get("page")),
    [null, "3"],
  );
});

test("getLastIssueComment without pagination returns the only comment, or null", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json([{ body: "only comment" }]);
  });
  assert.equal(
    await getLastIssueComment("token", "owner", "single", 7),
    "only comment",
  );
  assert.equal(calls, 1);
  t.mock.method(globalThis, "fetch", async () => Response.json([]));
  assert.equal(
    await getLastIssueComment("token", "owner", "no-comments", 7),
    null,
  );
});

test("getRepoFile falls back to the raw media type when inline content is unavailable", async (t) => {
  const accepts: Array<string | null> = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      const accept = new Headers(init?.headers).get("Accept");
      accepts.push(accept);
      if (accept === "application/vnd.github.raw")
        return new Response("large file text");
      return Response.json({ content: "", encoding: "none", sha: "blob-sha" });
    },
  );
  assert.equal(
    await getRepoFile("token", "owner", "large", "big.mei"),
    "large file text",
  );
  assert.equal(accepts.at(-1), "application/vnd.github.raw");
});

test("getRepoFile rejects a directory path instead of returning empty content", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json([{ name: "a.mei" }]),
  );
  await assert.rejects(
    getRepoFile("token", "owner", "dir", "sources"),
    /sources: the path is a directory/,
  );
});

test("searchReposByTopic reads every search page", async (t) => {
  const urls: string[] = [];
  const item = (i: number) => ({
    id: i,
    full_name: `owner/repo-${i}`,
    name: `repo-${i}`,
    owner: { login: "owner" },
    html_url: `https://example.test/repo-${i}`,
    private: false,
    description: null,
    updated_at: "2026-08-14T00:00:00Z",
    created_at: "2026-08-01T00:00:00Z",
  });
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const page = new URL(url).searchParams.get("page");
    return Response.json({
      items:
        page === "1"
          ? Array.from({ length: 100 }, (_, i) => item(i))
          : [item(100)],
    });
  });
  const repos = await searchReposByTopic("paged-topic", "token");
  assert.equal(repos.length, 101);
  assert.deepEqual(
    urls.map((url) => new URL(url).searchParams.get("page")),
    ["1", "2"],
  );
});

test("SESSION routes through the broker without exposing an Authorization header", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(
        String(input),
        "/auth/proxy/api.github.com/repos/owner/repo",
      );
      assert.equal(new Headers(init?.headers).get("Authorization"), null);
      return Response.json({ private: true, permissions: { push: true } });
    },
  );
  assert.deepEqual(await getRepoAccess(SESSION, "owner", "repo"), {
    isPrivate: true,
    canPush: true,
  });
});

test("JSON reads reuse a cached ETag body after a 304 response", async (t) => {
  let call = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      const etag = new Headers(init?.headers).get("If-None-Match");
      if (call++ === 0) {
        assert.equal(etag, null);
        return Response.json(
          { private: false, permissions: { push: true } },
          { headers: { ETag: '"repo-v1"' } },
        );
      }
      assert.equal(etag, '"repo-v1"');
      return new Response(null, { status: 304 });
    },
  );
  const first = await getRepoAccess("token", "etag-owner", "etag-repo");
  const second = await getRepoAccess("token", "etag-owner", "etag-repo");
  assert.deepEqual(second, first);
});

test("commitFiles builds one tree and advances the requested branch from the supplied base", async (t) => {
  const calls: RecordedCall[] = [];
  gitDataMock(t, { record: calls });

  const sha = await commitFiles(
    "token",
    "owner",
    "repo",
    [
      { path: "tracking/state.csv", content: "state" },
      { path: "sources/page.jpg", contentBase64: "aW1hZ2U=" },
    ],
    "Update campaign",
    { baseSha: "base-sha", branch: "work" },
  );
  assert.equal(sha, "new-commit");
  assert.equal(calls[0].headers.get("Authorization"), "Bearer token");
  assert.deepEqual(
    calls.find((call) => call.url.endsWith("/git/trees"))?.body,
    {
      base_tree: "base-tree",
      tree: [
        {
          path: "tracking/state.csv",
          mode: "100644",
          type: "blob",
          content: "state",
        },
        {
          path: "sources/page.jpg",
          mode: "100644",
          type: "blob",
          sha: "binary-blob",
        },
      ],
    },
  );
  assert.deepEqual(
    calls.find((call) => call.url.endsWith("/git/commits"))?.body,
    {
      message: "Update campaign",
      tree: "new-tree",
      parents: ["base-sha"],
    },
  );
  assert.deepEqual(calls.at(-1)?.body, { sha: "new-commit" });
});

test("commitFiles removes the paths it is told to delete in the same commit", async (t) => {
  const calls: RecordedCall[] = [];
  gitDataMock(t, { record: calls });

  await commitFiles(
    "token",
    "owner",
    "repo",
    [{ path: "sources/img/01.jpg", content: "kept" }],
    "Update source images",
    {
      baseSha: "base-sha",
      branch: "main",
      deletePaths: ["sources/img/02.jpg"],
    },
  );
  assert.deepEqual(
    calls.find((call) => call.url.endsWith("/git/trees"))?.body,
    {
      base_tree: "base-tree",
      tree: [
        {
          path: "sources/img/01.jpg",
          mode: "100644",
          type: "blob",
          content: "kept",
        },
        { path: "sources/img/02.jpg", mode: "100644", type: "blob", sha: null },
      ],
    },
  );
});

test("commitFiles reports each binary upload against the number of them", async (t) => {
  gitDataMock(t);

  const progress: Array<[number, number]> = [];
  await commitFiles(
    "token",
    "owner",
    "repo",
    [
      { path: "sources/img/01.jpg", contentBase64: "aW1hZ2U=" },
      { path: "campaign.json", content: "{}" },
      { path: "sources/img/02.jpg", contentBase64: "aW1hZ2U=" },
    ],
    "Add source images",
    {
      baseSha: "base-sha",
      branch: "main",
      onUpload: (uploaded, total) => progress.push([uploaded, total]),
    },
  );
  assert.deepEqual(progress, [
    [1, 2],
    [2, 2],
  ]);
});

test("commitFiles rejects ambiguous file content before making a request", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () =>
    Response.json({}),
  );
  const commit = (file: {
    path: string;
    content?: string;
    contentBase64?: string;
  }) =>
    commitFiles("token", "owner", "repo", [file], "Invalid update", {
      baseSha: "base-sha",
      branch: "work",
    });
  await assert.rejects(
    commit({ path: "empty.txt" }),
    /exactly one of content or contentBase64/,
  );
  await assert.rejects(
    commit({
      path: "ambiguous.txt",
      content: "text",
      contentBase64: "dGV4dA==",
    }),
    /exactly one of content or contentBase64/,
  );
  assert.equal(fetch.mock.callCount(), 0);
});

test("ensureFork waits for readiness and syncs its default branch with upstream", async (t) => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body });
      if (url.endsWith("/repos/upstream-owner/score/forks")) {
        return Response.json(
          { full_name: "volunteer/score", default_branch: "main" },
          { status: 202 },
        );
      }
      if (url.endsWith("/repos/volunteer/score/git/ref/heads/main"))
        return Response.json({ object: { sha: "fork-sha" } });
      if (url.endsWith("/repos/volunteer/score/merge-upstream"))
        return Response.json({ merge_type: "fast-forward" });
      throw new Error(`Unexpected request: ${method} ${url}`);
    },
  );

  assert.deepEqual(await ensureFork("token", "upstream-owner", "score"), {
    owner: "volunteer",
    repo: "score",
  });
  assert.deepEqual(calls.at(-1), {
    url: "https://api.github.com/repos/volunteer/score/merge-upstream",
    method: "POST",
    body: { branch: "main" },
  });
});

test("fastForwardBranch distinguishes non-fast-forward conflicts from API failures", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    if (String(input).includes("/conflict/")) {
      return Response.json(
        { message: "Update is not a fast forward" },
        { status: 422 },
      );
    }
    return Response.json(
      { message: "Resource not accessible by integration" },
      { status: 403 },
    );
  });

  assert.equal(
    await fastForwardBranch("token", "owner", "conflict", "work", "sha"),
    false,
  );
  await assert.rejects(
    fastForwardBranch("token", "owner", "forbidden", "work", "sha"),
    /Resource not accessible by integration/,
  );
});

test("deleteBranch does not hide arbitrary 422 responses", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    if (String(input).includes("/missing/")) {
      return Response.json(
        { message: "Reference does not exist" },
        { status: 422 },
      );
    }
    return Response.json(
      { message: "Cannot delete the default branch" },
      { status: 422 },
    );
  });

  await deleteBranch("token", "owner", "missing", "work");
  await assert.rejects(
    deleteBranch("token", "owner", "protected", "main"),
    /Cannot delete the default branch/,
  );
});

test("openChangePr removes its prepared branch when PR creation fails", async (t) => {
  let deleted = false;
  gitDataMock(t, {
    extra: (url, method) => {
      if (url.endsWith("/repos/lifecycle-owner/score") && method === "GET") {
        return Response.json({
          default_branch: "main",
          permissions: { push: true },
        });
      }
      if (url.endsWith("/branches/main")) {
        return Response.json({
          commit: { sha: "base-sha", commit: { tree: { sha: "base-tree" } } },
        });
      }
      if (url.endsWith("/git/refs") && method === "POST")
        return Response.json({}, { status: 201 });
      if (url.endsWith("/pulls") && method === "POST") {
        return Response.json(
          {
            message: "Validation Failed",
            errors: [{ message: "No commits between main and work" }],
          },
          { status: 422 },
        );
      }
      if (url.endsWith("/git/refs/heads/work") && method === "DELETE") {
        deleted = true;
        return new Response(null, { status: 204 });
      }
      return undefined;
    },
  });

  await assert.rejects(
    openChangePr("token", "lifecycle-owner", "score", {
      branch: "work",
      files: [{ path: "tracking/lock.csv", content: "lock" }],
      message: "Prepare claim",
      title: "Claim",
      body: "Claim body",
    }),
    /No commits between main and work/,
  );
  assert.equal(deleted, true);
});

test("403 and 429 responses are rate limits only when GitHub or the broker reports one", async (t) => {
  t.mock.method(console, "info", () => {});
  const cases: Array<{
    label: string;
    status: number;
    headers?: Record<string, string>;
    body: unknown;
    request: () => Promise<unknown>;
    expect: (error: unknown) => boolean;
    rateLimited?: number;
  }> = [
    {
      label: "secondary rate limit with primary quota remaining",
      status: 403,
      headers: { "X-RateLimit-Remaining": "42", "Retry-After": "30" },
      body: { message: "You have exceeded a secondary rate limit." },
      request: () => getPullRequestDetails("token", "owner", "repo", 7),
      expect: (error) =>
        error instanceof RateLimitError &&
        error.source === "github" &&
        error.remaining === 42 &&
        error.retryAfterSeconds === 30,
    },
    {
      label: "broker throttling",
      status: 429,
      headers: { "X-Lets-Encode-Upstream": "broker" },
      body: {
        error: "OAuth broker request rate limit exceeded",
        source: "broker",
      },
      request: () => getPullRequestDetails(SESSION, "owner", "repo", 7),
      expect: (error) =>
        error instanceof RateLimitError &&
        error.source === "broker" &&
        /Too many requests were sent in a short time/.test(error.message),
      rateLimited: 1,
    },
    {
      label: "broker origin rejection",
      status: 403,
      headers: { "X-Lets-Encode-Upstream": "broker" },
      body: { error: "cross-origin request rejected" },
      request: () => commentAndClosePr(SESSION, "owner", "repo", 7, "verdict"),
      expect: (error) =>
        error instanceof Error &&
        !(error instanceof RateLimitError) &&
        /cross-origin request rejected/.test(error.message),
    },
    {
      label: "ordinary permission failure",
      status: 403,
      body: { message: "Resource not accessible by integration" },
      request: () => getPullRequestDetails("token", "owner", "repo", 7),
      expect: (error) =>
        error instanceof Error &&
        !(error instanceof RateLimitError) &&
        /Resource not accessible/.test(error.message),
    },
  ];
  for (const row of cases) {
    resetGitHubRequestTelemetry();
    t.mock.method(globalThis, "fetch", async () =>
      Response.json(row.body, { status: row.status, headers: row.headers }),
    );
    await assert.rejects(row.request, row.expect, row.label);
    if (row.rateLimited !== undefined)
      assert.equal(
        getGitHubRequestTelemetry().rateLimited,
        row.rateLimited,
        row.label,
      );
  }
});

test("a rate-limit message suggests logging in only when the request was logged out", async (t) => {
  t.mock.method(console, "info", () => {});
  // 2_000_000_000 is 20 seconds into a minute; the message rounds up to the next.
  const at = new Date(2_000_000_040_000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { message: "API rate limit exceeded" },
      {
        status: 403,
        headers: {
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": "2000000000",
        },
      },
    ),
  );

  await assert.rejects(
    searchReposByTopic("topic"),
    (e: unknown) =>
      e instanceof RateLimitError &&
      e.anonymous &&
      e.message ===
        `GitHub allows only a limited number of requests without logging in, and that limit has been reached. Try again at ${at}, or log in with GitHub to continue now.`,
  );
  await assert.rejects(
    searchReposByTopic("topic", "token"),
    (e: unknown) =>
      e instanceof RateLimitError &&
      !e.anonymous &&
      e.message ===
        `GitHub's request limit has been reached. Try again at ${at}.`,
  );
});

test("request telemetry records rate headers without query strings", async (t) => {
  resetGitHubRequestTelemetry();
  t.mock.method(console, "info", () => {});
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { private: false, permissions: { push: true } },
      {
        headers: {
          "X-RateLimit-Resource": "core",
          "X-RateLimit-Limit": "5000",
          "X-RateLimit-Remaining": "4998",
          "X-RateLimit-Used": "2",
          "X-RateLimit-Reset": "2000000000",
        },
      },
    ),
  );

  await getRepoAccess("token", "telemetry-owner", "telemetry-repo");
  const telemetry = getGitHubRequestTelemetry();
  assert.equal(telemetry.total, 1);
  assert.deepEqual(telemetry.byMethod, { GET: 1 });
  assert.deepEqual(telemetry.byResource, { core: 1 });
  assert.equal(
    telemetry.last?.endpoint,
    "/repos/telemetry-owner/telemetry-repo",
  );
  assert.equal(telemetry.last?.remaining, 4998);
  assert.equal(telemetry.last?.limit, 5000);
  assert.equal(telemetry.last?.used, 2);
});

test("a GET failing with a 5xx is retried", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () =>
    ++calls === 1
      ? Response.json({ message: "Server Error" }, { status: 502 })
      : Response.json({
          body: "b",
          changed_files: 1,
          state: "open",
          head: { sha: "h" },
        }),
  );
  const details = await getPullRequestDetails("token", "owner", "repo", 7);
  assert.equal(details.headSha, "h");
  assert.equal(calls, 2);
});

const unavailableDiff = () =>
  Response.json(
    {
      message:
        "Sorry, this diff is temporarily unavailable due to heavy server load.",
    },
    { status: 500 },
  );
const oneCommitPr = {
  changed_files: 1,
  commits: 1,
  state: "open",
  head: { sha: "head" },
  base: { sha: "base" },
};

test("getPullRequest takes a one-commit PR’s files from its commit when the diff is unavailable", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/pulls/7/files")) return unavailableDiff();
    if (path.endsWith("/commits/head"))
      return Response.json({
        parents: [{ sha: "base" }],
        files: [{ ...file(1), patch: "@@" }],
      });
    return Response.json(oneCommitPr);
  });
  const pr = await getPullRequest("token", "owner", "repo", 7);
  assert.deepEqual(pr.files, [
    { filename: "sources/1.mei", status: "modified", patch: "@@" },
  ]);
});

test("getPullRequest keeps the diff error when the commit does not sit on the base", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/pulls/7/files")) return unavailableDiff();
    if (path.endsWith("/commits/head"))
      return Response.json({ parents: [{ sha: "older" }], files: [file(1)] });
    return Response.json(oneCommitPr);
  });
  await assert.rejects(
    getPullRequest("token", "owner", "repo", 7),
    /diff is temporarily unavailable/,
  );
});
