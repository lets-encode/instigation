<!--
  Wizard step 1: the campaign's name, title and description. The name is the repo
  name and the registry slug at once, so it is checked for availability as it is
  typed and held in the registry on Continue — from then on it is the campaign's
  name rather than a proposal, and the field is locked. Holding it here is what
  keeps a slow setup from losing the name it was promised: nothing later has to
  ask for it again.
-->
<script lang="ts">
  import { page } from "$app/state";
  import { auth } from "$lib/auth.svelte.ts";
  import { provider } from "$lib/forge/config.ts";
  import { searchReposByTopic, repoExists } from "$lib/forge/github-rest.ts";
  import { claimName, lookupSlug, releaseClaim } from "$lib/campaign-resolve.ts";
  import { readDraft } from "$lib/wizard-draft.ts";
  import { isValidHandle } from "$lib/campaign-handle.ts";
  import { wizard, nextStep, MAX_DESCRIPTION_LENGTH } from "$lib/wizard.svelte.ts";
  import type { RepoSummary } from "$lib/forge/types.ts";
  import WizardCard from "./WizardCard.svelte";

  // Finished campaigns, to catch a name already used by one of them. Setups still
  // in progress are not among them; the registry's reservations cover those.
  let campaignRepos = $state<RepoSummary[]>([]);

  $effect(() => {
    if (auth.status === "loading") return;
    searchReposByTopic(provider.repoTopic, auth.token ?? undefined)
      .then((r) => (campaignRepos = r))
      .catch(() => (campaignRepos = []));
  });

  // Arriving with a chosen name (/new?slug=, from the landing's start card):
  // prefill the name field once, so later edits to it are not overwritten.
  let slugApplied = false;
  $effect(() => {
    const chosen = page.url.searchParams.get("slug");
    if (chosen && !slugApplied) {
      slugApplied = true;
      wizard.handle = chosen;
    }
  });

  // Live availability check: against the campaign repos already fetched (public
  // ones of every user, plus the user's own private matches), and against the
  // user's own account for any other repo of the same name. Debounced; a
  // sequence number discards results of superseded checks.
  let handleCheck = $state<
    | { state: "idle" }
    | { state: "invalid" }
    | { state: "checking" }
    | { state: "available" }
    | { state: "held" }
    | { state: "taken"; by: string }
    /** Reserved by this browser's own unfinished setup of the same name. */
    | { state: "draft"; resumable: boolean }
    | { state: "unknown" }
  >({ state: "idle" });
  let handleCheckSeq = 0;

  $effect(() => {
    const h = wizard.handle.trim();
    const user = auth.user;
    const token = auth.token ?? undefined;
    const repos = campaignRepos;
    const seq = ++handleCheckSeq;
    if (!h) {
      handleCheck = { state: "idle" };
      return;
    }
    // Already held for this campaign: the registry would report it occupied, and
    // it is occupied — by us.
    if (wizard.claim?.name === h) {
      handleCheck = { state: "held" };
      return;
    }
    // The format rules are pure, so report them whether or not anyone is signed
    // in; only the availability lookups below need a user.
    if (!isValidHandle(h)) {
      handleCheck = { state: "invalid" };
      return;
    }
    if (!user) {
      handleCheck = { state: "idle" };
      return;
    }
    handleCheck = { state: "checking" };
    const timer = setTimeout(async () => {
      const clash = repos.find((r) => r.name.toLowerCase() === h.toLowerCase());
      if (clash) {
        if (seq === handleCheckSeq)
          handleCheck = { state: "taken", by: clash.full_name };
        return;
      }
      try {
        // The slug registry is authoritative for the name, so check it too: a
        // name can be free on the user's GitHub yet already registered to
        // another repo, which would only surface as a 409 after the repo was
        // created. A null slug means the registry couldn't be reached — treat
        // that as "unknown" rather than falsely "available".
        const [slug, exists] = await Promise.all([
          lookupSlug(h),
          repoExists(user.login, h, token),
        ]);
        if (seq !== handleCheckSeq) return;
        if (slug && slug.status !== "free") {
          // A pending hold may be this browser's own: an unfinished setup of
          // the same name keeps its claim token in its draft record.
          const draft = slug.status === "pending" ? readDraft(h) : null;
          if (draft?.owner === user.login && draft.claim?.name === h) {
            handleCheck = { state: "draft", resumable: draft.repo !== null };
          } else {
            handleCheck = { state: "taken", by: "an existing campaign" };
          }
        } else if (exists) {
          handleCheck = { state: "taken", by: `${user.login}/${h}` };
        } else if (!slug) {
          handleCheck = { state: "unknown" };
        } else {
          handleCheck = { state: "available" };
        }
      } catch {
        if (seq === handleCheckSeq) handleCheck = { state: "unknown" };
      }
    }, 400);
    return () => clearTimeout(timer);
  });

  // A name that is taken or malformed can't proceed. "unknown" may: the registry
  // was unreachable, and the claim on Continue verifies the name anyway.
  const canAdvance = $derived(
    wizard.title.trim() !== "" &&
      isValidHandle(wizard.handle.trim()) &&
      handleCheck.state !== "taken" &&
      handleCheck.state !== "draft" &&
      handleCheck.state !== "checking",
  );

  let claiming = $state(false);
  let claimError = $state<string | null>(null);
  let releaseNote = $state<string | null>(null);

  // The repository is created under the held name, so once it exists the name is
  // fixed for good; before that it can be given back and another one held.
  const nameFixed = $derived(wizard.repo !== null);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!canAdvance || claiming) return;
    const name = wizard.handle.trim();
    // Returning to this step with the name already held: nothing to do again.
    if (wizard.claim?.name === name) {
      nextStep();
      return;
    }
    claiming = true;
    claimError = null;
    releaseNote = null;
    const result = await claimName(name);
    claiming = false;
    if ("token" in result) {
      wizard.claim = { name, token: result.token };
      nextStep();
      return;
    }
    claimError =
      result.error === "taken"
        ? `“${name}” has just been taken by another campaign. Choose a different name.`
        : result.error === "invalid"
          ? `“${name}” cannot be used as a campaign name.`
          : "The name could not be reserved just now. Check your connection and try again.";
  }

  // Take over the name held by this browser's unfinished setup of the same
  // name. Its record is keyed by the name, so this setup's next save replaces
  // it. Only while that setup has no repository — once one exists, the name
  // belongs to it and the setup must be continued instead.
  function adoptClaim() {
    const h = wizard.handle.trim();
    const draft = readDraft(h);
    if (draft?.owner !== auth.user?.login || draft?.claim?.name !== h || draft?.repo) return;
    wizard.claim = draft.claim;
  }

  async function changeName() {
    const claim = wizard.claim;
    if (!claim || nameFixed) return;
    // The field unlocks either way: a registry that cannot be reached must not
    // trap the campaign under a name. An unreleased hold runs out on its own.
    wizard.claim = null;
    claimError = null;
    const released = await releaseClaim(claim.name, claim.token);
    releaseNote = released
      ? null
      : `“${claim.name}” could not be given back, so it stays reserved for up to half an hour before it is free again.`;
  }
</script>

<form onsubmit={submit}>
  <WizardCard
    step="name"
    heading="Name your campaign"
    intro="The name identifies the campaign to volunteers and becomes its address."
    status="choosing the name"
  >
    <label class="field">
      Campaign name
      <input
        class="input"
        bind:value={wizard.handle}
        placeholder="symphony-9-choral"
        readonly={wizard.claim !== null}
        required
      />
      <span class="hint">Used in the URL and as the Git repository name.</span>
      {#if handleCheck.state === "checking"}
        <span class="hint">Checking availability…</span>
      {:else if handleCheck.state === "held"}
        <span class="hint hint-ok">✓ Reserved for this campaign</span>
      {:else if handleCheck.state === "available"}
        <span class="hint hint-ok">✓ Available</span>
      {:else if handleCheck.state === "taken"}
        <span class="hint hint-err">✗ Already used by {handleCheck.by}</span>
      {:else if handleCheck.state === "draft"}
        <span class="hint hint-err">
          ✗ Reserved by your unfinished setup of this campaign
        </span>
        {#if handleCheck.resumable}
          <a class="hint" href="/campaigns">
            Continue that setup from the campaign list
          </a>
        {:else}
          <button type="button" class="btn btn-inline" onclick={adoptClaim}>
            Use the name here — replaces that setup
          </button>
        {/if}
      {:else if handleCheck.state === "invalid"}
        <span class="hint hint-err">
          3–40 characters: lowercase letters, digits, and single internal
          hyphens.
        </span>
      {:else if handleCheck.state === "unknown"}
        <span class="hint">
          Couldn't check availability — it will be verified when the name is
          reserved.
        </span>
      {/if}
      {#if wizard.claim && nameFixed}
        <span class="hint">
          The repository {wizard.repo?.full_name} carries this name, so it can no
          longer be changed.
        </span>
      {:else if wizard.claim}
        <button type="button" class="btn btn-inline" onclick={changeName}>
          Use a different name
        </button>
      {/if}
      {#if claimError}
        <span class="hint hint-err" role="alert">{claimError}</span>
      {/if}
      {#if releaseNote}
        <span class="hint" role="status">{releaseNote}</span>
      {/if}
    </label>

    <label class="field">
      Title
      <input
        class="input"
        bind:value={wizard.title}
        placeholder="e.g. Symphony No. 9 in D minor, Op. 125"
        required
      />
      <span class="hint">
        The campaign's readable label, shown wherever it is listed.
      </span>
    </label>

    <label class="field">
      About this campaign
      <textarea
        class="input"
        bind:value={wizard.description}
        rows="3"
        maxlength={MAX_DESCRIPTION_LENGTH}
        placeholder="e.g. Encoding the 1826 first edition of the Ninth Symphony, movement by movement, to a complete MEI score."
      ></textarea>
      <span class="hint">
        Optional: what this campaign sets out to encode, in a few sentences.
        Volunteers see it when they open the campaign. {wizard.description
          .length}/{MAX_DESCRIPTION_LENGTH} characters.
      </span>
    </label>

    <!-- Continue submits the form, so this step draws its own footer. -->
    {#snippet footer()}
      <button type="submit" class="btn btn-lg btn-primary" disabled={!canAdvance || claiming}>
        {claiming ? "Reserving the name…" : "Continue →"}
      </button>
    {/snippet}
  </WizardCard>
</form>

<style>
  form {
    /* The workbench inside lays the screen out; the form only submits it. */
    display: contents;
  }
  .field {
    margin-top: 18px;
  }
  .field:first-child {
    margin-top: 26px;
  }
  /* Sits under the field's hints rather than beside the input. */
  .btn-inline {
    margin-top: 0.4rem;
  }
</style>
