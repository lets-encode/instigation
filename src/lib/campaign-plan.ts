// Plan editing: pure decision logic for rewriting task.csv from the console's
// plan editor. Given the current tables and the proposed plan (the complete
// new task table, task rows with their subtask rows, in order), decide whether
// the rewrite is allowed and, if so, produce the matching state rows. Only
// untouched tasks — unclaimed, unencoded, no validation activity — may be
// added, removed, reordered or rewired; every started task must be carried
// over verbatim. No GitHub.

import { findRow, isFinalValidation } from "./campaign-tables.ts";
import type {
  LockRow,
  ParsedState,
  StateRow,
  TaskRow,
} from "./campaign-tables.ts";

/** Whether any work has touched the task: a claim, an encoding, or a verdict. */
export function taskStarted(
  state: ParsedState,
  locks: LockRow[],
  task: string,
): boolean {
  if (locks.some((l) => l.task_id === task)) return true;
  const row = findRow(state.rows, task, "");
  if (row && (row.status !== "encoding_required" || row.encoder !== ""))
    return true;
  return state.rows
    .filter((r) => r.task_id === task && r.subtask_id !== "")
    .some((r) =>
      state.validationColumns.some((c) => isFinalValidation(r[c] ?? "")),
    );
}

export type PlanResult =
  | { ok: true; stateRows: StateRow[] }
  | { ok: false; reason: string };

const reject = (reason: string): PlanResult => ({ ok: false, reason });

const groupIds = (rows: TaskRow[]): string[] => [
  ...new Set(rows.filter((r) => r.subtask_id === "").map((r) => r.task_id)),
];

const rowsOf = (rows: TaskRow[], task: string): TaskRow[] =>
  rows.filter((r) => r.task_id === task);

const sameRows = (a: TaskRow[], b: TaskRow[]): boolean =>
  a.length === b.length &&
  a.every((row, i) => {
    const other = b[i];
    return (
      row.task_id === other.task_id &&
      row.subtask_id === other.subtask_id &&
      row.fragment === other.fragment &&
      row.locator === other.locator &&
      row.allowlist === other.allowlist &&
      row.blocklist === other.blocklist &&
      row.depends_on === other.depends_on
    );
  });

/**
 * Validate a proposed plan against the current tables and build the state rows
 * that go with it: existing tasks keep their state rows (reordered to the
 * plan), new tasks start at encoding_required with pending subtasks and empty
 * validation cells.
 */
export function checkPlan(
  current: TaskRow[],
  state: ParsedState,
  locks: LockRow[],
  plan: TaskRow[],
): PlanResult {
  const planTasks = groupIds(plan);
  const currentTasks = groupIds(current);
  if (planTasks.length === 0) return reject("empty_plan");
  if (
    new Set(plan.map((r) => `${r.task_id}/${r.subtask_id}`)).size !==
    plan.length
  ) {
    return reject("duplicate_row");
  }

  // Every row needs a task row and a fragment; subtask rows need their task.
  for (const row of plan) {
    if (!row.task_id) return reject("missing_task_id");
    if (row.subtask_id === "" && !row.fragment)
      return reject("missing_fragment");
    if (row.subtask_id !== "" && !planTasks.includes(row.task_id))
      return reject("orphan_subtask");
  }

  // Dependencies must stay within the plan and free of cycles.
  const dependsOn = new Map(
    plan
      .filter((r) => r.subtask_id === "")
      .map((r) => [r.task_id, r.depends_on]),
  );
  for (const [task, dep] of dependsOn) {
    if (dep === "") continue;
    if (!dependsOn.has(dep)) return reject("unknown_dependency");
    if (dep === task) return reject("dependency_cycle");
    const trail = new Set([task]);
    let cursor = dep;
    while (cursor !== "") {
      if (trail.has(cursor)) return reject("dependency_cycle");
      trail.add(cursor);
      cursor = dependsOn.get(cursor) ?? "";
    }
  }

  // Started tasks are untouchable: they must be carried over verbatim, in
  // particular they cannot be removed.
  for (const task of currentTasks) {
    if (!taskStarted(state, locks, task)) continue;
    if (!planTasks.includes(task)) return reject("task_in_progress");
    if (!sameRows(rowsOf(plan, task), rowsOf(current, task)))
      return reject("task_in_progress");
  }

  // The new state table: existing rows carried over in plan order, new tasks
  // starting fresh. The validation columns keep the current header.
  const empty = Object.fromEntries(state.validationColumns.map((c) => [c, ""]));
  const stateRows: StateRow[] = [];
  for (const row of plan) {
    const existing = findRow(state.rows, row.task_id, row.subtask_id);
    if (existing) {
      stateRows.push(existing);
    } else {
      stateRows.push({
        task_id: row.task_id,
        subtask_id: row.subtask_id,
        status: row.subtask_id === "" ? "encoding_required" : "pending",
        encoder: "",
        encoded_at: "",
        ...empty,
      });
    }
  }
  return { ok: true, stateRows };
}

/** The next free `T####` id after every id the plan already uses. */
export function nextTaskId(rows: TaskRow[]): string {
  const max = rows.reduce((n, r) => {
    const m = /^T(\d+)$/.exec(r.task_id);
    return m ? Math.max(n, Number(m[1])) : n;
  }, 0);
  return `T${String(max + 1).padStart(4, "0")}`;
}

/**
 * Rebuild one piece's page tasks (locator `surface-N`) for the pages that
 * carry measures, in page order: the existing task ids are reused in order,
 * extra pages get the next free ids, and ids left over are dropped. A page
 * without measures gets no task. Each rebuilt task keeps the first existing
 * page task's dependency and subtask rows. Returns null — the tables stay as
 * they are — when the piece has no page tasks, when they already match, or
 * when the rewrite is not allowed (a page task has started, or another task
 * depends on a dropped one).
 */
export function replanPageTasks(
  current: TaskRow[],
  state: ParsedState,
  locks: LockRow[],
  fragment: string,
  measuredSurfaces: string[],
): { tasks: TaskRow[]; stateRows: StateRow[] } | null {
  const isPageRow = (r: TaskRow) =>
    r.fragment === fragment && /^surface-\d+$/.test(r.locator);
  const pageTasks = current.filter((r) => isPageRow(r) && r.subtask_id === "");
  if (pageTasks.length === 0 || measuredSurfaces.length === 0) return null;
  if (
    pageTasks.length === measuredSurfaces.length &&
    pageTasks.every((t, i) => t.locator === measuredSurfaces[i])
  )
    return null;

  const template = rowsOf(current, pageTasks[0].task_id);
  const ids = pageTasks.map((t) => t.task_id);
  const rebuilt: TaskRow[] = [];
  measuredSurfaces.forEach((locator, i) => {
    const id = ids[i] ?? nextTaskId([...current, ...rebuilt]);
    for (const row of template) rebuilt.push({ ...row, task_id: id, locator });
  });

  const first = current.findIndex((r) => r.task_id === ids[0]);
  const kept = current.filter((r) => !ids.includes(r.task_id));
  const at = current
    .slice(0, first)
    .filter((r) => !ids.includes(r.task_id)).length;
  const tasks = [...kept.slice(0, at), ...rebuilt, ...kept.slice(at)];
  const result = checkPlan(current, state, locks, tasks);
  return result.ok ? { tasks, stateRows: result.stateRows } : null;
}
