// Resolves a task page's campaign name (the URL's /<campaign>) to its repo.
// Constructed during a component's initialisation: the effects run for the
// component's lifetime and start over when the name changes.

import { auth } from "./auth.svelte.ts";
import { readForge } from "./command-runner.svelte.ts";
import {
  resolveCampaign,
  campaignLoadFailure,
  type ResolvedCampaign,
} from "./campaign-resolve.ts";

export class CampaignResolution {
  resolved = $state<ResolvedCampaign | null>(null);
  notFound = $state(false);
  /** A failed lookup (e.g. rate limit), as distinct from a missing campaign. */
  error = $state<string | null>(null);
  // State, so a lookup that ends after a navigation re-runs the effect for
  // the new name.
  #resolving = $state(false);

  owner = $derived(this.resolved?.owner ?? "");
  repo = $derived(this.resolved?.repo ?? "");
  repoId = $derived(this.resolved?.repoId ?? 0);

  constructor(name: () => string) {
    // A same-route navigation to another campaign starts over.
    $effect(() => {
      void name();
      this.resolved = null;
      this.notFound = false;
      this.error = null;
    });
    $effect(() => {
      if (
        auth.status === "loading" ||
        this.resolved ||
        this.notFound ||
        this.error ||
        this.#resolving
      )
        return;
      this.#resolving = true;
      // A result for a name the page has since navigated away from is dropped.
      const current = name();
      resolveCampaign(readForge(), current)
        .then((r) => {
          if (current !== name()) return;
          if (r) this.resolved = r;
          else this.notFound = true;
        })
        .catch((e) => {
          if (current === name()) this.error = campaignLoadFailure(e);
        })
        .finally(() => (this.#resolving = false));
    });
  }

  /** Look the name up again after a failed lookup. */
  retry() {
    this.error = null;
  }
}
