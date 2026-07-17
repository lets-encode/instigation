// Read-only view of a score's <meiHead>, for display in the campaign console.
// Same conventions as mei-facsimile.ts: pure regex/string parsing, no DOM,
// filesystem or network access.

/** One named person from the header, with the role the header assigns them. */
export interface HeaderPerson {
	name: string;
	role: string;
}

/** The header fields the console displays. */
export interface MeiHeader {
	title: string;
	composer: string;
	/** persName/corpName entries other than the composer. */
	contributors: HeaderPerson[];
}

const unescapeXml = (value: string) =>
	value
		.replaceAll('&lt;', '<')
		.replaceAll('&gt;', '>')
		.replaceAll('&quot;', '"')
		.replaceAll('&apos;', "'")
		.replaceAll('&amp;', '&');

// An element's readable text: nested tags stripped, whitespace collapsed.
const textOf = (inner: string) =>
	unescapeXml(inner.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());

/**
 * Parse the display fields out of a score's <meiHead>. Returns null when the
 * text has no header. People are collected from every persName/corpName
 * element in the header; the first one with role="composer" becomes the
 * composer, the rest are contributors (deduplicated by name and role).
 */
export function parseMeiHeader(mei: string): MeiHeader | null {
	const head = /<meiHead[\s>][\s\S]*?<\/meiHead>/.exec(mei)?.[0];
	if (!head) return null;

	const title = textOf(/<title\b[^>]*>([\s\S]*?)<\/title>/.exec(head)?.[1] ?? '');

	let composer = '';
	const contributors: HeaderPerson[] = [];
	const seen = new Set<string>();
	for (const m of head.matchAll(/<(persName|corpName)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
		const role = unescapeXml(/\brole="([^"]*)"/.exec(m[2])?.[1] ?? '');
		const name = textOf(m[3]);
		if (!name) continue;
		if (role === 'composer' && !composer) {
			composer = name;
			continue;
		}
		const key = `${role}\u0000${name}`;
		if (seen.has(key)) continue;
		seen.add(key);
		contributors.push({ name, role });
	}

	return { title, composer, contributors };
}
