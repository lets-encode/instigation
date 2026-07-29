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

/** <physDesc> and <notesStmt> for a source's physical object, at depth 4. */
function objectDescription(meta: Pick<SourceMetadata, 'extent' | 'condition' | 'note'>): string {
	const physDesc = optional('extent', meta.extent, 5) + optional('condition', meta.condition, 5);
	return (
		(physDesc ? `${indent(4)}<physDesc>\n${physDesc}${indent(4)}</physDesc>\n` : '') +
		(meta.note.trim()
			? `${indent(4)}<notesStmt>\n` + optional('annot', meta.note, 5) + `${indent(4)}</notesStmt>\n`
			: '')
	);
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

	const manifestation = manifestationListBlock(objectDescription(meta));

	const [before, after] = splitAtManifestationSlot(meta.extraHeadXml);
	return (
		`${indent(1)}<meiHead>\n` +
		`${indent(2)}<fileDesc>\n` +
		`${indent(3)}<titleStmt>\n` +
		`${indent(4)}<title>${xmlEscape(meta.title.trim())}</title>\n` +
		respStmt +
		`${indent(3)}</titleStmt>\n` +
		// pubStmt is required by MEI even when nothing is known about publication.
		`${indent(3)}<pubStmt>\n${pubStmt}${indent(3)}</pubStmt>\n` +
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
	license?: string;
}

/**
 * Build the <meiHead> for one piece's MEI, self-contained: the piece's own
 * title and composer in <titleStmt>, and the whole source copied in as the
 * <manifestation> its <sourceDesc> points at.
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

	// The source, as the manifestation the piece's <sourceDesc> points at.
	const sourcePeople = [
		...(source.composer.trim() ? [{ name: source.composer, role: 'composer' }] : []),
		...source.contributors.filter((person) => person.name.trim())
	];
	const sourceResp = sourcePeople.length
		? `${indent(5)}<respStmt>\n` +
			sourcePeople
				.map(
					(person) =>
						`${indent(6)}<persName role="${xmlEscape(person.role.trim())}">` +
						`${xmlEscape(person.name.trim())}</persName>\n`
				)
				.join('') +
			`${indent(5)}</respStmt>\n`
		: '';
	const sourceTitle = source.title.trim()
		? `${indent(5)}<title>${xmlEscape(source.title.trim())}</title>\n`
		: '';
	const sourcePub =
		optional('publisher', source.publisher, 5) +
		optional('pubPlace', source.pubPlace, 5) +
		optional('date', source.date, 5);
	const manifestation = manifestationListBlock(
		(sourceTitle || sourceResp
			? `${indent(4)}<titleStmt>\n${sourceTitle}${sourceResp}${indent(4)}</titleStmt>\n`
			: '') +
			(sourcePub ? `${indent(4)}<pubStmt>\n${sourcePub}${indent(4)}</pubStmt>\n` : '') +
			objectDescription(source)
	);

	return (
		`${indent(1)}<meiHead>\n` +
		`${indent(2)}<fileDesc>\n` +
		`${indent(3)}<titleStmt>\n` +
		`${indent(4)}<title>${xmlEscape(piece.title.trim())}</title>\n` +
		respStmt +
		`${indent(3)}</titleStmt>\n` +
		`${indent(3)}<pubStmt>\n${availability}${indent(3)}</pubStmt>\n` +
		(manifestation ? SOURCE_DESC_BLOCK : '') +
		`${indent(2)}</fileDesc>\n` +
		`${indent(2)}<encodingDesc>\n` +
		`${indent(3)}<appInfo>\n` +
		`${indent(4)}<application version="1">\n` +
		`${indent(5)}<name>Let's Encode!</name>\n` +
		`${indent(4)}</application>\n` +
		`${indent(3)}</appInfo>\n` +
		`${indent(2)}</encodingDesc>\n` +
		manifestation +
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

	const manifestation = tagInner(tagInner(head, 'manifestationList'), 'manifestation');
	const physDesc = tagInner(manifestation, 'physDesc');
	meta.extent = tagText(physDesc, 'extent');
	meta.condition = tagText(physDesc, 'condition');
	meta.note = tagText(tagInner(manifestation, 'notesStmt'), 'annot');

	// Anything beside the blocks this module builds is markup the form does not
	// model; keep it, in the two halves the next build emits it as.
	const stripped = head
		.replace(/<fileDesc\b[^>]*>[\s\S]*?<\/fileDesc>/, '')
		.replace(/<manifestationList\b[^>]*>[\s\S]*?<\/manifestationList>/, '');
	meta.extraHeadXml = splitAtManifestationSlot(stripped).filter(Boolean).join('\n');
	return meta;
}
