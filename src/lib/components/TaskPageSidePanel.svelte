<!--
  The side panel of the full-screen task views (review, zones, score setup):
  derives the task's piece and its colour slot from the campaign tables and
  renders SidePanel on the task, with the view's task box pinned on top. The
  view is the task's own, so the panel has no Campaign state.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import type { CommandRunner } from "$lib/command-runner.svelte.ts";
  import type { CampaignTables, Result } from "$lib/commands.ts";
  import type { CommentRow } from "$lib/campaign-tables.ts";
  import { findRow, pieceLabel, pieceZone } from "$lib/campaign-tables.ts";
  import type { SidePanelState } from "$lib/side-panels.ts";
  import SidePanel from "./SidePanel.svelte";

  type PanelTables = Pick<
    CampaignTables,
    "taskDefs" | "comments" | "pieces" | "logins" | "canPush"
  >;

  let {
    tables,
    taskId,
    viewer,
    runner,
    panel = $bindable(),
    review = false,
    banner,
    taskBox,
    onanchor,
    oncomment,
    onresolve,
  }: {
    tables: PanelTables;
    /** The task the view is open on. */
    taskId: string;
    viewer: string;
    runner: CommandRunner;
    panel: SidePanelState;
    /** The task awaits review: comments take the review colour. */
    review?: boolean;
    banner?: Snippet;
    /** The task's record and controls, pinned above the comments. */
    taskBox: Snippet;
    /** Show a comment's measure range in the view's own viewer. */
    onanchor: (comment: CommentRow) => void;
    oncomment: (
      task: string,
      kind: string,
      body: string,
      parent_id: string,
    ) => Promise<Result | null>;
    onresolve: (comment_id: string) => Promise<unknown>;
  } = $props();

  // The pieces the tasks address, in the campaign page's order, so the colour
  // slot matches the piece's tint there.
  const paths = $derived([
    ...new Set(
      tables.taskDefs
        .filter((t) => t.subtask_id === "" && t.fragment)
        .map((t) => t.fragment),
    ),
  ]);
  const fragment = $derived(
    findRow(tables.taskDefs, taskId, "")?.fragment ?? "",
  );
  const index = $derived(Math.max(0, paths.indexOf(fragment)));
  const piece = $derived.by(() => {
    const p = tables.pieces.find((x) => x.path === fragment);
    return { id: p?.id ?? fragment, path: fragment, title: p?.title ?? "" };
  });
</script>

<SidePanel
  task={taskId}
  subtitle={fragment ? pieceLabel(piece) : ""}
  zone={pieceZone(index)}
  {review}
  comments={tables.comments}
  logins={tables.logins}
  {viewer}
  canPush={tables.canPush}
  {runner}
  bind:panel
  inScore
  {banner}
  {taskBox}
  {onanchor}
  oncomment={(kind, body, parent_id) =>
    oncomment(taskId, kind, body, parent_id)}
  {onresolve}
/>
