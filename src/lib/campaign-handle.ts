// Campaign handle: validation, and derivation of a short slug-safe handle from a
// piece title. Pure string logic — no forge or DOM access — so it is shared by
// the onboarding wizard and unit-tested directly.

// The handle is also the GitHub repo name AND the campaign's registry slug, so
// it must satisfy the registry's slug rules (lowercase, digits, single internal
// hyphens, length 3–40). Keep in sync with redirector/app/validation.py.
export const SLUG_RE = /^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])?$/;

export const isValidHandle = (h: string) => SLUG_RE.test(h) && !h.includes('--');

// Generic words dropped when deriving a handle, so the distinctive words of a
// title survive. Articles, prepositions and conjunctions in the languages
// common to the music repertoire. Single letters (a, e, y, à…) need no entry —
// the lone-letter rule below drops them. Words with diacritics are listed as
// they arrive after transliteration (für → fuer, dièse → diese).
const STOP_WORDS = new Set([
	// English
	'the',
	'an',
	'of',
	'in',
	'for',
	'and',
	'or',
	'to',
	'from',
	'on',
	'by',
	'at',
	'with',
	// German
	'der',
	'die',
	'das',
	'dem',
	'den',
	'des',
	'ein',
	'eine',
	'einem',
	'einen',
	'einer',
	'eines',
	'und',
	'oder',
	'im',
	'am',
	'an',
	'auf',
	'aus',
	'bei',
	'mit',
	'nach',
	'von',
	'vor',
	'zu',
	'zum',
	'zur',
	'fuer',
	'ueber',
	'unter',
	// Italian
	'il',
	'lo',
	'gli',
	'le',
	'un',
	'uno',
	'una',
	'di',
	'da',
	'su',
	'con',
	'per',
	'tra',
	'fra',
	'ed',
	'ad',
	'al',
	'allo',
	'alla',
	'alle',
	'agli',
	'dal',
	'dallo',
	'dalla',
	'dalle',
	'del',
	'dello',
	'della',
	'delle',
	'dei',
	'degli',
	'nel',
	'nello',
	'nella',
	'nelle',
	'sul',
	'sullo',
	'sulla',
	'sulle',
	// French
	'la',
	'les',
	'une',
	'de',
	'du',
	'des',
	'et',
	'ou',
	'au',
	'aux',
	'en',
	'sur',
	'pour',
	'dans',
	'par',
	'avec',
	'sans',
	// Spanish
	'el',
	'los',
	'las',
	'unos',
	'unas',
	'sin',
	'sobre',
	'para',
	'por',
	// Latin
	'ad',
	'ab',
	'cum',
	'ex',
	'pro',
	'sub',
	'super'
]);

// Key designations ("Si bémol majeur", "c-Moll", "C sharp minor") are collapsed
// into one normalised token — note letter, s/b for sharp/flat, English mode —
// so the key survives in the handle as a uniform qualifier: bb-major, cs-minor.
const KEY_MODES: Record<string, string> = {
	major: 'major',
	dur: 'major',
	maggiore: 'major',
	majeur: 'major',
	mayor: 'major',
	minor: 'minor',
	moll: 'minor',
	minore: 'minor',
	mineur: 'minor',
	menor: 'minor'
};
const KEY_ACCIDENTALS: Record<string, string> = {
	sharp: 's',
	diesis: 's',
	diese: 's',
	sostenido: 's',
	flat: 'b',
	bemolle: 'b',
	bemol: 'b'
};
const SOLFEGE_NOTES: Record<string, string> = {
	do: 'c',
	ut: 'c',
	re: 'd',
	mi: 'e',
	fa: 'f',
	sol: 'g',
	la: 'a',
	si: 'b'
};
// German note names carry their accidental ("Fis"), and b/h differ from the
// English letters: German B is B flat, H is B natural.
const GERMAN_NOTES: Record<string, string> = {
	c: 'c',
	d: 'd',
	e: 'e',
	f: 'f',
	g: 'g',
	a: 'a',
	h: 'b',
	b: 'bb',
	ces: 'cb',
	cis: 'cs',
	des: 'db',
	dis: 'ds',
	es: 'eb',
	fis: 'fs',
	ges: 'gb',
	gis: 'gs',
	as: 'ab',
	ais: 'as'
};
const MODE_WORDS = new Set([
	...Object.keys(KEY_MODES),
	...Object.keys(KEY_ACCIDENTALS),
	...Object.keys(SOLFEGE_NOTES),
	'ces',
	'cis',
	'des',
	'dis',
	'es',
	'fis',
	'ges',
	'gis',
	'as',
	'ais'
]);

// Match a key designation at tokens[i]: a note, an optional accidental word,
// and a mode word. The note is read per the mode word's language — German
// Dur/Moll uses the German note names, anything else a letter or solfège.
// Returns the normalised token and how many tokens the designation spans.
function matchKey(tokens: string[], i: number): { token: string; span: number } | null {
	for (const span of [3, 2]) {
		const modeWord = tokens[i + span - 1] ?? '';
		const mode = KEY_MODES[modeWord];
		if (!mode) continue;
		const accidental = span === 3 ? KEY_ACCIDENTALS[tokens[i + 1]] : '';
		if (span === 3 && !accidental) continue;
		const note =
			modeWord === 'dur' || modeWord === 'moll'
				? GERMAN_NOTES[tokens[i]]
				: (SOLFEGE_NOTES[tokens[i]] ?? (/^[a-g]$/.test(tokens[i]) ? tokens[i] : undefined));
		if (!note) continue;
		return { token: `${note}${accidental}-${mode}`, span };
	}
	return null;
}

// Catalogue labels (e.g. "Op. 125", "BWV 1043"): the label and its number are
// both dropped, since they don't help recognise the piece by name.
const CATALOGUE_WITH_NUMBER = new Set([
	'op',
	'opus',
	'k',
	'kv',
	'bwv',
	'woo',
	'hob',
	'rv',
	'd',
	's',
	'l',
	'wq',
	'hwv',
	'twv'
]);
// Labels whose following number names the piece (Symphony No. 9): drop the
// label, keep the number.
const CATALOGUE_KEEP_NUMBER = new Set(['no', 'nr', 'num', 'number', 'nummer', 'numero']);

// Derive a short, slug-safe handle from a piece title: lowercase and strip
// diacritics, normalise key designations, drop stop words and catalogue noise,
// then keep the first few distinctive words (a normalised key counts as one).
// Falls back to the raw words if everything was dropped.
export function makeHandle(name: string): string {
	const tokens = name
		.replace(/[äÄ]/g, 'ae')
		.replace(/[öÖ]/g, 'oe')
		.replace(/[üÜ]/g, 'ue')
		.replace(/ß/g, 'ss')
		.normalize('NFKD')
		.replace(/\p{Diacritic}/gu, '')
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);

	const kept: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		const key = matchKey(tokens, i);
		if (key) {
			kept.push(key.token);
			i += key.span - 1;
			continue;
		}
		if (CATALOGUE_WITH_NUMBER.has(t)) {
			if (/^\d+$/.test(tokens[i + 1] ?? '')) i++; // drop the catalogue number too
			continue;
		}
		if (CATALOGUE_KEEP_NUMBER.has(t)) continue; // drop the label, keep its number
		if (STOP_WORDS.has(t) || MODE_WORDS.has(t)) continue;
		if (t.length === 1 && !/\d/.test(t)) continue; // lone letters (key names, initials)
		kept.push(t);
	}

	const words = (kept.length ? kept : tokens).slice(0, 4);
	return words.join('-').slice(0, 40).replace(/-+$/, '');
}
