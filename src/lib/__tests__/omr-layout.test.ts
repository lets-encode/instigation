import { test } from "node:test";
import assert from "node:assert/strict";

import {
  correctedLayoutJson,
  layoutBoxes,
  layoutRecord,
  pageSystems,
  staffCountOf,
  staffCrops,
  withCorrectedLayout,
} from "../omr-layout.ts";
import {
  buildFacsimileMei,
  parseFacsimileMei,
  type PageModel,
} from "../mei-facsimile.ts";

// The category ids the layout model uses (layout.json's `categories`).
const categories = [
  { id: 0, name: "staff" },
  { id: 2, name: "grandstaff" },
  { id: 3, name: "system" },
  { id: 4, name: "staffMeasure" },
  { id: 6, name: "systemMeasure" },
];

test("systemMeasure boxes become measures, staff boxes staves, grandstaff boxes grand staves; other categories are ignored", () => {
  const layout = {
    categories,
    images: [{ id: 0, width: 1000, height: 1500, file_name: "image.jpg" }],
    annotations: [
      {
        category_id: 6,
        bbox: [100.4, 200.6, 300, 120] as [number, number, number, number],
      },
      {
        category_id: 0,
        bbox: [90, 210, 800, 40] as [number, number, number, number],
      },
      {
        category_id: 3,
        bbox: [80, 190, 850, 150] as [number, number, number, number],
      },
      {
        category_id: 4,
        bbox: [100, 210, 300, 40] as [number, number, number, number],
      },
      {
        category_id: 2,
        bbox: [80, 190, 850, 150] as [number, number, number, number],
      },
    ],
  };
  assert.deepEqual(layoutBoxes(layout, { width: 1000, height: 1500 }), {
    measures: [{ ulx: 100, uly: 201, lrx: 400, lry: 321 }],
    staves: [{ ulx: 90, uly: 210, lrx: 890, lry: 250 }],
    grandstaves: [{ ulx: 80, uly: 190, lrx: 930, lry: 340 }],
  });
});

test("boxes are scaled to the page when the document declares another image size, and clamped", () => {
  const layout = {
    categories,
    images: [{ width: 500, height: 750 }],
    annotations: [
      {
        category_id: 6,
        bbox: [400, 700, 200, 100] as [number, number, number, number],
      },
      // No area once clamped to the page: dropped.
      {
        category_id: 0,
        bbox: [500, 10, 50, 20] as [number, number, number, number],
      },
    ],
  };
  assert.deepEqual(layoutBoxes(layout, { width: 1000, height: 1500 }), {
    measures: [{ ulx: 800, uly: 1400, lrx: 1000, lry: 1500 }],
    staves: [],
    grandstaves: [],
  });
});

test("a layout without annotations or categories is an empty page", () => {
  assert.deepEqual(layoutBoxes({}, { width: 10, height: 10 }), {
    measures: [],
    staves: [],
    grandstaves: [],
  });
});

test("staffCrops grows each staff by its height times the margin, clamped to the page", () => {
  assert.deepEqual(
    staffCrops(
      [
        { ulx: 100, uly: 50, lrx: 900, lry: 110 },
        { ulx: 100, uly: 500, lrx: 900, lry: 560 },
      ],
      { width: 1000, height: 600 },
    ),
    [
      { ulx: 46, uly: 0, lrx: 954, lry: 164 },
      { ulx: 46, uly: 446, lrx: 954, lry: 600 },
    ],
  );
});

// A measure zone; `start` marks the first measure of a system.
const zone = (uly: number, lry: number, ulx: number, start = false) => ({
  box: { ulx, uly, lrx: ulx + 500, lry },
  label: "",
  pb: false,
  sb: start,
  mdiv: false,
});
const staff = (uly: number) => ({ ulx: 0, uly, lrx: 1000, lry: uly + 60 });

test("pageSystems groups staves by the systems of measure zones, whatever their staff count", () => {
  // System 1 (100–400) holds three staves, system 2 (600–800) two; one staff
  // box lies on no system, one straddles the gap but overlaps system 2 more.
  const page = {
    zones: [
      zone(100, 400, 0, true),
      zone(100, 400, 500),
      zone(600, 800, 0, true),
      zone(600, 800, 500),
    ],
    staves: [
      staff(700),
      staff(300),
      staff(120),
      staff(210),
      staff(560),
      staff(900),
    ],
  };
  const { systems, unplaced } = pageSystems(page);
  assert.deepEqual(
    systems.map((system) => system.map((s) => s.uly)),
    [
      [120, 210, 300],
      [560, 700],
    ],
  );
  assert.equal(unplaced, 1);
});

test("pageSystems keeps a system without staves in its place", () => {
  // Three systems; the staves of the first are missing.
  const page = {
    zones: [
      zone(0, 200, 0, true),
      zone(300, 500, 0, true),
      zone(600, 800, 0, true),
    ],
    staves: [staff(320), staff(420), staff(620), staff(720)],
  };
  assert.deepEqual(
    pageSystems(page).systems.map((system) => system.map((s) => s.uly)),
    [[], [320, 420], [620, 720]],
  );
  assert.deepEqual(pageSystems({ zones: [], staves: [staff(0)] }), {
    systems: [],
    unplaced: 1,
  });
});

test("staffCountOf is the largest system of any page, else 1", () => {
  const page = (...counts: number[]) => ({
    zones: counts.map((_, i) => zone(i * 1000, i * 1000 + 900, 0, true)),
    staves: counts.flatMap((count, i) =>
      Array.from({ length: count }, (_, k) => staff(i * 1000 + 10 + k * 100)),
    ),
  });
  assert.equal(staffCountOf([page(2, 3), page(2)]), 3);
  assert.equal(staffCountOf([page(1, 1)]), 1);
  assert.equal(staffCountOf([page(0)]), 1);
  assert.equal(staffCountOf([]), 1);
});

test("layoutRecord marks the raw layouts as uncorrected and names the model", () => {
  const layout = {
    categories,
    images: [{ width: 10, height: 10 }],
    annotations: [],
  };
  const record = layoutRecord({ name: "dvorak-ola", version: "2.0" }, [
    { image: "img/01.jpg", layout },
  ]);
  assert.equal(record.corrected, false);
  assert.deepEqual(record.model, { name: "dvorak-ola", version: "2.0" });
  assert.match(record.note, /not corrected/);
  assert.deepEqual(record.pages, [{ image: "img/01.jpg", layout }]);
});

test("the corrected layout restores the tight measure boxes and the staff boxes a padded score leaves out", () => {
  const zone = (box: PageModel["zones"][number]["box"], pb: boolean) => ({
    box,
    label: "1",
    pb,
    sb: false,
    mdiv: false,
  });
  const pages: PageModel[] = [
    {
      image: "img/01.jpg",
      width: 1000,
      height: 1400,
      zones: [
        zone({ ulx: 100, uly: 100, lrx: 500, lry: 300 }, true),
        zone({ ulx: 500, uly: 100, lrx: 900, lry: 300 }, false),
      ],
      staves: [{ ulx: 100, uly: 120, lrx: 900, lry: 180 }],
      grandstaves: [{ ulx: 90, uly: 110, lrx: 900, lry: 290 }],
    },
    { image: "img/02.jpg", width: 1000, height: 1400, zones: [] },
  ];
  const head = '<meiHead xml:id="h"><fileDesc xml:id="f"/></meiHead>';
  const parsed = parseFacsimileMei(
    buildFacsimileMei(
      { headXml: head, pages },
      { withBreaks: true, emptyMeasures: true, padZones: true },
    ),
  );
  assert.deepEqual(parsed.pages[0].zones[0].box, {
    ulx: 85,
    uly: 85,
    lrx: 515,
    lry: 315,
  });
  const restored = withCorrectedLayout(
    parsed.pages,
    correctedLayoutJson(pages),
  );
  assert.deepEqual(
    restored.map((pg) => pg.zones.map((z) => z.box)),
    pages.map((pg) => pg.zones.map((z) => z.box)),
  );
  assert.deepEqual(restored[0].staves, pages[0].staves);
  assert.deepEqual(restored[0].grandstaves, pages[0].grandstaves);
  assert.deepEqual(restored[1].staves, []);
});

test("withCorrectedLayout refuses a file that does not match the score, or a missing one for a score with zones", () => {
  const page = (zones: number): PageModel => ({
    image: "img/01.jpg",
    width: 100,
    height: 100,
    zones: Array.from({ length: zones }, () => ({
      box: { ulx: 0, uly: 0, lrx: 10, lry: 10 },
      label: "1",
      pb: false,
      sb: false,
      mdiv: false,
    })),
  });
  const json = correctedLayoutJson([page(2)]);
  assert.throws(
    () => withCorrectedLayout([page(1)], json),
    /Page 1: layout-corrected.json has 2 measure boxes, the score 1 measure zones/,
  );
  assert.throws(
    () => withCorrectedLayout([page(2), page(0)], json),
    /layout-corrected.json has 1 pages, the score 2/,
  );
  assert.throws(
    () => withCorrectedLayout([page(1)], null),
    /no layout-corrected.json/,
  );
  const empty = [page(0)];
  assert.equal(withCorrectedLayout(empty, null), empty);
});
