import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMeiHeader } from '../mei-header.ts';
import { buildMeiHead } from '../mei-facsimile.ts';

test('parses the header buildMeiHead emits', () => {
	const mei = `<mei>\n${buildMeiHead({ title: 'Sonata & Co', composer: 'C. P. E. Bach', license: 'CC-BY-4.0' })}\n</mei>`;
	assert.deepEqual(parseMeiHeader(mei), {
		title: 'Sonata & Co',
		composer: 'C. P. E. Bach',
		contributors: []
	});
});

test('collects non-composer people with their roles, deduplicated', () => {
	const mei = `<mei><meiHead>
		<titleStmt>
			<title>Trio</title>
			<respStmt>
				<persName role="composer">A. Composer</persName>
				<persName role="encoder">B. Encoder</persName>
				<persName role="encoder">B. Encoder</persName>
				<persName>C. Anonymous</persName>
			</respStmt>
		</titleStmt>
	</meiHead></mei>`;
	assert.deepEqual(parseMeiHeader(mei), {
		title: 'Trio',
		composer: 'A. Composer',
		contributors: [
			{ name: 'B. Encoder', role: 'encoder' },
			{ name: 'C. Anonymous', role: '' }
		]
	});
});

test('returns null without a header and empty fields for a bare header', () => {
	assert.equal(parseMeiHeader('<mei><music/></mei>'), null);
	assert.deepEqual(parseMeiHeader('<mei><meiHead></meiHead></mei>'), {
		title: '',
		composer: '',
		contributors: []
	});
});
