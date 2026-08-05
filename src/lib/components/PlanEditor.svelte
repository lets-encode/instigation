<!--
  The console's plan editor: task.csv as an editable table over the board's
  place. Only untouched tasks — unclaimed, unencoded, no verdicts — can be
  changed (dependency, score file, locator), added or removed; started tasks
  show greyed for context and can only be reordered. Saving hands the complete
  new task table to the console, which runs the savePlan command.
-->
<script lang="ts">
  import { cardTitle } from "$lib/campaign-board.ts";
  import { typeLabel, handle } from "$lib/campaign-graph.ts";
  import type { Logins } from "$lib/campaign-graph.ts";
  import { nextTaskId, taskStarted } from "$lib/campaign-plan.ts";
  import type {
    LockRow,
    StateRow,
    TaskRow,
    ParsedState,
  } from "$lib/campaign-tables.ts";

  let {
    taskDefs,
    rows,
    validationColumns,
    locks,
    logins,
    busy,
    onsave,
    oncancel,
  }: {
    taskDefs: TaskRow[];
    rows: StateRow[];
    validationColumns: string[];
    locks: LockRow[];
    logins: Logins;
    busy: boolean;
    onsave: (tasks: TaskRow[]) => void;
    oncancel: () => void;
  } = $props();

  /** One task with its subtask rows — the unit the editor moves and removes. */
  interface Group {
    task: TaskRow;
    subs: TaskRow[];
    editable: boolean;
  }

  const parsedState: ParsedState = $derived({
    header: [],
    validationColumns,
    rows,
  });

  // The draft: a deep copy of the task table, grouped, taken once on entry.
  let groups = $state<Group[]>(buildDraft());
  function buildDraft(): Group[] {
    return taskDefs
      .filter((t) => t.subtask_id === "")
      .map((t) => ({
        task: { ...t },
        subs: taskDefs
          .filter((s) => s.task_id === t.task_id && s.subtask_id !== "")
          .map((s) => ({ ...s })),
        editable: !taskStarted(parsedState, locks, t.task_id),
      }));
  }

  const fragments = $derived([
    ...new Set(taskDefs.map((t) => t.fragment).filter(Boolean)),
  ]);

  const statusOf = (task: string): { key: string; label: string } => {
    const row = rows.find((r) => r.task_id === task && r.subtask_id === "");
    const lock = locks.find(
      (l) => l.task_id === task && l.subtask_id === "" && l.kind === "encoding",
    );
    if (row?.status === "completed") return { key: "done", label: "✓ completed" };
    if (row?.status === "validation_required")
      return { key: "validation", label: "validation" };
    if (lock) return { key: "encoding", label: "● encoding" };
    return { key: "open", label: "○ open" };
  };
  const workerOf = (task: string): string => {
    const lock = locks.find((l) => l.task_id === task && l.kind === "encoding");
    const row = rows.find((r) => r.task_id === task && r.subtask_id === "");
    return lock
      ? handle(logins, lock.user_id)
      : row?.encoder
        ? handle(logins, row.encoder)
        : "";
  };
  const titleOf = (g: Group) =>
    g.task.fragment ? cardTitle(g.task.fragment, g.task.locator) : g.task.task_id;
  const sizeOf = (g: Group): string => {
    if (/^surface-\d+$/.test(g.task.locator)) return "1 page";
    if (g.task.locator === "measure-zones") return "all pages";
    return "whole file";
  };

  // Dependency edits keep the subtask rows aligned with their task row
  // (fragment and locator mirror it; a subtask never carries depends_on).
  function syncSubs(g: Group) {
    for (const s of g.subs) {
      s.fragment = g.task.fragment;
      s.locator = g.task.locator;
    }
  }

  function addTask() {
    const flat = groups.flatMap((g) => [g.task, ...g.subs]);
    const id = nextTaskId(flat);
    const fragment = fragments[0] ?? "sources/score.mei";
    groups = [
      ...groups,
      {
        task: {
          task_id: id,
          subtask_id: "",
          fragment,
          locator: "",
          allowlist: "",
          blocklist: "",
          depends_on: "",
        },
        subs: [
          {
            task_id: id,
            subtask_id: "S0001",
            fragment,
            locator: "",
            allowlist: "",
            blocklist: "",
            depends_on: "",
          },
        ],
        editable: true,
      },
    ];
  }

  function removeTask(index: number) {
    const removed = groups[index].task.task_id;
    groups = groups.filter((_, i) => i !== index);
    // A dependency on the removed task would be dangling — clear it.
    for (const g of groups) {
      if (g.task.depends_on === removed) g.task.depends_on = "";
    }
  }

  // Drag to reorder: the dragged group index rides in the drag state; rows
  // swap as the pointer crosses them.
  let dragging = $state<number | null>(null);
  function dragOver(index: number, e: DragEvent) {
    e.preventDefault();
    if (dragging === null || dragging === index) return;
    const next = [...groups];
    const [moved] = next.splice(dragging, 1);
    next.splice(index, 0, moved);
    groups = next;
    dragging = index;
  }

  const save = () => onsave(groups.flatMap((g) => [g.task, ...g.subs]));
</script>

<div class="plan">
  <div class="phead">
    <span class="plabel">Task plan · {groups.length}</span>
    <span class="pmode">● Editing the plan</span>
    <span class="pnote">Changes only touch tasks nobody has worked on yet.</span>
    <span class="pspacer"></span>
    <button type="button" class="pbtn" onclick={addTask} disabled={busy}
      >+ Add task</button
    >
    <button type="button" class="pbtn" onclick={oncancel} disabled={busy}
      >Cancel</button
    >
    <button type="button" class="pbtn save" onclick={save} disabled={busy}
      >Save the plan</button
    >
  </div>
  <div class="prow phrow">
    <span></span><span>Task</span><span>Type</span><span>Size</span><span
      >Depends on</span
    ><span>Status</span><span></span>
  </div>
  <div class="pbody">
    {#each groups as g, i (g.task.task_id)}
      {@const status = statusOf(g.task.task_id)}
      <div
        class="prow"
        class:locked={!g.editable}
        class:dragged={dragging === i}
        role="row"
        tabindex="-1"
        draggable="true"
        ondragstart={(e) => {
          dragging = i;
          e.dataTransfer?.setData("text/plain", g.task.task_id);
        }}
        ondragend={() => (dragging = null)}
        ondragover={(e) => dragOver(i, e)}
      >
        <span class="grip" title="Drag to reorder">⋮⋮</span>
        <div class="pcell-task">
          {#if g.editable}
            <div class="ptitle">{titleOf(g)}</div>
            <div class="psub">
              <select
                class="pselect"
                bind:value={g.task.fragment}
                onchange={() => syncSubs(g)}
                aria-label="Score file"
              >
                {#each fragments as fr (fr)}
                  <option value={fr}>{fr}</option>
                {/each}
                {#if !fragments.includes(g.task.fragment)}
                  <option value={g.task.fragment}>{g.task.fragment}</option>
                {/if}
              </select>
              <input
                class="pinput mono"
                bind:value={g.task.locator}
                oninput={() => syncSubs(g)}
                placeholder="whole file"
                aria-label="Locator (empty = whole file, or surface-N)"
                title="Which part of the file the task addresses: empty for the whole file, surface-N for one page."
              />
            </div>
          {:else}
            <div class="ptitle">
              {titleOf(g)}
              {#if status.key === "encoding"}
                <span class="pchip blue">claimed</span>
              {/if}
            </div>
            <div class="psub muted">
              <span class="mono">{g.task.task_id}</span>
              {#if workerOf(g.task.task_id)}
                · locked while {workerOf(g.task.task_id)} works on it
              {/if}
            </div>
          {/if}
        </div>
        <span class="ptype">{typeLabel(g.task.locator)}</span>
        <span class="psize"
          >{sizeOf(g)}{#if !g.editable}<span class="lockmark"> · locked</span
            >{/if}</span
        >
        <div class="pdep">
          {#if g.editable}
            <select
              class="pselect"
              bind:value={g.task.depends_on}
              aria-label="Depends on"
            >
              <option value="">—</option>
              {#each groups as other (other.task.task_id)}
                {#if other.task.task_id !== g.task.task_id}
                  <option value={other.task.task_id}
                    >{titleOf(other)} ({other.task.task_id})</option
                  >
                {/if}
              {/each}
            </select>
          {:else}
            <span class="muted"
              >{g.task.depends_on
                ? (groups.find((o) => o.task.task_id === g.task.depends_on)
                    ? titleOf(
                        groups.find(
                          (o) => o.task.task_id === g.task.depends_on,
                        )!,
                      )
                    : g.task.depends_on)
                : "—"}</span
            >
          {/if}
        </div>
        <span class="pstatus s-{status.key}">{status.label}</span>
        <span class="pact">
          {#if g.editable}
            <button
              type="button"
              class="premove"
              onclick={() => removeTask(i)}
              disabled={busy}>Remove</button
            >
          {/if}
        </span>
      </div>
    {/each}
    <div class="pfoot">
      Completed and claimed tasks are shown greyed and cannot be edited; they
      free up when their claim is released.
    </div>
  </div>
</div>

<style>
  .plan {
    flex: 1;
    min-height: 0;
    margin: 0 32px 16px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 14px;
    box-shadow: var(--shadow);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .phead {
    height: 48px;
    flex: none;
    border-bottom: 1px solid var(--line);
    display: flex;
    align-items: center;
    padding: 0 16px;
    gap: 10px;
  }
  .plabel {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ink-faint);
  }
  .pmode {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--info);
    background: var(--info-bg);
    border: 1px solid var(--info-line);
    border-radius: 999px;
    padding: 3px 10px;
  }
  .pnote {
    font-size: 11.5px;
    color: var(--ink-faint);
  }
  .pspacer {
    flex: 1;
  }
  .pbtn {
    font: 600 11.5px var(--font);
    padding: 5px 12px;
    border-radius: 999px;
    border: 1px solid var(--info-line);
    background: var(--card);
    color: var(--accent);
    cursor: pointer;
  }
  .pbtn:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .pbtn.save {
    border: 0;
    background: var(--accent-btn);
    color: #fff;
    padding: 5px 14px;
  }
  .pbtn.save:hover:not(:disabled) {
    background: var(--accent-btn-hover);
  }
  .prow {
    display: grid;
    grid-template-columns: 28px minmax(200px, 1fr) 150px 110px 250px 130px 80px;
    gap: 12px;
    align-items: center;
    padding: 10px 16px;
    border-bottom: 1px solid var(--bg-tint);
  }
  .phrow {
    background: var(--bg-alt);
    border-bottom: 1px solid var(--line);
    padding: 8px 16px;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ink-faint);
  }
  .pbody {
    flex: 1;
    overflow: auto;
  }
  .prow.locked {
    opacity: 0.65;
  }
  .prow.dragged {
    background: var(--accent-tint-strong);
  }
  .grip {
    color: var(--ink-faint);
    font-size: 14px;
    text-align: center;
    cursor: grab;
    user-select: none;
  }
  .ptitle {
    font-size: 13.5px;
    font-weight: 600;
  }
  .psub {
    display: flex;
    gap: 6px;
    margin-top: 4px;
    align-items: center;
  }
  .psub.muted,
  .muted {
    font-size: 11.5px;
    color: var(--ink-faint);
  }
  .mono {
    font-family: ui-monospace, Menlo, monospace;
  }
  .pselect,
  .pinput {
    font: 400 11.5px var(--font);
    color: var(--ink);
    background: var(--bg);
    border: 1px solid var(--line-input);
    border-radius: 6px;
    padding: 3px 6px;
    min-width: 0;
  }
  .pselect {
    max-width: 210px;
  }
  .pinput {
    width: 90px;
  }
  .ptype,
  .psize {
    font-size: 12px;
    color: var(--ink-soft);
  }
  .lockmark {
    color: var(--ink-faint);
  }
  .pchip {
    font-size: 11px;
    font-weight: 700;
    border-radius: 999px;
    padding: 1px 7px;
    margin-left: 4px;
  }
  .pchip.blue {
    color: var(--info);
    background: var(--info-bg);
    border: 1px solid var(--info-line);
  }
  .pstatus {
    justify-self: start;
    font-size: 11.5px;
    font-weight: 600;
    border-radius: 999px;
    padding: 3px 10px;
    white-space: nowrap;
  }
  .pstatus.s-done {
    color: var(--ok);
    background: var(--ok-bg);
    border: 1px solid var(--ok-line);
  }
  .pstatus.s-encoding {
    color: var(--info);
    background: var(--info-bg);
    border: 1px solid var(--info-line);
  }
  .pstatus.s-validation {
    color: var(--warn);
    background: var(--warn-bg);
    border: 1px solid var(--warn-line);
  }
  .pstatus.s-open {
    color: var(--ink-soft);
    background: var(--bg);
    border: 1px solid var(--line-input);
  }
  .pact {
    text-align: right;
  }
  .premove {
    font: 600 11px var(--font);
    color: var(--ink-faint);
    background: none;
    border: 0;
    cursor: pointer;
    text-decoration: underline;
  }
  .premove:hover:not(:disabled) {
    color: var(--danger);
  }
  .pfoot {
    padding: 10px 16px;
    font-size: 12px;
    color: var(--ink-faint);
  }
</style>
