// Whole-source (manifestation-level) metadata for a campaign: the fields the
// wizard's metadata form collects, and the <meiHead> they build.
//
// The form is the source of truth. Building is total — any field set produces
// valid XML — while parsing is best-effort: it reads back the constructs this
// module emits and preserves anything else verbatim in `extraHeadXml`, which is
// re-emitted on the next build. That keeps an expert's hand-written additions
// from being silently dropped without pretending the form models all of MEI.
//
// The boundary is deliberately simple: this module owns <fileDesc> and the
// <manifestationList> holding the source's physical description; any other
// direct child of <meiHead> (<workList>, <extMeta>, …) is carried through
// untouched. Unrecognised markup *inside* those two is not preserved.
//
// Same conventions as mei-facsimile.ts / mei-header.ts: pure regex and string
// handling, no DOM, filesystem or network access.

import { addXmlIds } from './mei-ids.ts';
import { indent, textOf, xmlEscape, xmlUnescape } from './mei-xml.ts';

/** One named agent in the statement of responsibility. */
export interface SourcePerson {
	name: string;
	/** An MEI @role, e.g. "composer", "editor", "engraver". */
	role: string;
}

export interface SourceMetadata {
	/** Short form: what a campaign needs at minimum. */
	title: string;
	publisher: string;
	/** Publication date, as printed on the source (free text, not normalised). */
	date: string;
	composer: string;
	editor: string;
	lyricist: string;
	/** Long form. */
	contributors: SourcePerson[];
	pubPlace: string;
	/** Edition of the source, e.g. "2nd revised edition". */
	edition: string;
	/** Year of that edition (free text, not normalised). */
	editionDate: string;
	/** Physical extent, e.g. "48 pages". */
	extent: string;
	/** Condition of the physical source. */
	condition: string;
	/** Institution holding the source, e.g. a library. */
	repository: string;
	/** The holding institution's shelfmark for the source. */
	shelfmark: string;
	/** Free-text note about the source. */
	note: string;
	/**
	 * Direct children of <meiHead> other than <fileDesc> and <manifestationList>,
	 * preserved verbatim.
	 */
	extraHeadXml: string;
}

export function emptySourceMetadata(): SourceMetadata {
	return {
		title: '',
		publisher: '',
		date: '',
		composer: '',
		editor: '',
		lyricist: '',
		contributors: [],
		pubPlace: '',
		edition: '',
		editionDate: '',
		extent: '',
		condition: '',
		repository: '',
		shelfmark: '',
		note: '',
		extraHeadXml: ''
	};
}

/** The first match of `tag`'s inner text, or '' when the tag is absent. */
function tagText(xml: string, tag: string): string {
	const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml);
	return match ? textOf(match[1]) : '';
}

/** The content of the first `tag` element, markup intact. */
function tagInner(xml: string, tag: string): string {
	const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml);
	return match ? match[1] : '';
}

/** Emit `<tag>text</tag>` at `depth`, or nothing when the value is empty. */
function optional(tag: string, value: string, depth: number): string {
	return value.trim() ? `${indent(depth)}<${tag}>${xmlEscape(value.trim())}</${tag}>\n` : '';
}

/** A <respStmt> naming `people` at `depth`, or nothing when there is no one to name. */
function respStmtBlock(people: SourcePerson[], depth: number): string {
	if (!people.length) return '';
	return (
		`${indent(depth)}<respStmt>\n` +
		people
			.map(
				(person) =>
					`${indent(depth + 1)}<persName role="${xmlEscape(person.role.trim())}">` +
					`${xmlEscape(person.name.trim())}</persName>\n`
			)
			.join('') +
		`${indent(depth)}</respStmt>\n`
	);
}

// The manifestation both headers describe: MEI's <source> carries only
// bibliographic references (<bibl>/<biblStruct>), so the description of the
// physical object goes in a <manifestation> that <sourceDesc> points at.
const MANIFESTATION_ID = 'manifestation-1';

/** <sourceDesc> referring to the manifestation, for use inside <fileDesc>. */
const SOURCE_DESC_BLOCK =
	`${indent(3)}<sourceDesc>\n` +
	`${indent(4)}<source target="#${MANIFESTATION_ID}"/>\n` +
	`${indent(3)}</sourceDesc>\n`;

/**
 * Wrap the manifestation's children (already indented, in MEI's order:
 * titleStmt, pubStmt, physDesc, notesStmt) in <manifestationList>. Nothing
 * known about the object means no manifestation at all.
 */
function manifestationListBlock(parts: string): string {
	if (!parts) return '';
	return (
		`${indent(2)}<manifestationList>\n` +
		`${indent(3)}<manifestation xml:id="${MANIFESTATION_ID}">\n` +
		parts +
		`${indent(3)}</manifestation>\n` +
		`${indent(2)}</manifestationList>\n`
	);
}

/**
 * The manifestation's children describing the source, at depth 4, in the
 * schema's order: identifier, editionStmt, pubStmt, physDesc, physLoc,
 * notesStmt. `titleStmt` (which precedes editionStmt) is the caller's to add.
 *
 * A shelfmark accompanies the <repository> inside <physLoc>; the schema allows
 * an identifier there only after a repository, so a shelfmark without one is
 * emitted as the manifestation's own <identifier>.
 */
function sourceDescription(
	meta: Pick<
		SourceMetadata,
		| 'publisher'
		| 'pubPlace'
		| 'date'
		| 'edition'
		| 'editionDate'
		| 'extent'
		| 'condition'
		| 'repository'
		| 'shelfmark'
		| 'note'
	>
): { identifier: string; parts: string } {
	const identifier =
		meta.shelfmark.trim() && !meta.repository.trim() ? optional('identifier', meta.shelfmark, 4) : '';
	// The edition's year is a <date> within <edition> — distinct from the
	// manifestation's publication date in <pubStmt>.
	const editionInner =
		xmlEscape(meta.edition.trim()) +
		(meta.editionDate.trim()
			? `${meta.edition.trim() ? ' ' : ''}<date>${xmlEscape(meta.editionDate.trim())}</date>`
			: '');
	const edition = editionInner ? `${indent(5)}<edition>${editionInner}</edition>\n` : '';
	const pub =
		optional('publisher', meta.publisher, 5) +
		optional('pubPlace', meta.pubPlace, 5) +
		optional('date', meta.date, 5);
	const physDesc = optional('extent', meta.extent, 5) + optional('condition', meta.condition, 5);
	const physLoc = meta.repository.trim()
		? optional('repository', meta.repository, 5) + optional('identifier', meta.shelfmark, 5)
		: '';
	const parts =
		(edition ? `${indent(4)}<editionStmt>\n${edition}${indent(4)}</editionStmt>\n` : '') +
		(pub ? `${indent(4)}<pubStmt>\n${pub}${indent(4)}</pubStmt>\n` : '') +
		(physDesc ? `${indent(4)}<physDesc>\n${physDesc}${indent(4)}</physDesc>\n` : '') +
		(physLoc ? `${indent(4)}<physLoc>\n${physLoc}${indent(4)}</physLoc>\n` : '') +
		(meta.note.trim()
			? `${indent(4)}<notesStmt>\n` + optional('annot', meta.note, 5) + `${indent(4)}</notesStmt>\n`
			: '');
	return { identifier, parts };
}

/**
 * Split preserved <meiHead> markup at the position <manifestationList> takes
 * among its siblings: after <encodingDesc>/<workList>, before <extMeta> and
 * <revisionDesc>. Emitting the manifestation at that boundary keeps the child
 * order of a rebuilt header valid.
 */
function splitAtManifestationSlot(extra: string): [string, string] {
	const tail = /<(extMeta|revisionDesc)\b/.exec(extra);
	if (!tail) return [extra.trim(), ''];
	return [extra.slice(0, tail.index).trim(), extra.slice(tail.index).trim()];
}

/**
 * Build the <meiHead> for a source. Empty fields are left out rather than
 * emitted blank, so the header states only what is actually known. Every
 * element carries a deterministic xml:id.
 */
export function buildSourceHead(meta: SourceMetadata): string {
	const people = [
		...(meta.composer.trim() ? [{ name: meta.composer, role: 'composer' }] : []),
		...(meta.editor.trim() ? [{ name: meta.editor, role: 'editor' }] : []),
		...(meta.lyricist.trim() ? [{ name: meta.lyricist, role: 'lyricist' }] : []),
		...meta.contributors.filter((person) => person.name.trim())
	];
	const respStmt = respStmtBlock(people, 4);

	// Publication details describe the source, so they go in the manifestation's
	// own <pubStmt>, not the file's.
	const described = sourceDescription(meta);
	const manifestation = manifestationListBlock(described.identifier + described.parts);

	const [before, after] = splitAtManifestationSlot(meta.extraHeadXml);
	return addXmlIds(
		`${indent(1)}<meiHead>\n` +
		`${indent(2)}<fileDesc>\n` +
		`${indent(3)}<titleStmt>\n` +
		`${indent(4)}<title>${xmlEscape(meta.title.trim())}</title>\n` +
		respStmt +
		`${indent(3)}</titleStmt>\n` +
		// pubStmt is required by MEI even when nothing is known about publication.
		`${indent(3)}<pubStmt>\n${indent(3)}</pubStmt>\n` +
		(manifestation ? SOURCE_DESC_BLOCK : '') +
		`${indent(2)}</fileDesc>\n` +
		(before ? `${before}\n` : '') +
		manifestation +
		(after ? `${after}\n` : '') +
		`${indent(1)}</meiHead>`
	);
}

/** A piece's own bibliographic identity, distinct from the source's. */
export interface PieceHead {
	title: string;
	composer: string;
	editor?: string;
	lyricist?: string;
	contributors?: SourcePerson[];
	/** Free-text note about the piece. */
	note?: string;
	license?: string;
}

/** Provenance of the generated file, recorded in its header. */
export interface PieceHeadOrigin {
	/** Who created the file, e.g. a GitHub login. */
	creator?: string;
	/** Creation date (ISO 8601). Defaults to today. */
	date?: string;
}

/**
 * Build the <meiHead> for one piece's MEI, self-contained: the piece's own
 * title and composer in <titleStmt>, and the whole source copied in as the
 * <manifestation> its <sourceDesc> points at.
 *
 * Each piece carries the source description rather than referring to a shared
 * file, so a piece MEI stays meaningful on its own — opened in an editor, or
 * extracted from the campaign entirely. Every element carries a deterministic
 * xml:id.
 */
export function buildPieceHead(
	piece: PieceHead,
	source: SourceMetadata,
	origin: PieceHeadOrigin = {}
): string {
	const composer = piece.composer.trim() || source.composer.trim();
	const piecePeople = [
		...(composer ? [{ name: composer, role: 'composer' }] : []),
		...(piece.editor?.trim() ? [{ name: piece.editor, role: 'editor' }] : []),
		...(piece.lyricist?.trim() ? [{ name: piece.lyricist, role: 'lyricist' }] : []),
		...(piece.contributors ?? []).filter((person) => person.name.trim())
	];
	const respStmt = respStmtBlock(piecePeople, 4);
	const notesStmt = piece.note?.trim()
		? `${indent(3)}<notesStmt>\n` + optional('annot', piece.note, 4) + `${indent(3)}</notesStmt>\n`
		: '';
	const availability = piece.license?.trim()
		? `${indent(4)}<availability>\n` +
			optional('useRestrict', piece.license, 5) +
			`${indent(4)}</availability>\n`
		: '';

	// The source, as the manifestation the piece's <sourceDesc> points at.
	const sourcePeople = [
		...(source.composer.trim() ? [{ name: source.composer, role: 'composer' }] : []),
		...(source.editor.trim() ? [{ name: source.editor, role: 'editor' }] : []),
		...(source.lyricist.trim() ? [{ name: source.lyricist, role: 'lyricist' }] : []),
		...source.contributors.filter((person) => person.name.trim())
	];
	const sourceResp = respStmtBlock(sourcePeople, 5);
	const sourceTitle = source.title.trim()
		? `${indent(5)}<title>${xmlEscape(source.title.trim())}</title>\n`
		: '';
	const described = sourceDescription(source);
	const manifestation = manifestationListBlock(
		described.identifier +
			(sourceTitle || sourceResp
				? `${indent(4)}<titleStmt>\n${sourceTitle}${sourceResp}${indent(4)}</titleStmt>\n`
				: '') +
			described.parts
	);

	// The change element requires a date; the creator is recorded when known.
	const creationDate = (origin.date ?? new Date().toISOString()).slice(0, 10);
	const creationResp = origin.creator?.trim()
		? `${indent(4)}<respStmt>\n` +
			`${indent(5)}<persName>${xmlEscape(origin.creator.trim())}</persName>\n` +
			`${indent(4)}</respStmt>\n`
		: '';

	return addXmlIds(
		`${indent(1)}<meiHead>\n` +
		`${indent(2)}<fileDesc>\n` +
		`${indent(3)}<titleStmt>\n` +
		`${indent(4)}<title>${xmlEscape(piece.title.trim())}</title>\n` +
		// The guidelines recommend a title that marks the file as an electronic
		// work, distinct from the source's title the manifestation carries.
		`${indent(4)}<title type="subordinate">electronic transcription</title>\n` +
		respStmt +
		`${indent(3)}</titleStmt>\n` +
		`${indent(3)}<pubStmt>\n${availability}${indent(3)}</pubStmt>\n` +
		notesStmt +
		(manifestation ? SOURCE_DESC_BLOCK : '') +
		`${indent(2)}</fileDesc>\n` +
		`${indent(2)}<encodingDesc>\n` +
		`${indent(3)}<appInfo>\n` +
		`${indent(4)}<application version="1" xml:id="lets-encode">\n` +
		`${indent(5)}<name>Let's Encode!</name>\n` +
		`${indent(4)}</application>\n` +
		`${indent(3)}</appInfo>\n` +
		`${indent(2)}</encodingDesc>\n` +
		manifestation +
		`${indent(2)}<revisionDesc>\n` +
		`${indent(3)}<change n="1" isodate="${xmlEscape(creationDate)}">\n` +
		creationResp +
		`${indent(4)}<changeDesc>\n` +
		`${indent(5)}<p>Score generated by Let's Encode!</p>\n` +
		`${indent(4)}</changeDesc>\n` +
		`${indent(3)}</change>\n` +
		`${indent(2)}</revisionDesc>\n` +
		`${indent(1)}</meiHead>`
	);
}

/**
 * Read a <meiHead> back into form fields. Constructs this module does not model
 * are kept in `extraHeadXml` so the next build re-emits them.
 */
export function parseSourceHead(xml: string): SourceMetadata {
	const meta = emptySourceMetadata();
	const head = /<meiHead\b[^>]*>([\s\S]*)<\/meiHead>/.exec(xml)?.[1];
	if (head === undefined) return meta;

	const fileDesc = tagInner(head, 'fileDesc');
	const titleStmt = tagInner(fileDesc, 'titleStmt');
	meta.title = tagText(titleStmt, 'title');

	for (const match of tagInner(titleStmt, 'respStmt').matchAll(
		/<(persName|corpName)\b([^>]*)>([\s\S]*?)<\/\1>/g
	)) {
		const role = xmlUnescape(/\brole="([^"]*)"/.exec(match[2])?.[1] ?? '');
		const name = textOf(match[3]);
		if (!name) continue;
		if (role === 'composer' && !meta.composer) {
			meta.composer = name;
			continue;
		}
		if (role === 'editor' && !meta.editor) {
			meta.editor = name;
			continue;
		}
		if (role === 'lyricist' && !meta.lyricist) {
			meta.lyricist = name;
			continue;
		}
		meta.contributors.push({ name, role });
	}

	const manifestation = tagInner(tagInner(head, 'manifestationList'), 'manifestation');
	// Publication details of the source live in the manifestation's <pubStmt>;
	// a header carrying them in <fileDesc> instead is still read.
	const pubStmt = tagInner(manifestation, 'pubStmt') || tagInner(fileDesc, 'pubStmt');
	meta.publisher = tagText(pubStmt, 'publisher');
	meta.pubPlace = tagText(pubStmt, 'pubPlace');
	meta.date = tagText(pubStmt, 'date');

	const editionInner = tagInner(tagInner(manifestation, 'editionStmt'), 'edition');
	meta.editionDate = tagText(editionInner, 'date');
	meta.edition = textOf(editionInner.replace(/<date\b[^>]*>[\s\S]*?<\/date>/, ''));
	const physDesc = tagInner(manifestation, 'physDesc');
	meta.extent = tagText(physDesc, 'extent');
	meta.condition = tagText(physDesc, 'condition');
	const physLoc = tagInner(manifestation, 'physLoc');
	meta.repository = tagText(physLoc, 'repository');
	// A shelfmark sits beside the repository, or — without one — as the
	// manifestation's own <identifier>.
	meta.shelfmark =
		tagText(physLoc, 'identifier') ||
		tagText(
			manifestation
				.replace(/<physLoc\b[^>]*>[\s\S]*?<\/physLoc>/, '')
				.replace(/<pubStmt\b[^>]*>[\s\S]*?<\/pubStmt>/, ''),
			'identifier'
		);
	meta.note = tagText(tagInner(manifestation, 'notesStmt'), 'annot');

	// Anything beside the blocks this module builds is markup the form does not
	// model; keep it, in the two halves the next build emits it as.
	const stripped = head
		.replace(/<fileDesc\b[^>]*>[\s\S]*?<\/fileDesc>/, '')
		.replace(/<manifestationList\b[^>]*>[\s\S]*?<\/manifestationList>/, '');
	meta.extraHeadXml = splitAtManifestationSlot(stripped).filter(Boolean).join('\n');
	return meta;
}
