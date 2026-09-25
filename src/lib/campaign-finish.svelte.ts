// Finishing a campaign setup: the wizard's last step runs this from its
// button. The pages are measured first — the measure detector for the
// measure-detection preparation, the page sizes alone for OMR — then every
// piece's score, the configuration and the tracking tables are built from the
// wizard store and committed in one commit, the campaign's name is registered
// and the listing topic stamped. Progress is reported through a ProgressLog
// and the busy/error state here, which the step's card renders.

import { goto } from "$app/navigation";
import { auth, forge } from "./auth.svelte.ts";
import { provider, automation, measureDetectorUrl } from "./forge/config.ts";
import { registerCampaign } from "./campaign-resolve.ts";
import { imageSize } from "./prepare-images.ts";
import { startDetection, type DetectionSession } from "./measure-detection.ts";
import {
  buildCampaignConfig,
  configToYaml,
  buildTaskCsv,
  buildStateCsv,
  buildLockCsv,
  buildHistoryCsv,
  buildCommentCsv,
  piecePath,
  type PieceSurfaces,
} from "./campaign-init.ts";
import { buildPieceHead } from "./source-metadata.ts";
import {
  buildBlankScoreMei,
  buildFacsimileMei,
  initialFacsimileModel,
  relinkFacsimileImages,
  replaceMeiHead,
} from "./mei-facsimile.ts";
import { partitionPages, type DetectedPage } from "./pieces.ts";
import {
  wizard,
  clearFinishedSetup,
  COPYRIGHT_ACKNOWLEDGEMENT,
} from "./wizard.svelte.ts";
import { ProgressLog } from "./progress-log.svelte.ts";
import type { FileChange } from "./forge/types.ts";

export class CampaignFinisher {
  busy = $state(false);
  error = $state<string | null>(null);
  readonly log = new ProgressLog();
  // Detection is the slow, failure-prone half of finishing. Its result is
  // kept so a retry after a commit failure does not re-run the detector.
  private detected: DetectedPage[] | null = null;
  private detection: DetectionSession | null = null;

  /** Stop a detection under way, for the step being left. */
  cancel(): void {
    this.detection?.cancel();
  }

  /** Forget a kept detection result, for when the preparation changed. */
  reset(): void {
    this.detected = null;
  }

  /**
   * Every page with its size and, for the measure-detection preparation, its
   * detected measure boxes. One result per page image, not per piece: two
   * pieces sharing a page share its measures. Pages the detector fails on come
   * back empty rather than failing the whole campaign. With OMR the measures
   * are found later, in each piece's layout task, so only the sizes are read.
   */
  private async measurePages(): Promise<DetectedPage[]> {
    const pagesOut: DetectedPage[] = [];
    const name = (i: number) =>
      wizard.images[i].path.split("/").pop() ?? `${i + 1}.jpg`;
    if (wizard.preparation === "omr") {
      this.log.step("Reading the page sizes", { timed: false });
      for (const [i, image] of wizard.images.entries()) {
        const { width, height } = await imageSize(image.blob);
        pagesOut.push({ image: `../img/${name(i)}`, width, height, boxes: [] });
      }
      return pagesOut;
    }
    this.detection = startDetection(wizard.images, measureDetectorUrl);
    for (const i of wizard.images.keys()) {
      this.log.step(
        `Detecting measures on page ${i + 1} of ${wizard.images.length}`,
      );
      this.log.detail(name(i));
      const { width, height, boxes, tookMs } = await this.detection.page(i);
      this.log.detail(
        boxes.length
          ? `${name(i)}: ${boxes.length} measure(s) found`
          : `${name(i)}: no measures found`,
      );
      // Detection runs two pages at a time, so how long this await took says
      // nothing; the job reports its own duration.
      this.log.done(tookMs);
      // graphic @target is resolved relative to the score file, which sits in
      // the piece's own directory (sources/<piece>/score.mei); the images are
      // shared by every piece and committed at sources/img/.
      pagesOut.push({ image: `../img/${name(i)}`, width, height, boxes });
    }
    this.detection = null;
    return pagesOut;
  }

  /** Measure, build, commit, register and list the campaign; then open it. */
  async run(): Promise<void> {
    this.error = null;
    const user = auth.user;
    const f = forge();
    const repo = wizard.repo;
    const claim = wizard.claim;
    if (this.busy) return;
    if (!user || !f) {
      this.error =
        "You are no longer signed in. Log in again to finish the campaign.";
      return;
    }
    if (!claim) {
      // The name is reserved by the first step and registered here; without it
      // the campaign would have nowhere to live.
      this.error =
        "This campaign has no name reserved. Go back to the first step and continue from there.";
      return;
    }
    if (!repo) {
      // Reaching here without a repository means the upload/pages step did not
      // complete; saying so beats a button that does nothing.
      this.error =
        "This campaign has no repository yet. Go back to the upload step and continue from there.";
      return;
    }

    this.busy = true;
    this.log.clear();
    try {
      // A campaign whose config.yaml is committed already has its tables and
      // scores, and volunteers may be working in it; a retry after a failed
      // registration or topic goes straight to those steps.
      const committed =
        (await f.getRepoFile(repo.owner, repo.name, "config.yaml")) != null;
      if (!committed) {
        if (!this.detected) this.detected = await this.measurePages();
        const detected = this.detected;

        // Every piece is published under the campaign's licence, so it is stated
        // in each piece's header as well as in the config.
        const license = wizard.license;
        const split = partitionPages(wizard.pieces, detected);
        // The committed pages, as an uploaded encoding's facsimile is relinked to
        // them: every one was measured at its committed size.
        const images = detected.map((page) => ({
          target: page.image,
          width: page.width,
          height: page.height,
        }));
        const surfaces: PieceSurfaces = {};
        const scores: FileChange[] = [];

        wizard.pieces.forEach((piece, i) => {
          const name = piece.meta.title.trim() || piece.id;
          // Building a score is a string operation: it reports what it did, not
          // how long it took.
          this.log.step(
            `Building the score for ${name} (${i + 1} of ${wizard.pieces.length})`,
            {
              timed: false,
            },
          );
          const head = buildPieceHead(
            {
              title: piece.meta.title,
              composer: piece.meta.composer,
              editor: piece.meta.editor,
              lyricist: piece.meta.lyricist,
              contributors: piece.meta.contributors,
              note: piece.meta.note,
              license,
            },
            wizard.source,
            { creator: user.login },
          );
          if (piece.kind === "encoded") {
            const encoding = wizard.encodings.find(
              (e) => e.name === piece.encodingName,
            );
            if (!encoding)
              throw new Error(
                `The encoding for ${piece.id} is no longer available.`,
              );
            this.log.detail(`from the encoding ${encoding.name}`);
            // An uploaded encoding's facsimile references the files and pixel
            // sizes it was authored against, so it is pointed at the pages this
            // campaign committed: surface n to page n, coordinates scaled with it.
            const relinked = relinkFacsimileImages(encoding.mei, images);
            scores.push({
              path: piecePath(piece.id),
              content: replaceMeiHead(relinked, head),
            });
            return;
          }
          if (piece.kind === "physical-only") {
            // A blank score to transcribe the physical source into. A known page
            // count writes one page-break marker per page, matching the per-page
            // tasks planTasks derives from config; no measure-correction pre-task
            // exists, since there is no facsimile to correct measures on.
            const count = piece.pages ?? 0;
            this.log.detail(
              count > 0
                ? `blank score, ${count} page(s) from the physical source`
                : "blank score, transcribed from the physical source",
            );
            scores.push({
              path: piecePath(piece.id),
              content: buildBlankScoreMei(head, count),
            });
            return;
          }
          // Stage A: facsimile and labelled zones only. The measure body is
          // generated once this piece's measure-correction pre-task validates.
          // An OMR piece has no zones yet: its layout task finds them, so its
          // page tasks are planned from the pages it covers.
          const model = initialFacsimileModel(split[i].pages);
          this.log.detail(
            wizard.preparation === "omr"
              ? `${split[i].pages.length} page(s); staves and measures are found in the layout task`
              : `${split[i].pages.length} page(s), ${split[i].measuredSurfaces.length} with measures`,
          );
          scores.push({
            path: piecePath(piece.id),
            content: buildFacsimileMei({ ...model, headXml: head }),
          });
          if (wizard.preparation !== "omr")
            surfaces[piece.id] = split[i].measuredSurfaces;
        });

        const config = buildCampaignConfig(
          {
            name: wizard.handle.trim(),
            title: wizard.title.trim(),
            description: wizard.description.trim(),
            license,
            sourceKind: wizard.images.length
              ? "facsimile"
              : wizard.encodings.length
                ? "mei-template"
                : "physical-only",
            sourceHeader: {
              title: wizard.source.title,
              composer: wizard.source.composer,
              publisher: wizard.source.publisher,
              date: wizard.source.date,
            },
            images: wizard.images.map((image) => image.path),
            rightsAcknowledged: wizard.copyrightAccepted
              ? COPYRIGHT_ACKNOWLEDGEMENT.version
              : "",
            pieces: wizard.pieces.map((piece) => ({
              id: piece.id,
              kind: piece.kind,
              path: piecePath(piece.id),
              ...(piece.kind === "physical-only" && piece.pages
                ? { pages: piece.pages }
                : {}),
              ...(piece.kind === "facsimile"
                ? { preparation: wizard.preparation }
                : {}),
              zones: piece.zones.map((zone) => ({
                // config records the source's page numbers, 1-based.
                surface: zone.surface + 1,
                ulx: Math.round(zone.ulx),
                uly: Math.round(zone.uly),
                lrx: Math.round(zone.lrx),
                lry: Math.round(zone.lry),
              })),
              header: {
                title: piece.meta.title,
                composer: piece.meta.composer,
              },
            })),
          },
          String(user.id),
          automation,
          repo.id,
        );

        const files: FileChange[] = [
          { path: "config.yaml", content: configToYaml(config) },
          ...scores,
          {
            path: "tracking/task.csv",
            content: buildTaskCsv(config, surfaces),
          },
          {
            path: "tracking/state.csv",
            content: buildStateCsv(config, surfaces),
          },
          { path: "tracking/lock.csv", content: buildLockCsv() },
          { path: "tracking/history.csv", content: buildHistoryCsv() },
          { path: "tracking/comment.csv", content: buildCommentCsv() },
        ];
        this.log.step(`Committing the campaign (${files.length} file(s))`);
        await f.commitFiles(
          repo.owner,
          repo.name,
          files,
          "Initialise campaign",
        );
      }

      // There is a campaign now, so the name it was reserved under becomes its
      // address. This is the reservation being cashed in, not a race: the name
      // has been held since the first step. It can only fail if the reservation
      // ran out and somebody else took the name in the meantime — in which case
      // the setup stays resumable rather than being marked finished.
      this.log.step(`Registering the campaign name “${claim.name}”`);
      const registration = await registerCampaign(
        claim.name,
        repo.id,
        provider.id,
        claim.token,
      );
      if (registration !== "ok") {
        this.error =
          registration === "conflict"
            ? `The reservation of “${claim.name}” ran out and the name went to another campaign. Everything was committed to ${repo.full_name}, but it cannot be reached under that name.`
            : `Everything was committed to ${repo.full_name}, but the name “${claim.name}” could not be registered, so the campaign has no address yet. Try again.`;
        this.busy = false;
        this.log.fail();
        return;
      }

      // The topic is what puts a campaign in the listing, so a campaign missing it
      // is not finished and the setup stays open. Retrying runs this step again,
      // which the registration tolerates; the commit is skipped once it exists.
      this.log.step("Adding it to the list of campaigns");
      try {
        await f.setRepoTopics(repo.owner, repo.name, [provider.repoTopic]);
      } catch (err) {
        console.error(
          "Could not tag the campaign with its topic:",
          (err as Error).message,
        );
        this.error =
          `Everything was committed to ${repo.full_name} and “${claim.name}” is registered, so ` +
          `the campaign already works at /${claim.name}. It is not in the list of ` +
          `campaigns yet, so the setup stays open — retry to add it: ${(err as Error).message}`;
        this.busy = false;
        this.log.fail();
        return;
      }

      // The campaign is committed, reachable and listed, so the setup is done: it
      // is cleared once the campaign has opened, since emptying the wizard while
      // the step is still on screen would show the first step again.
      this.log.done();
      await goto(`/${repo.name}`);
      clearFinishedSetup();
    } catch (err) {
      console.error("Finishing the campaign failed:", (err as Error).message);
      this.error = `Could not finish the campaign: ${(err as Error).message}`;
      this.busy = false;
      this.log.fail();
    }
  }
}
