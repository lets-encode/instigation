import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMeiHeader } from '../mei-header.ts';
import { recordContribution } from '../mei-provenance.ts';
import { buildPieceHead, emptySourceMetadata } from '../source-metadata.ts';

test('parses the header buildPieceHead emits', () => {
	const head = buildPieceHead(
		{ title: 'Sonata & Co', composer: 'C. P. E. Bach' },
		emptySourceMetadata(),
		{ date: '2026-08-14' }
	);
	assert.deepEqual(parseMeiHeader(`<mei>\n${head}\n</mei>`), {
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

test('a person named in several places appears once, with their most specific role', () => {
	// As a real header has it: the composer relisted in the manifestation, a
	// contributor in both the title statement and a revisionDesc change (where
	// the persName carries no role).
	const mei = `<mei><meiHead>
		<fileDesc>
			<titleStmt>
				<title>Trio</title>
				<respStmt>
					<persName role="composer">A. Composer</persName>
					<persName role="contributor">octocat</persName>
				</respStmt>
			</titleStmt>
		</fileDesc>
		<manifestationList>
			<manifestation>
				<titleStmt>
					<respStmt><persName role="composer">A. Composer</persName></respStmt>
				</titleStmt>
			</manifestation>
		</manifestationList>
		<revisionDesc>
			<change n="2"><respStmt><persName>octocat</persName></respStmt></change>
		</revisionDesc>
	</meiHead></mei>`;
	assert.deepEqual(parseMeiHeader(mei), {
		title: 'Trio',
		composer: 'A. Composer',
		contributors: [{ name: 'octocat', role: 'contributor' }]
	});
});

test('an accepted contribution shows each person once', () => {
	// The real pipeline: a piece header written at campaign creation, then two
	// contributions accepted by the coordinator.
	const head = buildPieceHead(
		{ title: 'Sonata I', composer: 'L. van Beethoven', editor: 'E. Editor' },
		{ ...emptySourceMetadata(), composer: 'L. van Beethoven', editor: 'E. Editor' },
		{ creator: 'owner', date: '2026-08-09' }
	);
	let mei = `<mei>\n${head}\n   <music/>\n</mei>`;
	for (const name of ['octocat', 'hubot']) {
		mei = recordContribution(mei, {
			name,
			message: 'Encode a page.',
			isodate: '2026-08-10',
			application: 'mei-friend'
		});
	}
	const parsed = parseMeiHeader(mei);
	assert.ok(parsed);
	assert.equal(parsed.composer, 'L. van Beethoven');
	// One row per person: the editor (manifestation copy deduplicated), each
	// contributor once despite their revisionDesc entries, and the creator.
	assert.deepEqual(parsed.contributors, [
		{ name: 'E. Editor', role: 'editor' },
		{ name: 'octocat', role: 'contributor' },
		{ name: 'hubot', role: 'contributor' },
		{ name: 'owner', role: '' }
	]);
});

test('returns null without a header and empty fields for a bare header', () => {
	assert.equal(parseMeiHeader('<mei><music/></mei>'), null);
	assert.deepEqual(parseMeiHeader('<mei><meiHead></meiHead></mei>'), {
		title: '',
		composer: '',
		contributors: []
	});
});
