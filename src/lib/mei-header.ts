// Read-only view of a score's <meiHead>, for display in the campaign console.
// Same conventions as mei-facsimile.ts: pure regex/string parsing, no DOM,
// filesystem or network access.

import { textOf, xmlUnescape } from './mei-xml.ts';

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

// How specific a role is, for keeping one entry per person. A named role
// (editor, encoder, …) beats the generic "contributor", which beats a
// persName carrying no role at all.
function roleRank(role: string): number {
	if (role === 'composer') return 3;
	if (role === 'contributor') return 1;
	return role ? 2 : 0;
}

/**
 * Parse the display fields out of a score's <meiHead>. Returns null when the
 * text has no header. People are collected from every persName/corpName
 * element in the header — a header names the same person in several places
 * (title statement, manifestation, revisionDesc changes), so entries are
 * deduplicated by name, each person keeping their most specific role. The
 * first person named composer becomes the composer, the rest are contributors.
 */
export function parseMeiHeader(mei: string): MeiHeader | null {
	const head = /<meiHead[\s>][\s\S]*?<\/meiHead>/.exec(mei)?.[0];
	if (!head) return null;

	const title = textOf(/<title\b[^>]*>([\s\S]*?)<\/title>/.exec(head)?.[1] ?? '');

	const people: HeaderPerson[] = [];
	const byName = new Map<string, HeaderPerson>();
	for (const m of head.matchAll(/<(persName|corpName)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
		const role = xmlUnescape(/\brole="([^"]*)"/.exec(m[2])?.[1] ?? '');
		const name = textOf(m[3]);
		if (!name) continue;
		const known = byName.get(name);
		if (!known) {
			const person = { name, role };
			byName.set(name, person);
			people.push(person);
		} else if (roleRank(role) > roleRank(known.role)) {
			known.role = role;
		}
	}

	let composer = '';
	const contributors: HeaderPerson[] = [];
	for (const person of people) {
		if (person.role === 'composer' && !composer) composer = person.name;
		else contributors.push(person);
	}

	return { title, composer, contributors };
}
