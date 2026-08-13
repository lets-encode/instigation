// Run profiler for a campaign repo's Actions — dumps per-step timings of every
// caller.yml workflow run as CSV on stdout (progress and errors go to stderr).
//
// One row per workflow step, from the jobs API's own step timestamps:
//   run_id, event, pr_number, pr_kind, queue_s, step_name, step_s, conclusion, detail
// plus synthetic rows per run sharing the same columns:
//   job_total                 — the job's started_at → completed_at wall time
//   pr_created_to_run_created — PR creation → run creation gap (PR runs only)
//   coordinator/<phase>       — the coordinator's `[phase-timing]` log lines
//   github-api-summary        — the coordinator's request telemetry, JSON in `detail`
// `queue_s` is the run's created_at → run_started_at gap (runner queue time).
//
// PR runs are joined to their pull request via head SHA and classified with
// the same classifyPullRequest the coordinator applies to the changed files.
//
// Env: GH_TOKEN — a token that can read the repo and its Actions runs/logs.
// Usage: GH_TOKEN=... node scripts/profile-actions.ts <owner>/<repo> > steps.csv

import { classifyPullRequest } from "../src/lib/coordinator-policy.ts";

const API = "https://api.github.com";
const WORKFLOW = "caller.yml";

const token = process.env.GH_TOKEN ?? "";
const [owner, repo] = (process.argv[2] ?? "").split("/");
if (!token || !owner || !repo) {
  console.error(
    "Usage: GH_TOKEN=<token> node scripts/profile-actions.ts <owner>/<repo> > steps.csv",
  );
  process.exit(1);
}

const headers = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  Authorization: `Bearer ${token}`,
};

// fetch with retries on network errors (connection resets, read timeouts),
// which otherwise abort a long collection run partway through.
async function fetchRetry(url: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      if (attempt === 3) throw e;
      console.error(`fetch ${url} failed (attempt ${attempt}), retrying: ${(e as Error).message}`);
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
}

async function api<T>(path: string): Promise<T> {
  const res = await fetchRetry(`${API}${path}`, { headers });
  if (!res.ok) {
    throw new Error(`GET ${path} failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// GitHub reads

interface RunInfo {
  id: number;
  event: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  run_started_at: string | null;
  head_sha: string;
  pull_requests: Array<{ number: number }>;
}

async function listRuns(): Promise<RunInfo[]> {
  const runs: RunInfo[] = [];
  for (let page = 1; ; page++) {
    const data = await api<{ workflow_runs: RunInfo[] }>(
      `/repos/${owner}/${repo}/actions/workflows/${WORKFLOW}/runs?per_page=100&page=${page}`,
    );
    runs.push(...data.workflow_runs);
    if (data.workflow_runs.length < 100) return runs;
  }
}

interface PullInfo {
  number: number;
  created_at: string;
  head: { sha: string };
}

async function listPulls(): Promise<PullInfo[]> {
  const pulls: PullInfo[] = [];
  for (let page = 1; ; page++) {
    const data = await api<PullInfo[]>(
      `/repos/${owner}/${repo}/pulls?state=all&per_page=100&page=${page}`,
    );
    pulls.push(...data);
    if (data.length < 100) return pulls;
  }
}

interface JobInfo {
  id: number;
  name: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  steps: Array<{
    name: string;
    conclusion: string | null;
    started_at: string | null;
    completed_at: string | null;
  }>;
}

const listJobs = async (runId: number): Promise<JobInfo[]> =>
  (
    await api<{ jobs: JobInfo[] }>(
      `/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=100`,
    )
  ).jobs;

// A campaign PR changes at most a handful of files, so one page is the list.
const kindCache = new Map<number, string>();
async function prKind(prNumber: number): Promise<string> {
  const cached = kindCache.get(prNumber);
  if (cached) return cached;
  const files = await api<Array<{ filename: string }>>(
    `/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`,
  );
  const kind = classifyPullRequest(files.map((f) => f.filename));
  kindCache.set(prNumber, kind);
  return kind;
}

// The logs endpoint answers with a redirect to a short-lived signed URL that
// must be fetched WITHOUT the Authorization header, so the redirect is
// followed by hand. Expired logs (404/410) yield an empty string.
async function jobLog(jobId: number): Promise<string> {
  const res = await fetchRetry(
    `${API}/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`,
    { headers, redirect: "manual" },
  );
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location");
    if (!location) throw new Error(`Job ${jobId} log redirect had no location`);
    const raw = await fetchRetry(location);
    if (!raw.ok) throw new Error(`Job ${jobId} log fetch failed (${raw.status})`);
    return await raw.text();
  }
  if (res.ok) return await res.text();
  if (res.status === 404 || res.status === 410) return "";
  throw new Error(`Job ${jobId} logs failed (${res.status}): ${await res.text()}`);
}

// ---------------------------------------------------------------------------
// CSV output

const csv = (value: string | number | null): string => {
  const s = value == null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

const emit = (cells: Array<string | number | null>): void =>
  console.log(cells.map(csv).join(","));

const seconds = (
  from: string | null | undefined,
  to: string | null | undefined,
): number | null =>
  from && to ? (Date.parse(to) - Date.parse(from)) / 1000 : null;

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const [runs, pulls] = await Promise.all([listRuns(), listPulls()]);
  console.error(`${owner}/${repo}: ${runs.length} ${WORKFLOW} runs, ${pulls.length} PRs`);
  const pullByHeadSha = new Map(pulls.map((pr) => [pr.head.sha, pr]));
  const pullByNumber = new Map(pulls.map((pr) => [pr.number, pr]));

  emit([
    "run_id",
    "event",
    "pr_number",
    "pr_kind",
    "queue_s",
    "step_name",
    "step_s",
    "conclusion",
    "detail",
  ]);

  // Oldest first, so consecutive rows read in session order.
  for (const run of runs.reverse()) {
    const pull =
      pullByHeadSha.get(run.head_sha) ??
      (run.pull_requests[0] ? pullByNumber.get(run.pull_requests[0].number) : undefined);
    const isPrRun = run.event.startsWith("pull_request");
    const prNumber = isPrRun ? (pull?.number ?? null) : null;
    const kind = isPrRun ? (pull ? await prKind(pull.number) : "unknown") : "";
    const queue = seconds(run.created_at, run.run_started_at);
    const base = [run.id, run.event, prNumber, kind, queue] as const;
    console.error(
      `run ${run.id} (${run.event}${prNumber ? ` PR #${prNumber}` : ""}, ${run.conclusion ?? run.status})`,
    );

    if (isPrRun && pull) {
      emit([
        ...base,
        "pr_created_to_run_created",
        seconds(pull.created_at, run.created_at),
        run.conclusion,
        "",
      ]);
    }

    for (const job of await listJobs(run.id)) {
      emit([
        ...base,
        "job_total",
        seconds(job.started_at, job.completed_at),
        job.conclusion,
        "",
      ]);
      // The full pre-execution wait. A run held by the workflow's concurrency
      // group reports run_started_at == created_at (queue_s misses the hold);
      // only the job's started_at shows when work actually began.
      emit([
        ...base,
        "run_created_to_job_started",
        seconds(run.created_at, job.started_at),
        job.conclusion,
        "",
      ]);
      for (const step of job.steps) {
        emit([
          ...base,
          step.name,
          seconds(step.started_at, step.completed_at),
          step.conclusion,
          "",
        ]);
      }

      const log = await jobLog(job.id);
      for (const [, phase, secs] of log.matchAll(
        /\[phase-timing\] (\S+) ([\d.]+)s/g,
      )) {
        emit([...base, `coordinator/${phase}`, Number(secs), "", ""]);
      }
      const summary = /\[github-api-summary\] (\{.*\})/.exec(log);
      if (summary) {
        emit([...base, "github-api-summary", null, "", summary[1]]);
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
