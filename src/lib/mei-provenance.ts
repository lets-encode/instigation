// Provenance of an accepted contribution, written into a score's <meiHead>:
// a <change> in <revisionDesc>, the contributor among the file's
// responsibility statements, and the editing application in <appInfo>.
//
// Applied by the campaign coordinator to the assembled MEI before the schema
// check, so a header this module writes is held to the same standard as the
// rest of the file. Same conventions as source-metadata.ts: pure regex and
// string handling, no DOM, filesystem or network access.

/** One accepted contribution, as recorded in the header. */
export interface Contribution {
	/** The contributor's name, e.g. a GitHub login. */
	name: string;
	/** What changed, one line — e.g. a commit message's first line. */
	message: string;
	/** When, as an ISO 8601 date or timestamp. */
	isodate: string;
	/** The editing application's name, when known. */
	application?: string;
}

function xmlEscape(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

const indent = (depth: number) => ' '.repeat(depth * 3);

/** Insert `addition` into `xml` directly before the first `closer`. */
function insertBefore(xml: string, closer: string, addition: string): string {
	const at = xml.indexOf(closer);
	return xml.slice(0, at) + addition + xml.slice(at);
}

/** The contributor among the file's responsibility statements, added once. */
function withContributor(head: string, name: string): string {
	const fileDesc = /<fileDesc\b[^>]*>[\s\S]*?<\/fileDesc>/.exec(head);
	if (!fileDesc) return head;
	const titleStmt = /<titleStmt\b[^>]*>[\s\S]*?<\/titleStmt>/.exec(fileDesc[0]);
	if (!titleStmt) return head;

	// Already named in the file's title statement (in any role): nothing to add.
	const named = [...titleStmt[0].matchAll(/<persName\b[^>]*>([\s\S]*?)<\/persName>/g)].some(
		(m) => m[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() === name
	);
	if (named) return head;

	const entry = `${indent(5)}<persName role="contributor">${xmlEscape(name)}</persName>\n`;
	const updated = titleStmt[0].includes('</respStmt>')
		? insertBefore(titleStmt[0], '</respStmt>', entry)
		: insertBefore(
				titleStmt[0],
				'</titleStmt>',
				`${indent(4)}<respStmt>\n${entry}${indent(4)}</respStmt>\n${indent(3)}`
			);
	return head.replace(titleStmt[0], updated);
}

/** The application among <appInfo>'s entries, added once (matched by name). */
function withApplication(head: string, name: string): string {
	const present = new RegExp(`<name[^>]*>\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*</name>`);
	if (present.test(head)) return head;

	const id = `app-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed'}`;
	const application =
		`${indent(4)}<application xml:id="${id}">\n` +
		`${indent(5)}<name>${xmlEscape(name)}</name>\n` +
		`${indent(4)}</application>\n`;

	if (head.includes('</appInfo>')) return insertBefore(head, '</appInfo>', application);
	const appInfo = `${indent(3)}<appInfo>\n${application}${indent(3)}</appInfo>\n`;
	const encodingDesc = /<encodingDesc\b[^>]*>/.exec(head);
	// <appInfo> is <encodingDesc>'s first child. Without an <encodingDesc>, one
	// is added at its place among <meiHead>'s children: right after <fileDesc>.
	if (encodingDesc) {
		const at = encodingDesc.index + encodingDesc[0].length;
		return head.slice(0, at) + `\n${appInfo}${indent(2)}` + head.slice(at);
	}
	return head.replace(
		'</fileDesc>',
		`</fileDesc>\n${indent(2)}<encodingDesc>\n${appInfo}${indent(2)}</encodingDesc>`
	);
}

/** A <change> appended to <revisionDesc>, numbered after the existing ones. */
function withChange(head: string, c: Contribution): string {
	const n = [...head.matchAll(/<change\b/g)].length + 1;
	const change =
		`${indent(3)}<change n="${n}" isodate="${xmlEscape(c.isodate)}">\n` +
		`${indent(4)}<respStmt>\n` +
		`${indent(5)}<persName>${xmlEscape(c.name)}</persName>\n` +
		`${indent(4)}</respStmt>\n` +
		`${indent(4)}<changeDesc>\n` +
		`${indent(5)}<p>${xmlEscape(c.message)}</p>\n` +
		`${indent(4)}</changeDesc>\n` +
		`${indent(3)}</change>\n`;
	if (head.includes('</revisionDesc>')) return insertBefore(head, '</revisionDesc>', change);
	// <revisionDesc> is <meiHead>'s last child.
	return insertBefore(head, '</meiHead>', `${indent(2)}<revisionDesc>\n${change}${indent(2)}</revisionDesc>\n${indent(1)}`);
}

/**
 * Record a contribution in the score's header. The score is returned unchanged
 * when it has no <meiHead>.
 */
export function recordContribution(mei: string, c: Contribution): string {
	const match = /<meiHead\b[^>]*>[\s\S]*?<\/meiHead>/.exec(mei);
	if (!match) return mei;
	const name = c.name.trim();
	const message = (c.message.split('\n', 1)[0] || 'Contribution accepted.').trim();

	let head = match[0];
	if (name) head = withContributor(head, name);
	if (c.application?.trim()) head = withApplication(head, c.application.trim());
	head = withChange(head, { ...c, name, message });
	return mei.slice(0, match.index) + head + mei.slice(match.index + match[0].length);
}
