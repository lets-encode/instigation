// A source with every modelled field filled, shared by the tests that build
// or validate headers from it.

import type { SourceMetadata } from "../source-metadata.ts";

export function filledSource(): SourceMetadata {
  return {
    title: "Sonate für Klavier",
    publisher: "Breitkopf & Härtel",
    date: "1802",
    composer: "L. van Beethoven",
    editor: "A. Editor",
    lyricist: "J. W. von Goethe",
    contributors: [{ name: "B. Engraver", role: "engraver" }],
    pubPlace: "Leipzig",
    edition: "2nd revised edition",
    editionDate: "1854",
    extent: "48 pages",
    condition: "Foxing on the title page",
    repository: "Austrian National Library",
    shelfmark: "Mus.Hs.16481",
    note: "Bound with two other sonatas.",
    extraHeadXml: "",
  };
}
