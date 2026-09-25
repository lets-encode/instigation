// Recognition of every staff box of an OMR-prepared piece, run by the score
// setup's claim holder: each staff is transcribed by the staff pipeline and
// its instrument label read (OCR) in front of it, and the results form the
// piece's recognition record (`omr.xml`). A staff the record at the head
// already holds for the same box and pipeline, or this browser kept from an
// earlier run, is not transcribed again; a failed staff always is. Pages are
// transcribed two at a time, on one Musibot page. Browser only: canvas crops,
// the OCR worker and IndexedDB.

import type { ForgeClient } from "./forge/types.ts";
import type { PageModel } from "./mei-facsimile.ts";
import type { OmrClient, OmrPipeline } from "./omr-client.ts";
import { pageSystems, STAFF_CROP_MARGIN, staffCrops } from "./omr-layout.ts";
import {
  entryFor,
  type OmrPageEntry,
  type OmrRecord,
  type OmrStaffEntry,
} from "./omr-record.ts";
import {
  readCachedStaves,
  staffCacheKey,
  writeCachedStaves,
} from "./omr-staff-cache.ts";
import { cropStaves, transcribeStaves } from "./omr-transcribe.ts";
import { OCR_ENGINE, readStaffLabels } from "./ocr.ts";
import { resolveRepoRelativeTarget } from "./facsimile-images.ts";

export interface PieceRecognitionOptions {
  forge: ForgeClient;
  client: OmrClient;
  owner: string;
  repo: string;
  repoId: number;
  /** The piece's score path; page images resolve against it. */
  fragment: string;
  pages: PageModel[];
  /** The record at the head, when the piece has one. */
  existing: OmrRecord | null;
  pipeline: OmrPipeline;
  progress: (step: string) => void;
}

export interface PieceRecognition {
  record: OmrRecord;
  /** Staves without a transcription, as page and staff box number (1-based). */
  failed: { page: number; staff: number }[];
  /** Staves taken from this browser's earlier runs. */
  fromCache: number;
  /** Pages whose labels could not be read, with the reason. */
  labelErrors: { page: number; error: string }[];
}

const PAGES_PER_RUN = 2;

export async function recognisePiece(
  o: PieceRecognitionOptions,
): Promise<PieceRecognition> {
  const zoneOf = (n: number, k: number) => `staff-zone-${n}-${k + 1}`;
  const keyOf = (n: number, k: number, pg: PageModel) =>
    staffCacheKey(
      o.repoId,
      zoneOf(n, k),
      pg.staves![k],
      o.pipeline,
      STAFF_CROP_MARGIN,
    );

  // What the head's record and this browser already hold.
  const entries: (OmrStaffEntry | null)[][] = o.pages.map((pg, p) =>
    (pg.staves ?? []).map((box, k) => {
      const entry = entryFor(
        o.existing,
        zoneOf(p + 1, k),
        box,
        o.pipeline,
        STAFF_CROP_MARGIN,
      );
      return entry?.musicxml ? entry : null;
    }),
  );
  const missingKeys = o.pages.flatMap((pg, p) =>
    (pg.staves ?? []).flatMap((_, k) =>
      entries[p][k] ? [] : [keyOf(p + 1, k, pg)],
    ),
  );
  const cached = await readCachedStaves(missingKeys);
  o.pages.forEach((pg, p) =>
    (pg.staves ?? []).forEach((box, k) => {
      const hit = entries[p][k] ? null : cached.get(keyOf(p + 1, k, pg));
      if (hit)
        entries[p][k] = {
          zone: zoneOf(p + 1, k),
          box,
          label: hit.label,
          musicxml: hit.musicxml,
          error: "",
        };
    }),
  );
  const fromCache = cached.size;
  if (fromCache)
    o.progress(
      `Continuing with ${fromCache} staves transcribed earlier in this browser`,
    );

  const todo = o.pages.flatMap((pg, p) =>
    entries[p].some((e) => !e) ? [p] : [],
  );
  if (todo.length) {
    o.progress("Checking the recognition service");
    await o.client.requirePipelines([o.pipeline]);
  }
  const labelErrors: PieceRecognition["labelErrors"] = [];
  let failedSoFar = 0;
  for (let i = 0; i < todo.length; i += PAGES_PER_RUN) {
    const batch = todo.slice(i, i + PAGES_PER_RUN);
    const numbers = batch.map((p) => p + 1);
    const failedNote = failedSoFar
      ? ` (${failedSoFar} staves failed so far)`
      : "";
    o.progress(
      `Transcribing page${numbers.length > 1 ? "s" : ""} ${numbers.join(" and ")} of ${o.pages.length}${failedNote}`,
    );
    const work = await Promise.all(
      batch.map(async (p) => {
        const pg = o.pages[p];
        const path = resolveRepoRelativeTarget(o.fragment, pg.image);
        const image = path
          ? await o.forge.getRepoFileBytes(o.owner, o.repo, path)
          : null;
        if (!image)
          throw new Error(
            `the image of page ${p + 1} (${pg.image}) could not be read.`,
          );
        const missing = (pg.staves ?? []).flatMap((_, k) =>
          entries[p][k] ? [] : [k],
        );
        const crops = await cropStaves(
          image,
          staffCrops(
            missing.map((k) => pg.staves![k]),
            pg,
          ),
        );
        return { p, pg, image, missing, crops };
      }),
    );
    const xmls = await transcribeStaves(
      o.client,
      o.pipeline,
      work.flatMap((w) => w.crops),
    );
    let at = 0;
    const kept: [string, { musicxml: string; label: string }][] = [];
    for (const w of work) {
      const results = xmls.slice(at, (at += w.crops.length));
      // Labels for the whole page; a failed reading leaves them blank.
      let labels = new Map<number, string>();
      try {
        const { systems } = pageSystems(w.pg);
        const read = await readStaffLabels(w.image, systems);
        systems.forEach((system, s) =>
          system.forEach((box, i) =>
            labels.set(w.pg.staves!.indexOf(box), read[s][i]),
          ),
        );
      } catch (e) {
        labels = new Map();
        labelErrors.push({ page: w.p + 1, error: (e as Error).message });
      }
      w.missing.forEach((k, j) => {
        const musicxml = results[j];
        const label = labels.get(k) ?? "";
        entries[w.p][k] = {
          zone: zoneOf(w.p + 1, k),
          box: w.pg.staves![k],
          label,
          musicxml,
          error: musicxml
            ? ""
            : "The staff pipeline returned no transcription.",
        };
        if (musicxml) kept.push([keyOf(w.p + 1, k, w.pg), { musicxml, label }]);
        else failedSoFar++;
      });
    }
    await writeCachedStaves(kept);
  }

  const pages: OmrPageEntry[] = o.pages.flatMap((pg, p) =>
    pg.staves?.length
      ? [{ n: p + 1, image: pg.image, staves: entries[p].map((e) => e!) }]
      : [],
  );
  return {
    record: {
      cropMargin: STAFF_CROP_MARGIN,
      staffPipeline: o.pipeline,
      ocr: OCR_ENGINE,
      pages,
      assignments: o.existing?.assignments ?? [],
      clefs: o.existing?.clefs ?? [],
    },
    failed: pages.flatMap((page) =>
      page.staves.flatMap((s, k) =>
        s.musicxml ? [] : [{ page: page.n, staff: k + 1 }],
      ),
    ),
    fromCache,
    labelErrors,
  };
}
