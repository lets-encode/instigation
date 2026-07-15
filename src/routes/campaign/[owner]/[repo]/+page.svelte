<script lang="ts">
  import { page } from "$app/state";
  import { auth, login, forge } from "$lib/auth.svelte.ts";
  import type { ForgeClient } from "$lib/forge/types.ts";
  import { findRow } from "$lib/campaign-tables.ts";
  import type { TaskRow, StateRow, LockRow } from "$lib/campaign-tables.ts";
  import { commands, invoke } from "$lib/commands.ts";
  import type { CommandContext, Result } from "$lib/commands.ts";

  // Guaranteed present by the [owner]/[repo] route.
  const owner = $derived(page.params.owner!);
  const repo = $derived(page.params.repo!);
  const viewer = $derived(auth.user?.login ?? "");

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
  let result = $state<Result | null>(null);

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

  // Pre-tasks carry a locator (measure-zones / breaks) and are worked on in
  // the zone editor instead of mei-friend.
  const locatorOf = (taskId: string) =>
    findRow(taskDefs, taskId, "")?.locator ?? "";
  const typeLabel = (locator: string) =>
    locator === "measure-zones"
      ? "Measure correction"
      : locator === "breaks"
        ? "Page/system breaks"
        : "Encoding";
  // The incomplete task this task waits for (task.csv depends_on), or null.
  const blockedBy = (taskId: string) => {
    const dep = findRow(taskDefs, taskId, "")?.depends_on;
    if (!dep || findRow(rows, dep, "")?.status === "completed") return null;
    return dep;
  };

  // The context every command runs against; progress messages feed the busy overlay.
  const ctx = (f: ForgeClient): CommandContext => ({
    forge: f,
    owner,
    repo,
    viewer,
    progress: (m) => (busyMessage = m),
  });

  // Read the tracking tables (and privacy) for the console. Only the first read
  // shows the loading state; refreshes update the tables in place.
  async function load() {
    const f = forge();
    if (!f) return;
    if (!loaded) loading = true;
    loadError = null;
    try {
      const tables = await invoke(commands.readTables, {}, ctx(f));
      notInitialised = tables.notInitialised;
      isPrivate = tables.isPrivate;
      taskDefs = tables.taskDefs;
      rows = tables.rows;
      validationColumns = tables.validationColumns;
      locks = tables.locks;
      if (!notInitialised) {
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

  // Pages the measure detector couldn't process during campaign creation, handed
  // over via sessionStorage by the create flow. Read once and clear, so the
  // notice shows on arrival but not on a later reload.
  let skippedPages = $state<string[]>([]);
  $effect(() => {
    const key = `facsimile-skipped:${owner}/${repo}`;
    const raw = sessionStorage.getItem(key);
    if (raw) {
      sessionStorage.removeItem(key);
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) skippedPages = parsed;
      } catch {
        // Malformed hand-off: nothing to show.
      }
    }
  });

  // Run a command: show the busy overlay, capture its result banner, then
  // refresh the tables.
  async function run(command: (c: CommandContext) => Promise<Result>) {
    const f = forge();
    if (!f) return;
    busy = true;
    busyMessage = "Working…";
    try {
      result = await command(ctx(f));
      busyMessage = "Refreshing tables…";
      await load();
    } finally {
      busy = false;
      busyMessage = "";
    }
  }

  const claim = (task_id: string, subtask_id: string) =>
    run((c) => invoke(commands.claimValidation, { task_id, subtask_id }, c));

  // Open the task's score in mei-friend (claiming it if needed). The tab opens
  // only after the claim has gone through — never on a rejected or
  // still-pending claim — so it waits until the busy overlay is gone.
  const editor = async (task_id: string) => {
    await run((c) => invoke(commands.openEditor, { task_id }, c));
    if (result?.ok && !result.warn && result.meiFriendUrl) {
      window.open(result.meiFriendUrl, "_blank", "noopener");
    }
  };

  const submitpr = (task_id: string) =>
    run((c) => invoke(commands.submitEncoding, { task_id }, c));

  const validate = (task_id: string, subtask_id: string, verdict: string) =>
    run((c) => invoke(commands.submitValidation, { task_id, subtask_id, verdict }, c));

  // The tokenised raw URL of the score — copied to the clipboard.
  const rawlink = async (task_id: string) => {
    await run((c) => invoke(commands.rawLink, { task_id }, c));
    if (result?.rawUrl) copy(result.rawUrl);
  };

  const reaper = () => run((c) => invoke(commands.runReaper, {}, c));
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
  {#if skippedPages.length}
    <div class="banner warn">
      The measure detector couldn't process {skippedPages.length} page(s) ({skippedPages.join(", ")})
      during creation, so they were left out of the score. Everything else is ready below.
    </div>
  {/if}
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
          <th>Task</th><th>Type</th><th>Status</th><th>Encoder</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each taskRows as task (task.task_id)}
          {@const locator = locatorOf(task.task_id)}
          {@const blocked = blockedBy(task.task_id)}
          <tr>
            <td><code>{task.task_id}</code></td>
            <td>{typeLabel(locator)}</td>
            <td>
              <span class="state {task.status}">{task.status}</span>
              {#if blocked}
                <span
                  class="muted"
                  title={`Claims open once ${blocked} is completed.`}
                >
                  waiting for {blocked}
                </span>
              {/if}
            </td>
            <td>{task.encoder || "—"}</td>
            <td class="actions">
              {#if locator}
                <div class="btnrow">
                  <a
                    class="btnlink"
                    class:disabled={Boolean(blocked)}
                    href={blocked
                      ? undefined
                      : `/campaign/${owner}/${repo}/zones/${task.task_id}`}
                    title={blocked
                      ? `Enabled once ${blocked} is completed.`
                      : locator === "breaks"
                        ? "Mark the system beginnings on the facsimile; page breaks are added automatically."
                        : "Correct the detected measures on the facsimile: add, delete, move, resize and renumber them."}
                  >
                    Open editor
                  </a>
                </div>
              {:else}
                <div class="btnrow">
                  <button
                    type="button"
                    onclick={() => editor(task.task_id)}
                    disabled={busy ||
                      Boolean(blocked) ||
                      !(
                        task.status === "encoding_required" ||
                        myEncodingLock(task.task_id)
                      )}
                    title={blocked
                      ? `Enabled once ${blocked} is completed.`
                      : "Claims this task for you and opens the score in mei-friend. Commit your encoding there, then use “Submit encoding”. Enabled while the task needs an encoder or is already yours."}
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
              {/if}
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
  .btnlink {
    display: inline-block;
    font-size: 0.8rem;
    padding: 0.3rem 0.6rem;
    border: 1px solid #ccc;
    border-radius: 6px;
    background: #fff;
    color: inherit;
    text-decoration: none;
  }
  .btnlink.disabled {
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
