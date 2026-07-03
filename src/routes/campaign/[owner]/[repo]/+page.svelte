<script lang="ts">
  import { page } from "$app/state";
  import { auth, login, forge } from "$lib/auth.svelte.ts";
  import { meiFriendUrl } from "$lib/forge/config.ts";
  import type { ForgeClient } from "$lib/forge/types.ts";
  import {
    parseTaskCsv,
    parseStateCsv,
    parseLockCsv,
    serializeStateCsv,
    serializeLockCsv,
    findRow,
  } from "$lib/campaign-tables.ts";
  import type { TaskRow, StateRow, LockRow } from "$lib/campaign-tables.ts";

  const TASK_PATH = "tracking/task.csv";
  const STATE_PATH = "tracking/state.csv";
  const LOCK_PATH = "tracking/lock.csv";
  const rand = () => crypto.randomUUID().slice(0, 8);

  // Guaranteed present by the [owner]/[repo] route.
  const owner = $derived(page.params.owner!);
  const repo = $derived(page.params.repo!);
  const viewer = $derived(auth.user?.login ?? "");

  type Result = {
    ok?: boolean;
    warn?: boolean;
    error?: string;
    message?: string;
    prUrl?: string;
    meiFriendUrl?: string;
    rawUrl?: string;
  } | null;

  let loading = $state(false);
  let loaded = $state(false);
  let loadError = $state<string | null>(null);
  let notInitialised = $state(false);
  let isPrivate = $state(false);
  let taskDefs = $state<TaskRow[]>([]);
  let rows = $state<StateRow[]>([]);
  let validationColumns = $state<string[]>([]);
  let locks = $state<LockRow[]>([]);

  // Rows with an empty subtask_id address the whole task (the encoding unit);
  // the others are its validation subtasks.
  const taskRows = $derived(rows.filter((r) => r.subtask_id === ""));
  const subtaskRows = $derived(rows.filter((r) => r.subtask_id !== ""));

  let busy = $state(false);
  let busyMessage = $state("");
  let result = $state<Result>(null);

  let preview = $state<{
    taskId: string;
    loading: boolean;
    svg?: string;
    error?: string;
    page: number;
    pageCount: number;
  } | null>(null);

  // Verovio is a ~2 MB WASM module — loaded on first preview, then reused.
  let verovio: import("verovio/esm").VerovioToolkit | null = null;
  async function getVerovio() {
    if (!verovio) {
      const [{ default: createVerovioModule }, { VerovioToolkit }] =
        await Promise.all([import("verovio/wasm"), import("verovio/esm")]);
      verovio = new VerovioToolkit(await createVerovioModule());
      verovio.setOptions({
        pageWidth: 2100,
        pageHeight: 2970,
        adjustPageHeight: true,
        scale: 40,
        footer: "none",
        svgViewBox: true,
      });
    }
    return verovio;
  }

  async function togglePreview(task_id: string) {
    if (preview?.taskId === task_id) {
      preview = null;
      return;
    }
    const f = forge();
    if (!f) return;
    preview = { taskId: task_id, loading: true, page: 1, pageCount: 1 };
    try {
      const fragment = fragmentOf(task_id);
      if (!fragment) throw new Error(`Unknown task ${task_id}.`);
      const [mei, tk] = await Promise.all([
        f.getRepoFile(owner, repo, fragment),
        getVerovio(),
      ]);
      if (mei == null) throw new Error(`Could not read ${fragment}.`);
      if (!tk.loadData(mei))
        throw new Error(`Verovio could not parse ${fragment}.`);
      const pageCount = tk.getPageCount();
      const svg = tk.renderToSVG(1);
      if (preview?.taskId === task_id)
        preview = { taskId: task_id, loading: false, svg, page: 1, pageCount };
    } catch (e) {
      if (preview?.taskId === task_id)
        preview = {
          taskId: task_id,
          loading: false,
          error: `Preview failed: ${(e as Error).message}`,
          page: 1,
          pageCount: 1,
        };
    }
  }

  // Pages stay loaded in the toolkit, so flipping is a pure re-render.
  function previewPage(page: number) {
    if (!preview || !verovio || page < 1 || page > preview.pageCount) return;
    preview = { ...preview, page, svg: verovio.renderToSVG(page) };
  }

  const copy = (text: string) =>
    navigator.clipboard?.writeText(text).catch(() => {});
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Wait until the campaign automation has processed a PR (it closes the PR
  // when done) and return its verdict comment. Null on timeout — the run is
  // then still in flight, not failed.
  async function waitForPrProcessed(
    f: ForgeClient,
    prNumber: number,
  ): Promise<string | null> {
    busyMessage = `Campaign automation is processing PR #${prNumber}…`;
    console.log("[pr] waiting for automation to process PR", prNumber);
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await sleep(3000);
      if ((await f.getPullRequestState(owner, repo, prNumber)) === "closed") {
        const verdict = await f.getLastIssueComment(owner, repo, prNumber);
        console.log("[pr] PR", prNumber, "processed; verdict:", verdict);
        return verdict;
      }
    }
    console.log("[pr] PR", prNumber, "not processed within 120s (still in flight)");
    return null;
  }

  // Map the automation's verdict on a PR to a result banner: a rejection is an
  // error (never shown as success), no verdict yet (timeout) is a warning.
  function verdictResult(
    verdict: string | null,
    prNumber: number,
    prUrl: string,
    fallback: string,
  ): Result {
    if (verdict == null) {
      return {
        ok: true,
        warn: true,
        prUrl,
        message: `${fallback} PR #${prNumber} is still being processed — refresh the tables in a moment.`,
      };
    }
    if (verdict.startsWith("❌")) return { error: verdict, prUrl };
    return { ok: true, prUrl, message: verdict };
  }

  // Mute the campaign repo's notifications for this user, once: skipped when
  // this browser has muted it before, or when the user has an explicit
  // subscription of their own (e.g. deliberately watching). Non-fatal — each
  // token can only mute its own user.
  async function muteOnce(f: ForgeClient) {
    const key = `lets-encode:muted:${owner}/${repo}`;
    if (localStorage.getItem(key)) return;
    try {
      if ((await f.getRepoSubscription(owner, repo)) == null) {
        await f.ignoreRepoNotifications(owner, repo);
      }
      localStorage.setItem(key, "1");
    } catch (e) {
      console.warn("Could not mute repo notifications:", (e as Error).message);
    }
  }

  const lockFor = (taskId: string, subtaskId: string, kind: string) =>
    locks.find(
      (l) =>
        l.task_id === taskId && l.subtask_id === subtaskId && l.kind === kind,
    );
  const myEncodingLock = (taskId: string) =>
    locks.find(
      (l) =>
        l.task_id === taskId &&
        l.subtask_id === "" &&
        l.kind === "encoding" &&
        l.user_id === viewer,
    );
  const encoderOf = (taskId: string) =>
    findRow(rows, taskId, "")?.encoder ?? "";
  const fragmentOf = (taskId: string) =>
    findRow(taskDefs, taskId, "")?.fragment;

  // Read the tracking tables (and privacy) for the console. Only the first read
  // shows the loading state; refreshes update the tables in place.
  async function load() {
    const f = forge();
    if (!f) return;
    if (!loaded) loading = true;
    loadError = null;
    try {
      const [taskCsv, stateCsv, lockCsv, priv] = await Promise.all([
        f.getRepoFile(owner, repo, TASK_PATH),
        f.getRepoFile(owner, repo, STATE_PATH),
        f.getRepoFile(owner, repo, LOCK_PATH),
        f.getRepoIsPrivate(owner, repo),
      ]);
      isPrivate = priv;
      if (taskCsv == null || stateCsv == null || lockCsv == null) {
        notInitialised = true;
        taskDefs = [];
        rows = [];
        validationColumns = [];
        locks = [];
      } else {
        notInitialised = false;
        taskDefs = parseTaskCsv(taskCsv);
        const state = parseStateCsv(stateCsv);
        rows = state.rows;
        validationColumns = state.validationColumns;
        locks = parseLockCsv(lockCsv);
        console.log(
          "[load] tables loaded:",
          taskDefs.length, "task(s),",
          rows.length, "state row(s),",
          locks.length, "lock(s)",
        );
      }
      loaded = true;
    } catch (e) {
      loadError = `Could not read ${owner}/${repo}: ${(e as Error).message}`;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (auth.status === "authenticated" && owner && repo && !loaded) load();
  });

  // Run an action: show the busy overlay, capture its result banner, then
  // refresh the tables.
  async function run(action: (f: ForgeClient) => Promise<Result>) {
    const f = forge();
    if (!f) return;
    busy = true;
    busyMessage = "Working…";
    try {
      result = await action(f);
      busyMessage = "Refreshing tables…";
      await load();
    } finally {
      busy = false;
      busyMessage = "";
    }
  }

  // Open a PR that adds a lock row (the Action re-authors who/when). Shared by the
  // claim action and "open in mei-friend" (where opening == claiming).
  async function openClaimPr(
    f: ForgeClient,
    task_id: string,
    subtask_id: string,
    kind: string,
  ) {
    // Claiming is a user's first interaction with a campaign: mute the repo's
    // notifications for them, or the automation's PR comments would email
    // every participant.
    await muteOnce(f);
    const lockRows = parseLockCsv(
      (await f.getRepoFile(owner, repo, LOCK_PATH)) ?? "",
    );
    lockRows.push({
      task_id,
      subtask_id,
      user_id: viewer,
      timestamp: new Date().toISOString(),
      kind,
    });
    const target = subtask_id ? `${task_id}/${subtask_id}` : task_id;
    console.log("[claim] opening claim PR", { task_id, subtask_id, kind, user: viewer });
    return f.openChangePr(owner, repo, {
      branch: `claim-${task_id}${subtask_id ? "-" + subtask_id : ""}-${rand()}`,
      files: [{ path: LOCK_PATH, content: serializeLockCsv(lockRows) }],
      message: `Claim ${target} (${kind})`,
      title: `Claim ${target} (${kind})`,
      body: `Reserves ${target} for ${kind} work by @${viewer}. Opened from the campaign console.`,
    });
  }

  const claim = (task_id: string, subtask_id: string) =>
    run(async (f) => {
      try {
        busyMessage = "Opening claim PR…";
        const pr = await openClaimPr(f, task_id, subtask_id, "validation");
        console.log("[claim] claim PR opened", pr.number, pr.html_url);
        const verdict = await waitForPrProcessed(f, pr.number);
        return verdictResult(
          verdict,
          pr.number,
          pr.html_url,
          `Opened claim PR #${pr.number} for ${task_id}/${subtask_id} (validation).`,
        );
      } catch (e) {
        return { error: `Claim failed: ${(e as Error).message}` };
      }
    });

  // Open the task's score in mei-friend; opening for editing also opens an
  // encoding claim PR (unless you already hold the lock). The mei-friend tab
  // opens only after the claim has gone through — never on a rejected or
  // still-pending claim — so it waits until the busy overlay is gone.
  const editor = async (task_id: string) => {
    await run(async (f) => {
      try {
        const fragment = fragmentOf(task_id);
        const task = findRow(rows, task_id, "");
        if (!fragment || !task) return { error: `Unknown task ${task_id}.` };

        busyMessage = "Preparing the score for mei-friend…";
        const { sha, canPush } = await f.getRepoHead(owner, repo);
        console.log("[editor] task", task_id, "fragment", fragment, "mainHead", sha, "canPush", canPush);

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
          console.log("[editor] created branch", ref, "in", `${workRepo.owner}/${workRepo.repo}`, "at", sha);
        } catch (e) {
          if (!/already exists/i.test((e as Error).message)) throw e;
          // The branch exists from an earlier open. If it's merely stale
          // (e.g. created before the init commit), fast-forward it to the
          // current head; a branch with its own commits — work in progress —
          // is left untouched.
          const ffed = await f.fastForwardBranch(workRepo.owner, workRepo.repo, ref, sha);
          console.log("[editor] branch", ref, "already existed; fast-forward to", sha, "=>", ffed);
        }
        const meiParam = "&connect=true";

        // The branch ref was created or moved a moment ago, and GitHub's
        // Contents API can briefly lag ref updates — retry the lookup rather
        // than failing on that race.
        let downloadUrl: string | null = null;
        for (let attempt = 1; attempt <= 5 && !downloadUrl; attempt++) {
          if (attempt > 1) await sleep(1500);
          downloadUrl = await f.getRepoFileDownloadUrl(
            workRepo.owner,
            workRepo.repo,
            fragment,
            ref,
          );
          console.log("[editor] downloadUrl attempt", attempt, "for", fragment, "@", `${workRepo.owner}/${workRepo.repo}#${ref}`, "=>", downloadUrl);
        }
        if (!downloadUrl)
          return {
            error: `Could not get a download URL for ${fragment}.`,
          };
        const url = `${meiFriendUrl}/?file=${encodeURIComponent(downloadUrl)}${meiParam}`;

        const mine = parseLockCsv(
          (await f.getRepoFile(owner, repo, LOCK_PATH)) ?? "",
        ).some(
          (l) =>
            l.task_id === task_id &&
            l.subtask_id === "" &&
            l.kind === "encoding" &&
            l.user_id === viewer,
        );
        let prUrl: string | undefined;
        let message =
          "Opening the score in mei-friend. After committing there, use “Submit encoding”.";
        if (task.status === "encoding_required" && !mine) {
          busyMessage = "Opening the encoding claim PR…";
          const pr = await openClaimPr(f, task_id, "", "encoding");
          console.log("[editor] encoding claim PR opened", pr.number, pr.html_url);
          prUrl = pr.html_url;
          const verdict = await waitForPrProcessed(f, pr.number);
          const res = verdictResult(
            verdict,
            pr.number,
            pr.html_url,
            `Opened encoding claim PR #${pr.number}.`,
          );
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
    });
    // Open the tab only once the claim went through and the overlay is gone.
    if (result?.ok && !result.warn && result.meiFriendUrl) {
      window.open(result.meiFriendUrl, "_blank", "noopener");
    }
  };

  // After committing an encoding in mei-friend (which only pushes to a branch),
  // open the submission PR that advances the task to validation.
  const submitpr = (task_id: string) =>
    run(async (f) => {
      try {
        busyMessage = "Opening the submission PR…";
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
        console.log("[submitpr] opening PR", { head, base });
        const pr = await f.createPullRequest(owner, repo, {
          title: `Encoding of ${task_id}`,
          head,
          base,
          body: `Submits the encoding of ${task_id} by @${viewer}, edited in mei-friend. Opened from the campaign console.`,
        });
        console.log("[submitpr] submission PR opened", pr.number, pr.html_url);
        const verdict = await waitForPrProcessed(f, pr.number);
        return verdictResult(
          verdict,
          pr.number,
          pr.html_url,
          `Opened submission PR #${pr.number} for ${task_id}.`,
        );
      } catch (e) {
        return { error: `Submission PR failed: ${(e as Error).message}` };
      }
    });

  // Just the tokenised raw URL of the score (no claim) — copied to the clipboard.
  const rawlink = (task_id: string) =>
    run(async (f) => {
      try {
        const fragment = fragmentOf(task_id);
        if (!fragment) return { error: `Unknown task ${task_id}.` };
        busyMessage = "Fetching the raw link…";
        console.log("[rawlink] fetching raw link for", task_id, "fragment", fragment);
        const rawUrl = await f.getRepoFileDownloadUrl(owner, repo, fragment);
        if (!rawUrl)
          return { error: `Could not get a raw link for ${fragment}.` };
        copy(rawUrl);
        return { ok: true, rawUrl, message: `Raw link for ${fragment}:` };
      } catch (e) {
        return { error: `Raw link failed: ${(e as Error).message}` };
      }
    });

  // Open a PR that sets the subtask's first open validation cell (pass/fail).
  const validate = (task_id: string, subtask_id: string, verdict: string) =>
    run(async (f) => {
      try {
        const state = parseStateCsv(
          (await f.getRepoFile(owner, repo, STATE_PATH)) ?? "",
        );
        const row = findRow(state.rows, task_id, subtask_id);
        if (!row) return { error: `Unknown subtask ${task_id}/${subtask_id}.` };
        const slot = state.validationColumns.find((c) => (row[c] ?? "") === "");
        if (!slot)
          return {
            error: `No open validation slot on ${task_id}/${subtask_id}.`,
          };
        row[slot] = verdict; // the Action re-authors this to `verdict|user|time`
        busyMessage = "Opening the validation PR…";
        console.log("[validate] opening validation PR", { task_id, subtask_id, verdict, slot });
        const pr = await f.openChangePr(owner, repo, {
          branch: `validate-${task_id}-${subtask_id}-${rand()}`,
          files: [{ path: STATE_PATH, content: serializeStateCsv(state) }],
          message: `Validate ${task_id}/${subtask_id} (${verdict})`,
          title: `Validate ${task_id}/${subtask_id} (${verdict})`,
          body: `Submits a ${verdict} validation for ${task_id}/${subtask_id}. Opened from the campaign console.`,
        });
        console.log("[validate] validation PR opened", pr.number, pr.html_url);
        const outcome = await waitForPrProcessed(f, pr.number);
        return verdictResult(
          outcome,
          pr.number,
          pr.html_url,
          `Opened validation PR #${pr.number} for ${task_id}/${subtask_id} (${verdict}).`,
        );
      } catch (e) {
        return { error: `Validate failed: ${(e as Error).message}` };
      }
    });

  // Manually dispatch the scheduled reaper, then wait for its run to finish
  // (there is no PR to watch — poll the dispatched workflow run instead).
  const reaper = () =>
    run(async (f) => {
      try {
        busyMessage = "Dispatching the stale-lock reaper…";
        const { branch } = await f.getRepoHead(owner, repo);
        const dispatchedAt = Date.now();
        console.log("[reaper] dispatching caller.yml on", branch);
        await f.dispatchWorkflow(owner, repo, "caller.yml", branch);
        busyMessage = "Waiting for the reaper run to finish…";
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline) {
          await sleep(3000);
          const runInfo = await f.getLatestWorkflowRun(
            owner,
            repo,
            "caller.yml",
            "workflow_dispatch",
          );
          // Only a run created after our dispatch counts (15s clock-skew slack).
          if (
            runInfo &&
            Date.parse(runInfo.created_at) >= dispatchedAt - 15_000 &&
            runInfo.status === "completed"
          ) {
            console.log("[reaper] run finished with conclusion:", runInfo.conclusion);
            if (runInfo.conclusion !== "success") {
              return {
                error: `The reaper run finished with "${runInfo.conclusion}" — check the repository's Actions log.`,
              };
            }
            return { ok: true, message: "Stale-lock reaper finished." };
          }
        }
        return {
          ok: true,
          warn: true,
          message:
            "Reaper dispatched; the run hasn't finished yet — refresh the tables in a moment.",
        };
      } catch (e) {
        return { error: `Reaper dispatch failed: ${(e as Error).message}` };
      }
    });
</script>

{#if busy}
  <div class="overlay" role="status" aria-live="polite">
    <div class="overlay-card">
      <div class="spinner" aria-hidden="true"></div>
      <p class="overlay-title">{busyMessage || "Working…"}</p>
      <p class="overlay-sub">
        The campaign automation runs on GitHub — this can take a few seconds.
      </p>
    </div>
  </div>
{/if}

<p class="back"><a href="/">← All campaigns</a></p>

<header>
  <h1>Campaign console</h1>
  <p class="repo">
    <a
      href={`https://github.com/${owner}/${repo}`}
      target="_blank"
      rel="noreferrer"
    >
      {owner}/{repo}
    </a>
  </p>
  <p class="muted">
    Claim a task to encode it in mei-friend, submit your work when done, or
    validate someone else's encoding. Hover a button for details.
  </p>
</header>

{#if auth.status === "loading"}
  <p class="muted">Loading…</p>
{:else if !auth.user}
  <div class="banner warn">
    Please <button type="button" class="linkish" onclick={() => login()}
      >log in with GitHub</button
    >
    to drive this campaign.
  </div>
{:else}
  {#if result && result.error}
    <div class="banner err">
      {result.error}
      {#if result.prUrl}
        <a href={result.prUrl} target="_blank" rel="noreferrer">View PR →</a>
      {/if}
    </div>
  {:else if result && result.ok}
    <div class="banner {result.warn ? 'warn' : 'ok'}">
      {result.message}
      {#if result.prUrl}
        <a href={result.prUrl} target="_blank" rel="noreferrer">View PR →</a>
      {/if}
      {#if result.meiFriendUrl}
        <div class="rawlink">
          <input
            readonly
            value={result.meiFriendUrl}
            onfocus={(e) => (e.target as HTMLInputElement).select()}
          />
          <button type="button" onclick={() => copy(result!.meiFriendUrl!)}
            >Copy</button
          >
        </div>
        <span class="muted">
          <a href={result.meiFriendUrl} target="_blank" rel="noreferrer"
            >Open in mei-friend ↗</a
          >
          (if the tab didn't open automatically)
        </span>
      {/if}
      {#if result.rawUrl}
        <div class="rawlink">
          <input
            readonly
            value={result.rawUrl}
            onfocus={(e) => (e.target as HTMLInputElement).select()}
          />
          <button type="button" onclick={() => copy(result!.rawUrl!)}
            >Copy</button
          >
        </div>
        {#if isPrivate}
          <span class="muted"
            >The token in this link expires within minutes — use it promptly.</span
          >
        {/if}
      {/if}
    </div>
  {/if}

  {#if loading}
    <p class="muted">Loading campaign…</p>
  {:else if loadError}
    <div class="banner err">{loadError}</div>
  {:else if notInitialised}
    <div class="banner warn">
      This repository has no tracking tables (<code>tracking/task.csv</code>,
      <code>tracking/state.csv</code>, <code>tracking/lock.csv</code>) yet — it
      may not have been initialised. Create it through the home page to
      initialise it.
    </div>
  {:else}
    <div class="toolbar">
      <button type="button" onclick={() => load()} disabled={busy || loading}
        >Refresh tables</button
      >
      <button type="button" onclick={() => reaper()} disabled={busy}
        >Run stale-lock reaper</button
      >
    </div>

    <h2>Tasks</h2>
    <table>
      <thead>
        <tr>
          <th>Task</th><th>Status</th><th>Encoder</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each taskRows as task (task.task_id)}
          <tr>
            <td><code>{task.task_id}</code></td>
            <td><span class="state {task.status}">{task.status}</span></td>
            <td>{task.encoder || "—"}</td>
            <td class="actions">
              <div class="btnrow">
                <button
                  type="button"
                  onclick={() => editor(task.task_id)}
                  disabled={busy ||
                    !(
                      task.status === "encoding_required" ||
                      myEncodingLock(task.task_id)
                    )}
                  title="Claims this task for you and opens the score in mei-friend. Commit your encoding there, then use “Submit encoding”. Enabled while the task needs an encoder or is already yours."
                >
                  Claim (encode)
                </button>
                <button
                  type="button"
                  onclick={() => togglePreview(task.task_id)}
                  disabled={busy}
                  title="Show the task's score rendered in the console (read-only)"
                >
                  {preview?.taskId === task.task_id ? "Hide preview" : "Preview"}
                </button>
                <button
                  type="button"
                  onclick={() => rawlink(task.task_id)}
                  disabled={busy}
                  title={isPrivate
                    ? "Copy a direct link to the score file to paste into mei-friend manually. The link is tokenised for this private repository and expires within minutes."
                    : "Copy a direct link to the score file to paste into mei-friend manually"}
                >
                  Copy raw link
                </button>
              </div>

              <div class="btnrow">
                <button
                  type="button"
                  onclick={() => submitpr(task.task_id)}
                  disabled={busy || !myEncodingLock(task.task_id)}
                  title="After committing your encoding in mei-friend, submit it for validation. Enabled once you hold the encoding claim."
                >
                  Submit encoding
                </button>
              </div>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>

    {#if preview}
      <div class="preview">
        <div class="preview-head">
          <strong>Score preview — <code>{preview.taskId}</code></strong>
          <div class="preview-nav">
            {#if preview.pageCount > 1}
              <button
                type="button"
                onclick={() => previewPage(preview!.page - 1)}
                disabled={preview.page <= 1}
              >
                ← Prev
              </button>
              <span class="muted">Page {preview.page} / {preview.pageCount}</span>
              <button
                type="button"
                onclick={() => previewPage(preview!.page + 1)}
                disabled={preview.page >= preview.pageCount}
              >
                Next →
              </button>
            {/if}
            <button type="button" onclick={() => (preview = null)}>Close</button>
          </div>
        </div>
        {#if preview.loading}
          <p class="muted">Rendering the score with Verovio…</p>
        {:else if preview.error}
          <div class="banner err">{preview.error}</div>
        {:else}
          <div class="preview-svg">{@html preview.svg}</div>
        {/if}
      </div>
    {/if}

    <h2>Validation subtasks</h2>
    <table>
      <thead>
        <tr>
          <th>Task</th><th>Subtask</th><th>Status</th>
          {#each validationColumns as v}<th>{v}</th>{/each}
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each subtaskRows as sub (sub.task_id + "/" + sub.subtask_id)}
          <tr>
            <td><code>{sub.task_id}</code></td>
            <td><code>{sub.subtask_id}</code></td>
            <td><span class="state {sub.status}">{sub.status}</span></td>
            {#each validationColumns as v}<td class="cell">{sub[v] || "—"}</td
              >{/each}
            <td class="actions">
              <div class="btnrow">
                <button
                  type="button"
                  onclick={() => claim(sub.task_id, sub.subtask_id)}
                  disabled={busy ||
                    sub.status !== "validation_required" ||
                    encoderOf(sub.task_id) === viewer}
                  title="Reserve this subtask for validation. Encoders cannot validate their own work."
                >
                  Claim (validate)
                </button>
              </div>

              <div class="btnrow">
                <button
                  type="button"
                  onclick={() => validate(sub.task_id, sub.subtask_id, "pass")}
                  disabled={busy ||
                    !lockFor(sub.task_id, sub.subtask_id, "validation")}
                  title="Record a passing verdict. Enabled once the subtask is claimed for validation."
                >
                  Validate: pass
                </button>
                <button
                  type="button"
                  onclick={() => validate(sub.task_id, sub.subtask_id, "fail")}
                  disabled={busy ||
                    !lockFor(sub.task_id, sub.subtask_id, "validation")}
                  title="Record a failing verdict — the task goes back to encoding. Enabled once the subtask is claimed for validation."
                >
                  fail
                </button>
              </div>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>

    <h2>Active locks</h2>
    {#if locks.length === 0}
      <p class="muted">None.</p>
    {:else}
      <table>
        <thead
          ><tr
            ><th>Task</th><th>Subtask</th><th>User</th><th>At</th><th>Kind</th
            ></tr
          ></thead
        >
        <tbody>
          {#each locks as lock}
            <tr>
              <td><code>{lock.task_id}</code></td>
              <td><code>{lock.subtask_id || "—"}</code></td>
              <td>{lock.user_id}</td>
              <td class="muted">{lock.timestamp}</td>
              <td>{lock.kind}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}

  {/if}
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.75);
    backdrop-filter: blur(2px);
  }
  .overlay-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.8rem;
    padding: 2rem 2.5rem;
    background: #fff;
    border: 1px solid #e5e5e5;
    border-radius: 12px;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.12);
    text-align: center;
  }
  .spinner {
    width: 38px;
    height: 38px;
    border: 3px solid #e5e5e5;
    border-top-color: #1a1a1a;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .overlay-title {
    margin: 0;
    font-weight: 600;
  }
  .overlay-sub {
    margin: 0;
    color: #777;
    font-size: 0.88rem;
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation-duration: 2s;
    }
  }

  .back {
    margin: 0 0 1rem;
  }
  .back a {
    color: #555;
    text-decoration: none;
  }
  header h1 {
    margin-bottom: 0.2rem;
  }
  .repo {
    margin: 0 0 0.6rem;
    font-weight: 600;
  }
  .repo a {
    color: #1a1a1a;
  }
  .muted {
    color: #777;
    font-size: 0.9rem;
  }
  .linkish {
    font: inherit;
    color: #3056d3;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    text-decoration: underline;
  }
  .toolbar {
    display: flex;
    gap: 0.6rem;
    align-items: center;
    margin: 1.2rem 0;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    font-size: 0.88rem;
    margin-bottom: 1.5rem;
  }
  th,
  td {
    border: 1px solid #e5e5e5;
    padding: 0.45rem 0.6rem;
    text-align: left;
    vertical-align: top;
  }
  th {
    background: #fafafa;
    font-size: 0.8rem;
  }
  .cell {
    font-family: ui-monospace, monospace;
    font-size: 0.78rem;
  }
  .state {
    font-size: 0.75rem;
    padding: 0.1rem 0.4rem;
    border-radius: 999px;
    border: 1px solid #ddd;
  }
  .state.pending {
    background: #f3f3f3;
    border-color: #ddd;
  }
  .state.encoding_required {
    background: #fff4d6;
    border-color: #f0dca0;
  }
  .state.validation_required {
    background: #e8f1fd;
    border-color: #bcd4f3;
  }
  .state.completed {
    background: #e8f7ec;
    border-color: #b6e2c1;
  }
  .actions {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .btnrow {
    display: flex;
    gap: 0.3rem;
  }
  button {
    font: inherit;
    font-size: 0.8rem;
    padding: 0.3rem 0.6rem;
    border: 1px solid #ccc;
    border-radius: 6px;
    background: #fff;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .preview {
    border: 1px solid #e5e5e5;
    border-radius: 8px;
    padding: 0.6rem 0.8rem;
    margin-bottom: 1.5rem;
  }
  .preview-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.6rem;
    margin-bottom: 0.4rem;
  }
  .preview-nav {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .preview-svg {
    overflow-x: auto;
  }
  .preview-svg :global(svg) {
    max-width: 100%;
    height: auto;
  }
  .rawlink {
    display: flex;
    gap: 0.4rem;
    margin-top: 0.5rem;
  }
  .rawlink input {
    flex: 1;
    font: inherit;
    font-size: 0.78rem;
    font-family: ui-monospace, monospace;
    padding: 0.3rem 0.5rem;
    border: 1px solid #b6e2c1;
    border-radius: 6px;
    background: #fff;
  }
  .banner {
    padding: 0.7rem 1rem;
    border-radius: 8px;
    margin-bottom: 1rem;
  }
  .banner.ok {
    background: #e8f7ec;
    border: 1px solid #b6e2c1;
  }
  .banner.err {
    background: #fdeaea;
    border: 1px solid #f3c0c0;
  }
  .banner.warn {
    background: #fff8e1;
    border: 1px solid #f0dca0;
  }
</style>
