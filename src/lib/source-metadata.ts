// Whole-source (manifestation-level) metadata for a campaign: the fields the
// wizard's metadata form collects, and the <meiHead> they build.
//
// The form is the source of truth. Building is total — any field set produces
// valid XML — while parsing is best-effort: it reads back the constructs this
// module emits and preserves anything else verbatim in `extraHeadXml`, which is
// re-emitted on the next build. That keeps an expert's hand-written additions
// from being silently dropped without pretending the form models all of MEI.
//
// The boundary is deliberately simple: this module owns <fileDesc>; any other
// direct child of <meiHead> (<workList>, <extMeta>, …) is carried through
// untouched. Unrecognised markup *inside* fileDesc is not preserved.
//
// Same conventions as mei-facsimile.ts / mei-header.ts: pure regex and string
// handling, no DOM, filesystem or network access.

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
	/** Long form. */
	composer: string;
	contributors: SourcePerson[];
	pubPlace: string;
	/** Physical extent, e.g. "48 pages". */
	extent: string;
	/** Condition of the physical source. */
	condition: string;
	/** Free-text note about the source. */
	note: string;
	/** Direct children of <meiHead> other than <fileDesc>, preserved verbatim. */
	extraHeadXml: string;
}

export function emptySourceMetadata(): SourceMetadata {
	return {
		title: '',
		publisher: '',
		date: '',
		composer: '',
		contributors: [],
		pubPlace: '',
		extent: '',
		condition: '',
		note: '',
		extraHeadXml: ''
	};
}

// Escape the minimum needed to keep substituted values well-formed XML, in text
// and double-quoted attribute contexts.
function xmlEscape(value: unknown): string {
	return String(value ?? '')
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

const unescapeXml = (value: string) =>
	value
		.replaceAll('&lt;', '<')
		.replaceAll('&gt;', '>')
		.replaceAll('&quot;', '"')
		.replaceAll('&apos;', "'")
		.replaceAll('&amp;', '&');

/** An element's readable text: nested tags stripped, whitespace collapsed. */
const textOf = (inner: string) =>
	unescapeXml(
		inner
			.replace(/<[^>]*>/g, ' ')
			.replace(/\s+/g, ' ')
			.trim()
	);

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

const indent = (depth: number) => ' '.repeat(depth * 3);

/** Emit `<tag>text</tag>` at `depth`, or nothing when the value is empty. */
function optional(tag: string, value: string, depth: number): string {
	return value.trim() ? `${indent(depth)}<${tag}>${xmlEscape(value.trim())}</${tag}>\n` : '';
}

/**
 * Build the <meiHead> for a source. Empty fields are left out rather than
 * emitted blank, so the header states only what is actually known.
 */
export function buildSourceHead(meta: SourceMetadata): string {
	const people = [
		...(meta.composer.trim() ? [{ name: meta.composer, role: 'composer' }] : []),
		...meta.contributors.filter((person) => person.name.trim())
	];
	const respStmt = people.length
		? `${indent(4)}<respStmt>\n` +
			people
				.map(
					(person) =>
						`${indent(5)}<persName role="${xmlEscape(person.role.trim())}">` +
						`${xmlEscape(person.name.trim())}</persName>\n`
				)
				.join('') +
			`${indent(4)}</respStmt>\n`
		: '';

	const pubStmt =
		optional('publisher', meta.publisher, 4) +
		optional('pubPlace', meta.pubPlace, 4) +
		optional('date', meta.date, 4);

	const physDesc =
		optional('extent', meta.extent, 6) + optional('condition', meta.condition, 6);
	const sourceBody =
		(physDesc ? `${indent(5)}<physDesc>\n${physDesc}${indent(5)}</physDesc>\n` : '') +
		(meta.note.trim()
			? `${indent(5)}<notesStmt>\n` +
				optional('annot', meta.note, 6) +
				`${indent(5)}</notesStmt>\n`
			: '');
	const sourceDesc = sourceBody
		? `${indent(3)}<sourceDesc>\n${indent(4)}<source>\n${sourceBody}${indent(4)}</source>\n${indent(3)}</sourceDesc>\n`
		: '';

	const extra = meta.extraHeadXml.trim();
	return (
		`${indent(1)}<meiHead>\n` +
		`${indent(2)}<fileDesc>\n` +
		`${indent(3)}<titleStmt>\n` +
		`${indent(4)}<title>${xmlEscape(meta.title.trim())}</title>\n` +
		respStmt +
		`${indent(3)}</titleStmt>\n` +
		// pubStmt is required by MEI even when nothing is known about publication.
		`${indent(3)}<pubStmt>\n${pubStmt}${indent(3)}</pubStmt>\n` +
		sourceDesc +
		`${indent(2)}</fileDesc>\n` +
		(extra ? `${extra}\n` : '') +
		`${indent(1)}</meiHead>`
	);
}

/** A piece's own bibliographic identity, distinct from the source's. */
export interface PieceHead {
	title: string;
	composer: string;
	license?: string;
}

/**
 * Build the <meiHead> for one piece's MEI, self-contained: the piece's own
 * title and composer in <titleStmt>, and the whole source copied in as the
 * <source> of its <sourceDesc>.
 *
 * Each piece carries the source description rather than referring to a shared
 * file, so a piece MEI stays meaningful on its own — opened in an editor, or
 * extracted from the campaign entirely.
 */
export function buildPieceHead(piece: PieceHead, source: SourceMetadata): string {
	const composer = piece.composer.trim() || source.composer.trim();
	const respStmt = composer
		? `${indent(4)}<respStmt>\n` +
			`${indent(5)}<persName role="composer">${xmlEscape(composer)}</persName>\n` +
			`${indent(4)}</respStmt>\n`
		: '';
	const availability = piece.license?.trim()
		? `${indent(4)}<availability>\n` +
			optional('useRestrict', piece.license, 5) +
			`${indent(4)}</availability>\n`
		: '';

	// The source, one level deeper than it sits in its own header.
	const sourcePeople = [
		...(source.composer.trim() ? [{ name: source.composer, role: 'composer' }] : []),
		...source.contributors.filter((person) => person.name.trim())
	];
	const sourceResp = sourcePeople.length
		? `${indent(6)}<respStmt>\n` +
			sourcePeople
				.map(
					(person) =>
						`${indent(7)}<persName role="${xmlEscape(person.role.trim())}">` +
						`${xmlEscape(person.name.trim())}</persName>\n`
				)
				.join('') +
			`${indent(6)}</respStmt>\n`
		: '';
	const sourcePub =
		optional('publisher', source.publisher, 6) +
		optional('pubPlace', source.pubPlace, 6) +
		optional('date', source.date, 6);
	const sourcePhys =
		optional('extent', source.extent, 7) + optional('condition', source.condition, 7);
	const sourceBody =
		`${indent(5)}<titleStmt>\n` +
		`${indent(6)}<title>${xmlEscape(source.title.trim())}</title>\n` +
		sourceResp +
		`${indent(5)}</titleStmt>\n` +
		(sourcePub ? `${indent(5)}<pubStmt>\n${sourcePub}${indent(5)}</pubStmt>\n` : '') +
		(sourcePhys ? `${indent(5)}<physDesc>\n${sourcePhys}${indent(5)}</physDesc>\n` : '') +
		(source.note.trim()
			? `${indent(5)}<notesStmt>\n` + optional('annot', source.note, 6) + `${indent(5)}</notesStmt>\n`
			: '');

	return (
		`${indent(1)}<meiHead>\n` +
		`${indent(2)}<fileDesc>\n` +
		`${indent(3)}<titleStmt>\n` +
		`${indent(4)}<title>${xmlEscape(piece.title.trim())}</title>\n` +
		respStmt +
		`${indent(3)}</titleStmt>\n` +
		`${indent(3)}<pubStmt>\n${availability}${indent(3)}</pubStmt>\n` +
		`${indent(3)}<sourceDesc>\n` +
		`${indent(4)}<source>\n${sourceBody}${indent(4)}</source>\n` +
		`${indent(3)}</sourceDesc>\n` +
		`${indent(2)}</fileDesc>\n` +
		`${indent(2)}<encodingDesc>\n` +
		`${indent(3)}<appInfo>\n` +
		`${indent(4)}<application version="1">\n` +
		`${indent(5)}<name>Let's Encode!</name>\n` +
		`${indent(4)}</application>\n` +
		`${indent(3)}</appInfo>\n` +
		`${indent(2)}</encodingDesc>\n` +
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
		const role = unescapeXml(/\brole="([^"]*)"/.exec(match[2])?.[1] ?? '');
		const name = textOf(match[3]);
		if (!name) continue;
		if (role === 'composer' && !meta.composer) {
			meta.composer = name;
			continue;
		}
		meta.contributors.push({ name, role });
	}

	const pubStmt = tagInner(fileDesc, 'pubStmt');
	meta.publisher = tagText(pubStmt, 'publisher');
	meta.pubPlace = tagText(pubStmt, 'pubPlace');
	meta.date = tagText(pubStmt, 'date');

	const source = tagInner(tagInner(fileDesc, 'sourceDesc'), 'source');
	const sourcePhysDesc = tagInner(source, 'physDesc');
	meta.extent = tagText(sourcePhysDesc, 'extent');
	meta.condition = tagText(sourcePhysDesc, 'condition');
	meta.note = tagText(tagInner(source, 'notesStmt'), 'annot');

	// Anything beside <fileDesc> is markup the form does not model; keep it.
	meta.extraHeadXml = head.replace(/<fileDesc\b[^>]*>[\s\S]*?<\/fileDesc>/, '').trim();
	return meta;
}
