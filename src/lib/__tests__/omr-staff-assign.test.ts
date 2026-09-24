import { test } from 'node:test';
import assert from 'node:assert/strict';

import { labelScore, suggestStaffAssignment } from '../omr-staff-assign.ts';

// Staff boxes 30 high, top to bottom, with the given gaps between them.
function boxes(gaps: number[]) {
	let y = 0;
	return [0, ...gaps].map((gap) => {
		y += gap;
		const box = { ulx: 0, uly: y, lrx: 900, lry: y + 30 };
		y += 30;
		return box;
	});
}
// A system's staves with the given clefs and labels.
const printed = (gaps: number[], clefs: (string | null)[], labels: string[] = []) =>
	boxes(gaps).map((box, i) => ({ box, clef: clefs[i], label: labels[i] ?? '' }));
const parts = (clefs: string[], labels: string[] = []) => clefs.map((clef, i) => ({ clef, label: labels[i] ?? '' }));

test('a full or overfull system keeps its order; extra bottom staves get none', () => {
	assert.deepEqual(suggestStaffAssignment(printed([30], ['G2', 'F4']), parts(['G2', 'F4'])), [1, 2]);
	assert.deepEqual(suggestStaffAssignment(printed([30, 30], ['G2', 'F4', 'F4']), parts(['G2', 'F4'])), [1, 2, 0]);
});

test('clefs place a short system; on a tie the earlier staves win', () => {
	// A piano introduction (G, F) under a voice + piano definition (G, G, F).
	assert.deepEqual(suggestStaffAssignment(printed([30], ['G2', 'F4']), parts(['G2', 'G2', 'F4'])), [1, 3]);
	assert.deepEqual(suggestStaffAssignment(printed([30], ['C3', 'F4']), parts(['C3', 'G2', 'F4'])), [1, 3]);
	assert.deepEqual(suggestStaffAssignment(printed([30], [null, null]), parts(['G2', 'G2', 'G2'])), [1, 2]);
});

test("a wide gap lands on the reference system's group boundary", () => {
	// Winds G, G, G then a wide gap, then strings G, G. The short system shows
	// one wind staff and two strings: the clefs tie, the gap decides.
	const definition = parts(['G2', 'G2', 'G2', 'G2', 'G2']);
	const reference = boxes([30, 30, 90, 30]);
	assert.deepEqual(suggestStaffAssignment(printed([90, 30], Array(3).fill('G2')), definition, reference), [1, 4, 5]);
	assert.deepEqual(suggestStaffAssignment(printed([30, 90], Array(3).fill('G2')), definition, reference), [1, 2, 4]);
});

test('printed labels decide between staves with the same clef', () => {
	const definition = parts(['G2', 'G2', 'G2', 'G2'], ['Flöte I', 'Flöte II', 'Oboe I, II', 'Violine I']);
	// Fl. I, Ob. I: the clefs and gaps would give Flöte I and II.
	assert.deepEqual(suggestStaffAssignment(printed([30], ['G2', 'G2']), definition), [1, 2]);
	assert.deepEqual(suggestStaffAssignment(printed([30], ['G2', 'G2'], ['Fl. I', 'Ob. I']), definition), [1, 3]);
	// Numerals choose between Flöte I and II.
	assert.deepEqual(suggestStaffAssignment(printed([], ['G2'], ['Fl. II']), definition), [2]);
});

test('label readings: abbreviations, OCR misreadings and numerals', () => {
	const labels = ['Flöte I', 'Flöte II', 'Oboe I, II', 'Violine I', 'Violine II', 'Violoncello', 'Kontrabass'];
	const best = (read: string) => {
		const scores = labels.map((label) => labelScore(read, label, labels));
		const top = Math.max(...scores);
		return top > 0 ? labels.filter((_, i) => scores[i] === top) : [];
	};
	assert.deepEqual(best('F1.I'), ['Flöte I']);
	assert.deepEqual(best('Fl. II'), ['Flöte II']);
	assert.deepEqual(best('Ob.I'), ['Oboe I, II']);
	assert.deepEqual(best('Viol.l'), ['Violine I']);
	assert.deepEqual(best('Violl'), ['Violine I']);
	assert.deepEqual(best('VioLII'), ['Violine II']);
	assert.deepEqual(best('Vell.'), ['Violoncello']);
	assert.deepEqual(best('K.-B.'), ['Kontrabass']);
	assert.deepEqual(best('Vell. u. K-B.'), ['Violoncello', 'Kontrabass']);
	assert.deepEqual(best('Viol.Il'), ['Violine II']);
	assert.deepEqual(best('Allegro'), []);
});

test('a label may name the instrument in another language', () => {
	const labels = ['Violine I', 'Viola', 'Violoncello', 'Kontrabass', 'Posaune I, II'];
	assert.equal(labelScore('Br.', 'Viola', labels), 2);
	assert.equal(labelScore('Br.', 'Violoncello', labels), 0);
	assert.equal(labelScore('Trb.', 'Posaune I, II', labels), 2);
	assert.equal(labelScore('Cb.', 'Kontrabass', labels), 2);
	// A trailing l of an abbreviation that stands as it is stays a letter.
	assert.equal(labelScore('Viol.', 'Violine I', labels), 2);
});
