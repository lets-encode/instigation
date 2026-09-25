import { test } from "node:test";
import assert from "node:assert/strict";

import { transcribeStaves } from "../omr-transcribe.ts";
import type { OmrClient, OmrExecution } from "../omr-client.ts";

const pipeline = { name: "mzk-staff", version: "1" };

test("transcribeStaves: one page, every crop uploaded, one run per staff, null for a failed staff", async () => {
  const calls: string[] = [];
  const client = {
    async withPage<T>(work: (pageId: string) => Promise<T>) {
      calls.push("create");
      try {
        return await work("p1");
      } finally {
        calls.push("delete");
      }
    },
    async upload(pageId: string, files: Record<string, Blob>) {
      calls.push(`upload ${pageId} ${Object.keys(files).join(",")}`);
    },
    async run(
      pageId: string,
      _pipeline: unknown,
      input: string[],
    ): Promise<OmrExecution> {
      calls.push(`run ${input[0]}`);
      const failed = input[0] === "Staves/2/image.jpg";
      return {
        execution_id: 1,
        pipeline_name: "mzk-staff",
        pipeline_version: "1",
        input,
        state: failed ? "failed" : "completed",
        error: failed ? "malformed sequence" : null,
      };
    },
    async download(_pageId: string, paths: string[]) {
      calls.push(`download ${paths.join(",")}`);
      return Object.fromEntries(
        paths.map((path) => [path, new Blob([`<xml>${path}</xml>`])]),
      );
    },
  } as unknown as OmrClient;

  const xmls = await transcribeStaves(client, pipeline, [
    new Blob(["a"]),
    new Blob(["b"]),
    new Blob(["c"]),
  ]);
  assert.deepEqual(xmls, [
    "<xml>Staves/1/transcription.musicxml</xml>",
    null,
    "<xml>Staves/3/transcription.musicxml</xml>",
  ]);
  assert.deepEqual(calls, [
    "create",
    "upload p1 Staves/1/image.jpg,Staves/2/image.jpg,Staves/3/image.jpg",
    "run Staves/1/image.jpg",
    "run Staves/2/image.jpg",
    "run Staves/3/image.jpg",
    "download Staves/1/transcription.musicxml,Staves/3/transcription.musicxml",
    "delete",
  ]);
});

test("transcribeStaves: no crops, no page", async () => {
  const client = {
    withPage: async () => {
      throw new Error("should not be called");
    },
  } as unknown as OmrClient;
  assert.deepEqual(await transcribeStaves(client, pipeline, []), []);
});

test("transcribeStaves: at most 16 executions run at once, results stay in crop order", async () => {
  let running = 0;
  let peak = 0;
  const client = {
    withPage: <T>(work: (pageId: string) => Promise<T>) => work("p1"),
    async upload() {},
    async run(
      _pageId: string,
      _pipeline: unknown,
      input: string[],
    ): Promise<OmrExecution> {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 1));
      running--;
      return {
        execution_id: 1,
        pipeline_name: "mzk-staff",
        pipeline_version: "1",
        input,
        state: "completed",
        error: null,
      };
    },
    async download(_pageId: string, paths: string[]) {
      return Object.fromEntries(paths.map((path) => [path, new Blob([path])]));
    },
  } as unknown as OmrClient;

  const crops = Array.from({ length: 40 }, () => new Blob(["x"]));
  const xmls = await transcribeStaves(client, pipeline, crops);
  assert.equal(peak, 16);
  assert.deepEqual(
    xmls,
    crops.map((_, k) => `Staves/${k + 1}/transcription.musicxml`),
  );
});
