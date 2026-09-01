<!--
  The piece-scoped comments panel for the full-screen task editors: derives
  the open task's piece, its colour slot and its task cards from the campaign
  tables, then renders the same right-docked panel the score view uses. New
  top-level comments target the open task. The host renders the button that
  reopens a closed panel.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import type { CommandRunner } from "$lib/command-runner.svelte.ts";
  import type { CampaignTables } from "$lib/commands.ts";
  import type { CommentRow } from "$lib/campaign-tables.ts";
  import { findRow, pieceNamesOf } from "$lib/campaign-tables.ts";
  import { buildBoard } from "$lib/campaign-board.ts";
  import type { SidePanelState } from "$lib/side-panels.ts";
  import CommentsPanel from "./CommentsPanel.svelte";

  type PanelTables = Pick<
    CampaignTables,
    | "taskDefs"
    | "rows"
    | "validationColumns"
    | "locks"
    | "history"
    | "comments"
    | "pieces"
    | "logins"
    | "passThreshold"
    | "allowSelfValidation"
    | "canPush"
  >;

  let {
    tables,
    taskId,
    viewer,
    runner,
    panel = $bindable(),
    header,
    onanchor,
    oncomment,
    onresolve,
  }: {
    tables: PanelTables;
    /** The task the editor is open on; new top-level comments attach to it. */
    taskId: string;
    viewer: string;
    runner: CommandRunner;
    panel: SidePanelState;
    /** Pinned above the comment list (see CommentsPanel). */
    header?: Snippet;
    /** Show a comment's measure range in the editor's own viewer. */
    onanchor: (comment: CommentRow) => void;
    oncomment: (
      task: string,
      kind: string,
      body: string,
      parent_id: string,
    ) => Promise<void>;
    onresolve: (comment_id: string) => Promise<void>;
  } = $props();

  // The pieces the tasks address, named from the campaign's config where it
  // names them — the same recipe as the campaign page's piece list, so the
  // colour slot matches the piece's tint there.
  const pieces = $derived.by(() => {
    const paths = [
      ...new Set(
        tables.taskDefs
          .filter((t) => t.subtask_id === "" && t.fragment)
          .map((t) => t.fragment),
      ),
    ];
    return paths.map((path) => {
      const piece = tables.pieces.find((p) => p.path === path);
      return { id: piece?.id ?? path, path, title: piece?.title ?? "" };
    });
  });
  const fragment = $derived(findRow(tables.taskDefs, taskId, "")?.fragment ?? "");
  const index = $derived(Math.max(0, pieces.findIndex((p) => p.path === fragment)));
  const piece = $derived(pieces[index] ?? { id: taskId, path: fragment, title: "" });

  const board = $derived(
    buildBoard(
      {
        taskDefs: tables.taskDefs,
        rows: tables.rows,
        validationColumns: tables.validationColumns,
        locks: tables.locks,
        passThreshold: tables.passThreshold,
        allowSelfValidation: tables.allowSelfValidation,
      },
      tables.comments,
      tables.history,
      viewer,
      tables.logins,
      pieceNamesOf(tables.pieces),
    ),
  );
  const cards = $derived(
    board.columns
      .flatMap((c) => c.cards)
      .filter((c) => findRow(tables.taskDefs, c.task, "")?.fragment === piece.path),
  );
</script>

<CommentsPanel
  {piece}
  zone={(index % 8) + 1}
  {cards}
  comments={tables.comments}
  logins={tables.logins}
  {viewer}
  canPush={tables.canPush}
  {runner}
  bind:panel
  targetTask={taskId}
  inScore
  {header}
  {onanchor}
  {oncomment}
  {onresolve}
/>
