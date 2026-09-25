// Reading the staff model's MusicXML: the opening attributes of a transcribed
// staff (clef, key, time) and, from several staves, a proposed score
// definition for the setup editor; and correcting a misread clef. Regex over
// the document text, no DOM.

import type { ScoreDefModel, StaffModel } from "./mei-facsimile.ts";
import { clefTokenOf, clefXml } from "./omr-stitch.ts";

/** What the first `<attributes>` of a MusicXML part declares; absent parts are null. */
export interface StaffAttributes {
  clef: { sign: string; line: number; octaveChange: number } | null;
  /** `<key><fifths>`: negative for flats. */
  fifths: number | null;
  time: { beats: string; beatType: string; symbol: string } | null;
}

const text = (xml: string, tag: string): string | null =>
  new RegExp(`<${tag}\\b[^>]*>\\s*([^<]*?)\\s*</${tag}>`).exec(xml)?.[1] ??
  null;

/** The first part's first `<attributes>` block, read for clef, key and time. */
export function readAttributes(musicxml: string): StaffAttributes {
  const block =
    /<attributes\b[^>]*>([\s\S]*?)<\/attributes>/.exec(musicxml)?.[1] ?? "";
  const clefXml = /<clef\b[^>]*>([\s\S]*?)<\/clef>/.exec(block)?.[1];
  const keyXml = /<key\b[^>]*>([\s\S]*?)<\/key>/.exec(block)?.[1];
  const timeTag = /<time\b([^>]*)>([\s\S]*?)<\/time>/.exec(block);
  const sign = clefXml ? text(clefXml, "sign") : null;
  const fifths = keyXml ? text(keyXml, "fifths") : null;
  const beats = timeTag ? text(timeTag[2], "beats") : null;
  const beatType = timeTag ? text(timeTag[2], "beat-type") : null;
  return {
    clef: sign
      ? {
          sign,
          line: Number(
            text(clefXml!, "line") ?? (sign === "F" ? 4 : sign === "C" ? 3 : 2),
          ),
          octaveChange: Number(text(clefXml!, "clef-octave-change") ?? 0),
        }
      : null,
    fifths: fifths !== null && /^-?\d+$/.test(fifths) ? Number(fifths) : null,
    time:
      beats && beatType
        ? {
            beats,
            beatType,
            symbol: /\bsymbol="([^"]*)"/.exec(timeTag![1])?.[1] ?? "",
          }
        : null,
  };
}

/** A plain treble staff, what a staff without readable attributes proposes. */
const TREBLE: StaffModel = {
  clefShape: "G",
  clefLine: 2,
  clefDis: "",
  clefDisPlace: "",
  lines: 5,
  notationType: "",
  label: "",
};

function staffFor(attributes: StaffAttributes): StaffModel {
  const clef = attributes.clef;
  if (!clef) return { ...TREBLE };
  const shape =
    clef.sign === "percussion"
      ? "perc"
      : clef.sign === "TAB"
        ? "TAB"
        : clef.sign;
  const octaves = Math.abs(clef.octaveChange);
  return {
    ...TREBLE,
    clefShape: shape,
    clefLine: clef.line,
    clefDis: octaves === 1 ? "8" : octaves === 2 ? "15" : "",
    clefDisPlace: octaves ? (clef.octaveChange < 0 ? "below" : "above") : "",
  };
}

/** MEI @keysig for a MusicXML fifths count: 0 → '0', 2 → '2s', -3 → '3f'. */
export const keysigFor = (fifths: number): string =>
  fifths === 0
    ? "0"
    : `${Math.min(7, Math.abs(fifths))}${fifths > 0 ? "s" : "f"}`;

/** MusicXML fifths for an MEI @keysig: '2s' → 2, '3f' → -3; 0 for anything else. */
export function fifthsFor(keysig: string): number {
  const m = /^([1-7])([sf])$/.exec(keysig);
  return m ? Number(m[1]) * (m[2] === "s" ? 1 : -1) : 0;
}

/** A staff's clef as one token (`G2`, `F4`, `perc`), or null when unknown. */
export function clefToken(musicxml: string | null): string | null {
  const clef = musicxml ? readAttributes(musicxml).clef : null;
  if (!clef) return null;
  return clef.sign === "percussion"
    ? "perc"
    : clef.sign === "TAB"
      ? "TAB"
      : `${clef.sign}${clef.line}`;
}

/**
 * A score definition proposed from transcriptions: the clefs from one
 * system's staves, top to bottom (`clefSystem`, null for a staff that was
 * not transcribed — the system with the most staves, so every staff of the
 * definition gets its own clef); the key and the meter from the first staff
 * that carries them, searched through `signatureSources` first (the page's
 * opening system, where signatures are printed) and then the clef system,
 * since the model reads an unprinted signature as none. Groups are not
 * proposed. Missing values keep the defaults: treble clef, no accidentals,
 * 4/4.
 */
export function proposeScoreDef(
  clefSystem: (string | null)[],
  signatureSources: (string | null)[] = [],
): ScoreDefModel {
  const read = clefSystem.map((xml) => (xml ? readAttributes(xml) : null));
  const staves = read.map((attributes) =>
    attributes ? staffFor(attributes) : { ...TREBLE },
  );
  const signatures = [
    ...signatureSources.map((xml) => (xml ? readAttributes(xml) : null)),
    ...read,
  ];
  const fifths =
    signatures.find((a) => a?.fifths !== null && a?.fifths !== undefined)
      ?.fifths ?? 0;
  const time = signatures.find((a) => a?.time)?.time ?? null;
  const symbol =
    time?.symbol === "common" || time?.symbol === "cut" ? time.symbol : "";
  return {
    staves: staves.length ? staves : [{ ...TREBLE }],
    groups: [],
    keysig: keysigFor(fifths),
    meterCount: symbol ? (symbol === "cut" ? "2" : "4") : (time?.beats ?? "4"),
    meterUnit: symbol
      ? symbol === "cut"
        ? "2"
        : "4"
      : (time?.beatType ?? "4"),
    meterSym: symbol,
  };
}

const STEPS = "CDEFGAB";

/**
 * The diatonic number (octave × 7 + step) of a clef's bottom line: the clef's
 * own pitch (G4, F3, C4, moved by its octave change) less two steps per line
 * it sits above the bottom one. Null for a clef without pitch (percussion,
 * tablature).
 */
function bottomLine(
  sign: string,
  line: number,
  octaveChange = 0,
): number | null {
  const pitch =
    sign === "G"
      ? 4 * 7 + 4
      : sign === "F"
        ? 3 * 7 + 3
        : sign === "C"
          ? 4 * 7
          : null;
  return pitch === null ? null : pitch + 7 * octaveChange - 2 * (line - 1);
}

/** The diatonic number moved by `delta` steps, as MusicXML step and octave. */
function moved(
  step: string,
  octave: string,
  delta: number,
): { step: string; octave: number } | null {
  const index = STEPS.indexOf(step);
  if (index < 0 || !/^-?\d+$/.test(octave)) return null;
  const n = Number(octave) * 7 + index + delta;
  return { step: STEPS[((n % 7) + 7) % 7], octave: Math.floor(n / 7) };
}

/** Alter for a printed MusicXML accidental; undefined for one that gives none (quarter tones and the like). */
const ACCIDENTAL_ALTER: Record<string, number> = {
  sharp: 1,
  flat: -1,
  natural: 0,
  "double-sharp": 2,
  "sharp-sharp": 2,
  "flat-flat": -2,
  "natural-sharp": 1,
  "natural-flat": -1,
};

/** The diatonic number of a clef token's bottom line; null for a token without pitch. */
function tokenBottomLine(token: string): number | null {
  const m = /^([GFC])(\d)([+-]\d)?$/.exec(token);
  return m ? bottomLine(m[1], Number(m[2]), Number(m[3] ?? 0)) : null;
}

/**
 * A segment of a staff's MusicXML (between two clefs) with its notes moved by
 * `delta` diatonic steps, so each keeps its line or space. A moved note's
 * alter follows what is printed: a printed accidental gives it, and holds for
 * the same step and octave to the end of the measure; a note tied from the
 * one before keeps its alter; any other note without one loses its alter and
 * follows the key. Rests' display positions move the same way.
 */
function shiftSegment(
  segment: string,
  delta: number,
  carried: Map<string, number>,
): string {
  return segment.replace(/<\/measure>|<note\b[\s\S]*?<\/note>/g, (element) => {
    if (element === "</measure>") {
      carried.clear();
      return element;
    }
    let note = element.replace(
      /<display-step>\s*([A-G])\s*<\/display-step>(\s*)<display-octave>\s*(-?\d+)\s*<\/display-octave>/,
      (whole, step: string, between: string, octave: string) => {
        const m = moved(step, octave, delta);
        return m
          ? `<display-step>${m.step}</display-step>${between}<display-octave>${m.octave}</display-octave>`
          : whole;
      },
    );
    const pitch =
      /<pitch>\s*<step>\s*([A-G])\s*<\/step>\s*(?:<alter>[^<]*<\/alter>\s*)?<octave>\s*(-?\d+)\s*<\/octave>\s*<\/pitch>/.exec(
        note,
      );
    if (!pitch) return note;
    const m = moved(pitch[1], pitch[2], delta);
    if (!m) return note;
    const accidental = /<accidental\b[^>]*>\s*([a-z-]+)\s*<\/accidental>/.exec(
      note,
    )?.[1];
    const place = `${m.step}${m.octave}`;
    const printed =
      accidental === undefined ? undefined : ACCIDENTAL_ALTER[accidental];
    if (printed !== undefined) carried.set(place, printed);
    const oldAlter = /<alter>\s*([^<]*?)\s*<\/alter>/.exec(pitch[0])?.[1];
    const tiedOn = /<tie\b[^>]*\btype="stop"/.test(note);
    const alter =
      printed !== undefined
        ? printed
        : accidental !== undefined || tiedOn
          ? Number(oldAlter ?? 0)
          : (carried.get(place) ?? 0);
    const alterXml = alter ? `<alter>${alter}</alter>` : "";
    note = note.replace(
      pitch[0],
      `<pitch><step>${m.step}</step>${alterXml}<octave>${m.octave}</octave></pitch>`,
    );
    return note;
  });
}

const CLEF = /<clef\b[^>]*>[\s\S]*?<\/clef>/g;

/**
 * Where a clef correction stands on a staff: `misread` while the model reads
 * the staff in the misread clef, `read` while it reads the corrected clef
 * itself, `ended` after it read any other clef, which is a real change.
 */
export type ClefCorrectionState = "misread" | "read" | "ended";

/**
 * A staff transcription with a misread clef corrected, from `state` (where
 * the staff stood at the end of its previous transcription; `misread` at the
 * piece's start). Every clef the model read as `read` becomes `corrected`,
 * and the notes it governs, and those before the first clef while the state
 * is `misread`, are moved so they keep their places on the staff. A clef read
 * as `corrected` is no change, and its notes stay. The first clef read as
 * anything else ends the correction for good: a later `read` clef is kept as
 * read. Returned unchanged when either clef has no pitch.
 */
export function correctClef(
  musicxml: string,
  read: string,
  corrected: string,
  state: ClefCorrectionState,
): { musicxml: string; state: ClefCorrectionState } {
  const from = tokenBottomLine(read);
  const to = tokenBottomLine(corrected);
  if (state === "ended" || from === null || to === null)
    return { musicxml, state };
  const delta = to - from;
  const carried = new Map<string, number>();
  const clefs = [...musicxml.matchAll(CLEF)];
  let out = "";
  let at = 0;
  for (const clef of clefs) {
    const segment = musicxml.slice(at, clef.index);
    out +=
      state === "misread" && delta
        ? shiftSegment(segment, delta, carried)
        : segment;
    const token = clefTokenOf(clef[0]);
    if (state !== "ended" && token === read) {
      state = "misread";
      out += clefXml(corrected);
    } else {
      if (state !== "ended") state = token === corrected ? "read" : "ended";
      out += clef[0];
    }
    at = clef.index! + clef[0].length;
  }
  const rest = musicxml.slice(at);
  out +=
    state === "misread" && delta ? shiftSegment(rest, delta, carried) : rest;
  return { musicxml: out, state };
}

/** The staff values of a clef token (see clefXml): shape, line and octave displacement. */
export function clefStaff(
  token: string,
): Pick<StaffModel, "clefShape" | "clefLine" | "clefDis" | "clefDisPlace"> {
  if (token === "perc" || token === "TAB")
    return { clefShape: token, clefLine: 3, clefDis: "", clefDisPlace: "" };
  const m = /^([A-Z])(\d)([+-]\d)?$/.exec(token);
  if (!m) return { clefShape: "G", clefLine: 2, clefDis: "", clefDisPlace: "" };
  const octaves = Math.abs(Number(m[3] ?? 0));
  return {
    clefShape: m[1],
    clefLine: Number(m[2]),
    clefDis:
      octaves === 1 ? "8" : octaves === 2 ? "15" : octaves === 3 ? "22" : "",
    clefDisPlace: octaves ? (Number(m[3]) < 0 ? "below" : "above") : "",
  };
}

/** The clef token of a score staff, with its octave displacement (see clefXml). */
export function staffClefToken(
  staff: Pick<
    StaffModel,
    "clefShape" | "clefLine" | "clefDis" | "clefDisPlace"
  >,
): string {
  if (staff.clefShape === "perc" || staff.clefShape === "TAB")
    return staff.clefShape;
  const octaves =
    staff.clefDis === "8"
      ? 1
      : staff.clefDis === "15"
        ? 2
        : staff.clefDis === "22"
          ? 3
          : 0;
  return `${staff.clefShape}${staff.clefLine}${octaves ? `${staff.clefDisPlace === "below" ? "-" : "+"}${octaves}` : ""}`;
}
