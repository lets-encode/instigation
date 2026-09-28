// The state and commands a pre-task editor (the score setup and the zone
// editor) shares: the campaign and task it is on, the loaded task and tables,
// the claim that opening the editor makes, the review of a submitted task,
// and the piece's comments. The editor keeps its own working copy and fills
// it through the hooks.
//
// Constructed during a component's initialisation: the effects run for the
// component's lifetime and start over when the campaign or task changes.

import { goto } from "$app/navigation";
import { auth, forge } from "./auth.svelte.ts";
import type { ForgeClient } from "./forge/types.ts";
import { commands, invoke, commentInput } from "./commands.ts";
import type {
  CampaignTables,
  CommandContext,
  FacsimileTaskData,
  Result,
} from "./commands.ts";
import { handle } from "./campaign-graph.ts";
import { CampaignResolution } from "./campaign-resolution.svelte.ts";
import { CommandRunner, viewerId } from "./command-runner.svelte.ts";
import { pendingVerdicts } from "./pending-verdicts.svelte.ts";

export interface PreTaskHooks {
  /** Fill the editor's working copy from a fresh load. */
  loaded(d: FacsimileTaskData): void;
  /** Clear the editor's working copy on a navigation to another campaign or task. */
  reset(): void;
  /**
   * Continue a granted claim in the same overlay (one step list, one
   * Continue); null when there is nothing to continue with.
   */
  afterClaim?(f: ForgeClient, d: FacsimileTaskData): Promise<Result> | null;
}

export class PreTaskSession {
  readonly campaign: CampaignResolution;
  readonly runner = new CommandRunner();

  loading = $state(false);
  loadError = $state<string | null>(null);
  data = $state<FacsimileTaskData | null>(null);
  /** The campaign tables behind the comments panel, refreshed on their own. */
  tables = $state<CampaignTables | null>(null);
  /** A fail carries a mandatory comment; the box is open while one is typed. */
  failOpen = $state(false);
  failText = $state("");

  // Whether a load has been attempted for the current params; a failed load
  // stays on its error banner instead of retrying.
  #attempted = $state(false);
  #autoClaimedFor = $state<string | null>(null);
  #name: () => string;
  #taskId: () => string;
  #hooks: PreTaskHooks;

  /** The acting user's stable numeric id; login is display-only. */
  viewer = $derived(viewerId());
  holds = $derived(
    Boolean(this.data?.holdsLock) && this.data?.status === "encoding_required",
  );
  // The submission runs in the background; the editor holds until its
  // verdict lands, since a repeat would only be rejected.
  submitting = $derived.by(() =>
    pendingVerdicts.isProcessing(`encode:${this.#taskId()}`),
  );
  canEdit = $derived(this.holds && !this.submitting);
  busy = $derived(this.runner.busy || this.submitting);
  /** id → login for every user the tables mention. */
  logins = $derived(this.tables?.logins ?? {});

  // The review happens in the editor too: the same claim/pass/fail the
  // console offers, against the task's validation subtask.
  validation = $derived(this.data?.validation ?? null);
  // A verdict already submitted here and still being processed: the verdict
  // controls hold until it lands — a repeat would only be rejected.
  verdictPending = $derived.by(
    () =>
      !!this.validation &&
      pendingVerdicts.isProcessing(
        `validate:${this.#taskId()}/${this.validation.subtask_id}`,
      ),
  );
  submitted = $derived(
    this.data?.status === "validation_required" ||
      this.data?.status === "completed",
  );
  holdsValidation = $derived(
    this.viewer !== "" && this.validation?.lockUser === this.viewer,
  );
  lockUserLogin = $derived(
    handle(this.logins, this.validation?.lockUser ?? ""),
  );
  selfValidation = $derived(
    !!this.data &&
      this.data.encoder !== "" &&
      this.data.encoder === this.viewer &&
      !this.data.allowSelfValidation,
  );
  // One verdict per person: a validator who already recorded pass/fail here
  // cannot claim another slot (matching the campaign automation's rule).
  alreadyValidated = $derived(
    !!this.data &&
      !this.data.allowSelfValidation &&
      (this.validation?.verdicts ?? []).some((v) => v.user === this.viewer),
  );
  canClaimValidation = $derived(
    !!this.validation &&
      this.validation.status === "validation_required" &&
      this.validation.openSlots > 0 &&
      !this.validation.lockUser &&
      !this.selfValidation &&
      !this.alreadyValidated &&
      !this.verdictPending,
  );
  failComments = $derived(this.data?.failComments ?? []);
  failedVerdicts = $derived(
    (this.validation?.verdicts ?? []).filter((v) => v.verdict === "fail"),
  );
  // Sending a failed task back is open to a failing validator or push
  // access — the same rule the automation enforces.
  canSendBack = $derived(
    this.viewer !== "" &&
      this.data?.status === "validation_required" &&
      this.failedVerdicts.length > 0 &&
      (this.data.canPush ||
        this.failedVerdicts.some((v) => v.user === this.viewer)),
  );
  // Same hold for a send-back already on its way.
  sendBackPending = $derived.by(() =>
    pendingVerdicts.isProcessing(`sendback:${this.#taskId()}`),
  );

  constructor(name: () => string, taskId: () => string, hooks: PreTaskHooks) {
    this.#name = name;
    this.#taskId = taskId;
    this.#hooks = hooks;
    this.campaign = new CampaignResolution(name);

    // A same-route navigation to another campaign or task starts over: the
    // loaded task belongs to the previous params.
    $effect(() => {
      void name();
      void taskId();
      this.data = null;
      this.loadError = null;
      this.#attempted = false;
      hooks.reset();
    });

    // One load per param set, once the campaign is resolved: a failed attempt
    // renders the error banner (with its manual retry) instead of looping.
    $effect(() => {
      if (
        auth.status === "authenticated" &&
        this.campaign.owner &&
        this.campaign.repo &&
        taskId() &&
        !this.#attempted
      ) {
        this.#attempted = true;
        this.load();
      }
    });

    // Opening the editor claims the task, the same way opening a score in
    // mei-friend does — a read-only look is served by the console's score
    // preview, so reaching the editor means intent to edit. Fire once per
    // task, and only when the claim can actually be granted: never while
    // someone else holds the task or a dependency still blocks it — that PR
    // would only come back rejected.
    $effect(() => {
      const d = this.data;
      if (
        d &&
        !this.runner.busy &&
        this.#autoClaimedFor !== taskId() &&
        d.status === "encoding_required" &&
        !d.holdsLock &&
        !d.encodingLockUser &&
        !d.blockedBy
      ) {
        this.#autoClaimedFor = taskId();
        this.claim();
      }
    });

    // A settled background verdict changed the tables; reload the read-only
    // view so it shows the recorded state. An edit session only refreshes
    // the tables — a reload would discard the volunteer's unsubmitted work.
    $effect(() =>
      pendingVerdicts.onSettled(() => {
        if (this.runner.busy) return;
        if (!this.canEdit) {
          this.data = null;
          this.#attempted = false;
        } else {
          this.refreshTables();
        }
      }),
    );
  }

  ctx(f: ForgeClient): CommandContext {
    const { repoId, owner, repo } = this.campaign;
    return this.runner.context(f, { repoId, owner, repo });
  }

  async load() {
    const f = forge();
    if (!f) return;
    // Results for a task the page has since navigated away from are dropped.
    const task = this.#taskId();
    const name = this.#name();
    const stale = () => task !== this.#taskId() || name !== this.#name();
    this.loading = true;
    this.loadError = null;
    try {
      const [d, t] = await Promise.all([
        invoke(commands.readFacsimile, { task_id: task }, this.ctx(f)),
        invoke(commands.readTables, {}, this.ctx(f)),
      ]);
      if (stale()) return;
      this.data = d;
      this.tables = t;
      this.#hooks.loaded(d);
    } catch (e) {
      if (!stale())
        this.loadError = `Could not load ${task}: ${(e as Error).message}`;
    } finally {
      if (!stale()) this.loading = false;
    }
  }

  /**
   * Run a command behind the overlay, then reload. `overviewOnSuccess`
   * returns to the campaign once the command is through instead.
   */
  async run(
    command: (c: CommandContext) => Promise<Result>,
    opts: { overviewOnSuccess?: boolean } = {},
  ) {
    const f = forge();
    if (!f) return;
    await this.runner.run(
      () => command(this.ctx(f)),
      async (result) => {
        // A rejected command changed nothing worth reloading for — and a
        // reload would discard the work the volunteer may retry from.
        if (result.error) return;
        if (opts.overviewOnSuccess) {
          if (result.ok && !result.warn) await goto(`/${this.#name()}`);
          // Still processing (warn): keep the editor and its work as they are.
          return;
        }
        // A background command changed nothing yet — the settle listener
        // reloads when its verdict lands.
        if (result.background) return;
        this.runner.log.step("Reloading…");
        this.data = null;
        await this.load();
      },
    );
  }

  async claim() {
    const f = forge();
    if (!f) return;
    await this.runner.run(async () => {
      const result = await invoke(
        commands.claimTask,
        { task_id: this.#taskId() },
        this.ctx(f),
      );
      if (result.error) return result;
      this.runner.log.step("Reloading…");
      await this.load();
      if (!this.data) return result;
      return this.#hooks.afterClaim?.(f, this.data) ?? result;
    });
  }

  sendBack() {
    return this.run((c) =>
      invoke(commands.sendBack, { task_id: this.#taskId() }, c),
    );
  }

  claimValidation() {
    return this.run((c) =>
      invoke(
        commands.claimValidation,
        { task_id: this.#taskId(), subtask_id: this.validation!.subtask_id },
        c,
      ),
    );
  }

  async validate(verdict: string) {
    await this.run(
      (c) =>
        invoke(
          commands.submitValidation,
          {
            task_id: this.#taskId(),
            subtask_id: this.validation!.subtask_id,
            verdict,
            ...(verdict === "fail"
              ? {
                  comment: {
                    body: this.failText,
                    page: "",
                    measure_start: "",
                    measure_end: "",
                  },
                }
              : {}),
          },
          c,
        ),
      { overviewOnSuccess: true },
    );
    // A failed submission keeps the typed comment for the retry.
    if (this.runner.result?.ok) {
      this.failOpen = false;
      this.failText = "";
    }
  }

  // Posting and resolving comments refresh the tables only: a full reload
  // would discard the editor's unsubmitted work.
  async refreshTables() {
    const f = forge();
    if (!f) return;
    try {
      this.tables = await invoke(commands.readTables, {}, this.ctx(f));
    } catch {
      /* the next full load refreshes the tables */
    }
  }

  #afterComment = async (result: Result) => {
    if (result.error || result.background) return;
    this.runner.log.step("Refreshing comments…");
    await this.refreshTables();
  };

  async postComment(
    task_id: string,
    kind: string,
    body: string,
    parent_id: string,
  ) {
    const f = forge();
    if (!f) return;
    await this.runner.run(
      () =>
        invoke(
          commands.submitComment,
          commentInput(task_id, kind, body, parent_id),
          this.ctx(f),
        ),
      this.#afterComment,
    );
  }

  async resolveComment(comment_id: string) {
    const f = forge();
    if (!f) return;
    await this.runner.run(
      () => invoke(commands.resolveComment, { comment_id }, this.ctx(f)),
      this.#afterComment,
    );
  }
}
