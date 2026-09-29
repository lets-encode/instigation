import { test } from "node:test";
import assert from "node:assert/strict";
import { SyntaxValidator } from "fast-xml-validator";
import {
  buildPieceHead,
  emptySourceMetadata,
  type SourceMetadata,
} from "../source-metadata.ts";
import { buildFacsimileMei, replaceMeiHead } from "../mei-facsimile.ts";
import { parseMeiHeader } from "../mei-header.ts";

function source(): SourceMetadata {
  return {
    ...emptySourceMetadata(),
    title: "Drei Sonaten",
    composer: "L. van Beethoven",
    contributors: [{ name: "A. Editor", role: "editor" }],
    publisher: "Breitkopf & Härtel",
    pubPlace: "Leipzig",
    date: "1802",
    extent: "48 pages",
    condition: "Foxing on the title page",
    note: "Bound with two other sonatas.",
  };
}

test("a piece header carries the piece title and describes the source in its manifestation", () => {
  const head = buildPieceHead(
    { title: "Sonata I", composer: "", license: "CC-BY-4.0" },
    source(),
  );
  assert.equal(SyntaxValidator.validate(`<mei>${head}</mei>`), true);

  // The piece names itself...
  assert.match(head, /<titleStmt[^>]*>\s*<title[^>]*>Sonata I<\/title>/);
  // ...and the source it was read from is described in the manifestation.
  const manifestation =
    /<manifestation\b[\s\S]*<\/manifestation>/.exec(head)?.[0] ?? "";
  assert.match(manifestation, /<title[^>]*>Drei Sonaten<\/title>/);
  assert.match(
    manifestation,
    /<publisher[^>]*>Breitkopf &amp; Härtel<\/publisher>/,
  );
  assert.match(manifestation, /<extent[^>]*>48 pages<\/extent>/);
  assert.match(
    manifestation,
    /<annot[^>]*>Bound with two other sonatas\.<\/annot>/,
  );
  assert.match(head, /<useRestrict[^>]*>CC-BY-4\.0<\/useRestrict>/);
});

test("a piece's own people and note reach its file description", () => {
  const head = buildPieceHead(
    {
      title: "Sonata I",
      composer: "L. van Beethoven",
      editor: "C. Czerny",
      lyricist: "J. W. von Goethe",
      contributors: [{ name: "B. Engraver", role: "engraver" }],
      note: "First movement only.",
    },
    emptySourceMetadata(),
  );
  assert.equal(SyntaxValidator.validate(`<mei>${head}</mei>`), true);
  const fileDesc = /<fileDesc\b[\s\S]*<\/fileDesc>/.exec(head)?.[0] ?? "";
  assert.match(
    fileDesc,
    /<persName[^>]*role="editor"[^>]*>C\. Czerny<\/persName>/,
  );
  assert.match(
    fileDesc,
    /<persName[^>]*role="lyricist"[^>]*>J\. W\. von Goethe<\/persName>/,
  );
  assert.match(
    fileDesc,
    /<persName[^>]*role="engraver"[^>]*>B\. Engraver<\/persName>/,
  );
  assert.match(
    fileDesc,
    /<notesStmt[^>]*>\s*<annot[^>]*>First movement only\.<\/annot>\s*<\/notesStmt>/,
  );
});

test("a piece's composer falls back to the source's", () => {
  for (const { composer, expected } of [
    { composer: "", expected: "L. van Beethoven" },
    { composer: "C. P. E. Bach", expected: "C. P. E. Bach" },
  ]) {
    const head = buildPieceHead({ title: "Sonata I", composer }, source());
    assert.equal(
      parseMeiHeader(`<mei>${head}</mei>`)?.composer,
      expected,
      `piece composer ${JSON.stringify(composer)}`,
    );
  }
});

test("a piece header stays well-formed when nothing is known", () => {
  const head = buildPieceHead(
    { title: "", composer: "" },
    emptySourceMetadata(),
  );
  assert.equal(SyntaxValidator.validate(`<mei>${head}</mei>`), true);
});

test("the piece header drops into a facsimile scaffold", () => {
  const head = buildPieceHead({ title: "Sonata I", composer: "" }, source());
  const mei = buildFacsimileMei({
    headXml: head,
    pages: [
      {
        image: "img/01.jpg",
        width: 800,
        height: 1200,
        zones: [
          {
            box: { ulx: 10, uly: 20, lrx: 110, lry: 220 },
            label: "1",
            pb: true,
            sb: false,
            mdiv: false,
          },
        ],
      },
    ],
  });
  assert.equal(SyntaxValidator.validate(mei), true);
  assert.match(mei, /<title[^>]*>Sonata I<\/title>/);
  assert.match(mei, /<zone [^>]*type="measure"/);
});

test("replaceMeiHead puts the piece’s header in, whatever the document had", () => {
  const head = buildPieceHead(
    { title: "Prelude", composer: "J. S. Bach" },
    emptySourceMetadata(),
  );
  for (const [label, document] of [
    [
      "converted header",
      "<mei><meiHead><fileDesc><titleStmt><title>From Verovio</title></titleStmt></fileDesc></meiHead><music/></mei>",
    ],
    ["no header", "<mei><music/></mei>"],
    ["self-closing header", "<mei><meiHead/><music/></mei>"],
  ]) {
    const out = replaceMeiHead(document, head);
    assert.equal(SyntaxValidator.validate(out), true, label);
    assert.ok(
      !out.includes("From Verovio"),
      `${label}: converter’s header gone`,
    );
    assert.equal(parseMeiHeader(out)?.title, "Prelude", label);
    assert.equal(
      (out.match(/<meiHead/g) ?? []).length,
      1,
      `${label}: exactly one header`,
    );
    assert.ok(out.includes("<music/>"), `${label}: notation kept`);
  }
});
