// xml:id assignment for generated MEI. Same conventions as mei-facsimile.ts /
// source-metadata.ts: pure regex and string handling, no DOM.

// A start tag (never a closing tag, comment, CDATA section, processing
// instruction or doctype), quote-aware so `>` inside an attribute value does
// not end the match. Groups: tag name, attributes, self-closing slash.
const START_TAG =
	/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<([A-Za-z_][\w.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;

/**
 * Add an xml:id to every element that lacks one. Ids are deterministic — the
 * tag name plus a per-tag counter in document order (fileDesc-1, staff-2, …),
 * skipping values the document already uses — so rebuilds are stable and
 * diffable. Elements with an xml:id keep it.
 */
export function addXmlIds(xml: string): string {
	const used = new Set<string>();
	for (const match of xml.matchAll(/\bxml:id\s*=\s*"([^"]*)"/g)) used.add(match[1]);
	const counters = new Map<string, number>();
	return xml.replace(START_TAG, (tag, name?: string, attrs?: string, selfClose?: string) => {
		if (!name) return tag;
		if (/\bxml:id\s*=/.test(attrs ?? '')) return tag;
		let n = counters.get(name) ?? 0;
		let id: string;
		do id = `${name}-${++n}`;
		while (used.has(id));
		counters.set(name, n);
		used.add(id);
		return `<${name} xml:id="${id}"${attrs ?? ''}${selfClose ?? ''}>`;
	});
}
