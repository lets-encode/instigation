import { test } from "node:test";
import assert from "node:assert/strict";
import {
  arrowShift,
  drawnBox,
  drawStarted,
  movedBox,
  nudgedEdges,
  pagePoint,
  resizedBox,
} from "../box-geometry.ts";

const page = { width: 1000, height: 800 };
const box = { ulx: 100, uly: 100, lrx: 300, lry: 200 };

test("pagePoint scales the pointer into page pixels and clamps to the page", () => {
  const rect = { left: 10, top: 20, width: 500, height: 400 };
  assert.deepEqual(pagePoint({ clientX: 260, clientY: 220 }, rect, page), {
    x: 500,
    y: 400,
  });
  assert.deepEqual(pagePoint({ clientX: 0, clientY: 900 }, rect, page), {
    x: 0,
    y: 800,
  });
});

test("drawStarted measures the threshold in screen pixels", () => {
  // The page is drawn at half size: 12 screen pixels are 24 page pixels.
  assert.equal(drawStarted(20, 0, page, 500), false);
  assert.equal(drawStarted(24, 0, page, 500), true);
});

test("drawnBox spans the start and the pointer in any direction", () => {
  assert.deepEqual(drawnBox(300, 200, 100, 100, 5), box);
  assert.deepEqual(drawnBox(100, 100, 101, 101, 5), {
    ulx: 100,
    uly: 100,
    lrx: 105,
    lry: 105,
  });
});

test("movedBox keeps the whole box on the page", () => {
  assert.deepEqual(movedBox(box, 50, 10, page), {
    ulx: 150,
    uly: 110,
    lrx: 350,
    lry: 210,
  });
  assert.deepEqual(movedBox(box, -500, 900, page), {
    ulx: 0,
    uly: 700,
    lrx: 200,
    lry: 800,
  });
});

test("resizedBox moves only the grabbed edges and keeps the minimum", () => {
  assert.deepEqual(resizedBox(box, "se", 400, 250, 5), {
    ulx: 100,
    uly: 100,
    lrx: 400,
    lry: 250,
  });
  assert.deepEqual(resizedBox(box, "w", 299, 0, 5), {
    ulx: 295,
    uly: 100,
    lrx: 300,
    lry: 200,
  });
});

test("nudgedEdges shifts the given edges within the page", () => {
  assert.deepEqual(nudgedEdges(box, "e", 800, 0, 5, page), {
    ...box,
    lrx: 1000,
  });
  assert.deepEqual(nudgedEdges(box, "n", 0, 200, 5, page), {
    ...box,
    uly: 195,
  });
});

test("arrowShift maps the arrow keys and ignores others", () => {
  assert.deepEqual(arrowShift("ArrowLeft", 2), { dx: -2, dy: 0 });
  assert.deepEqual(arrowShift("ArrowDown", 10), { dx: 0, dy: 10 });
  assert.equal(arrowShift("Enter", 2), null);
});
