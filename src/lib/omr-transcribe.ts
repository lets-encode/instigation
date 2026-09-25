// Transcribing staves with the Musibot staff pipeline: crop each staff box
// out of the page image (browser canvas), upload the crops to one ephemeral
// page, run the pipeline once per staff and collect the MusicXML each staff
// produced. A staff the pipeline fails on yields null, not an error: one
// failed staff must not fail a page.

import type { MeasureBox } from "./mei-facsimile.ts";
import type { OmrClient, OmrExecution, OmrPipeline } from "./omr-client.ts";

// The crops go to the staff model as JPEGs, like the pipeline's own crops.
const CROP_JPEG_QUALITY = 0.95;

/** Cut the given rectangles (page pixels, see staffCrops) out of a page image. Browser only. */
export async function cropStaves(
  image: Blob,
  crops: MeasureBox[],
): Promise<Blob[]> {
  const bitmap = await createImageBitmap(image);
  try {
    const out: Blob[] = [];
    for (const crop of crops) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(crop.lrx - crop.ulx));
      canvas.height = Math.max(1, Math.round(crop.lry - crop.uly));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas 2D context unavailable.");
      ctx.drawImage(
        bitmap,
        crop.ulx,
        crop.uly,
        canvas.width,
        canvas.height,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      out.push(
        await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (blob) =>
              blob
                ? resolve(blob)
                : reject(new Error("Could not encode a staff crop.")),
            "image/jpeg",
            CROP_JPEG_QUALITY,
          ),
        ),
      );
    }
    return out;
  } finally {
    bitmap.close();
  }
}

// Executions in flight at once. Each running execution is polled about once
// per second, so this bounds the page's steady call rate on the relay.
const MAX_CONCURRENT_RUNS = 16;

const cropPath = (k: number) => `Staves/${k + 1}/image.jpg`;
const resultPath = (k: number) => `Staves/${k + 1}/transcription.musicxml`;

/**
 * Run the staff pipeline over the crops, all on one page and at most
 * MAX_CONCURRENT_RUNS at a time, and return each staff's MusicXML in crop
 * order; null where the pipeline failed or wrote nothing.
 */
export async function transcribeStaves(
  client: OmrClient,
  pipeline: OmrPipeline,
  crops: Blob[],
): Promise<(string | null)[]> {
  if (!crops.length) return [];
  return client.withPage(async (pageId) => {
    await client.upload(
      pageId,
      Object.fromEntries(crops.map((crop, k) => [cropPath(k), crop])),
    );
    const executions: OmrExecution[] = [];
    let next = 0;
    const worker = async () => {
      while (next < crops.length) {
        const k = next++;
        executions[k] = await client.run(pageId, pipeline, [cropPath(k)]);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(MAX_CONCURRENT_RUNS, crops.length) },
        worker,
      ),
    );
    const completed = executions.flatMap((e, k) =>
      e.state === "completed" ? [k] : [],
    );
    const files = await client.download(pageId, completed.map(resultPath));
    return Promise.all(
      crops.map(async (_, k) => {
        const file = files[resultPath(k)];
        return file ? file.text() : null;
      }),
    );
  });
}
