import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SyntaxValidator } from 'fast-xml-validator';
import { recordContribution } from '../mei-provenance.ts';
import { buildPieceHead, emptySourceMetadata } from '../source-metadata.ts';

const CONTRIBUTION = {
	name: 'octocat',
	message: 'Encode page 3.',
	isodate: '2026-08-10',
	application: 'mei-friend'
};

/** A score carrying a freshly generated piece header. */
function pieceScore(): string {
	const head = buildPieceHead({ title: 'Sonata I', composer: 'L. van Beethoven' }, emptySourceMetadata(), {
		creator: 'owner',
		date: '2026-08-09'
	});
	return `<mei>\n${head}\n   <music/>\n</mei>`;
}

test('records the change, the contributor and the application', () => {
	const out = recordContribution(pieceScore(), CONTRIBUTION);
	assert.equal(SyntaxValidator.validate(out), true);
	assert.match(out, /<change n="2" isodate="2026-08-10">[\s\S]*?<persName>octocat<\/persName>[\s\S]*?<p>Encode page 3\.<\/p>/);
	assert.match(out, /<persName role="contributor">octocat<\/persName>/);
	assert.match(out, /<application xml:id="app-mei-friend">\s*<name>mei-friend<\/name>/);
});

test('numbers changes after the existing ones', () => {
	const twice = recordContribution(recordContribution(pieceScore(), CONTRIBUTION), {
		...CONTRIBUTION,
		name: 'hubot',
		message: 'Fix slurs.'
	});
	assert.match(twice, /<change n="3"[\s\S]*?<persName>hubot<\/persName>/);
});

test('adds a contributor and an application only once', () => {
	const twice = recordContribution(recordContribution(pieceScore(), CONTRIBUTION), CONTRIBUTION);
	assert.equal((twice.match(/role="contributor"/g) ?? []).length, 1);
	assert.equal((twice.match(/<name>mei-friend<\/name>/g) ?? []).length, 1);
});

test('a contributor already named in the title statement is not repeated', () => {
	const out = recordContribution(pieceScore(), { ...CONTRIBUTION, name: 'L. van Beethoven' });
	assert.ok(!out.includes('role="contributor"'));
	assert.match(out, /<change n="2"/);
});

test('creates respStmt, encodingDesc and revisionDesc when the header lacks them', () => {
	const bare =
		'<mei>\n' +
		'   <meiHead>\n' +
		'      <fileDesc>\n' +
		'         <titleStmt>\n            <title>Bare</title>\n         </titleStmt>\n' +
		'         <pubStmt>\n         </pubStmt>\n' +
		'      </fileDesc>\n' +
		'   </meiHead>\n' +
		'   <music/>\n' +
		'</mei>';
	const out = recordContribution(bare, CONTRIBUTION);
	assert.equal(SyntaxValidator.validate(out), true);
	assert.match(out, /<respStmt>\s*<persName role="contributor">octocat<\/persName>\s*<\/respStmt>/);
	assert.match(out, /<encodingDesc>\s*<appInfo>[\s\S]*?mei-friend/);
	assert.match(out, /<revisionDesc>\s*<change n="1"/);
	// New blocks land at their place among <meiHead>'s children.
	assert.ok(out.indexOf('</fileDesc>') < out.indexOf('<encodingDesc>'));
	assert.ok(out.indexOf('<encodingDesc>') < out.indexOf('<revisionDesc>'));
	assert.ok(out.indexOf('</revisionDesc>') < out.indexOf('</meiHead>'));
});

test('keeps only the first line of a multi-line message', () => {
	const out = recordContribution(pieceScore(), {
		...CONTRIBUTION,
		message: 'Encode page 3.\n\nDetails nobody needs in the header.'
	});
	assert.match(out, /<p>Encode page 3\.<\/p>/);
	assert.ok(!out.includes('Details nobody needs'));
});

test('escapes markup-significant characters from the contribution', () => {
	const out = recordContribution(pieceScore(), {
		...CONTRIBUTION,
		name: 'a<b>&c',
		message: 'Ties & <slurs>'
	});
	assert.equal(SyntaxValidator.validate(out), true);
	assert.match(out, /<p>Ties &amp; &lt;slurs&gt;<\/p>/);
});

test('a name carrying replacement-string patterns is inserted literally', () => {
	// "$'" and "$&" are special in String.replace replacement text; a name
	// carrying them must not splice header text into itself.
	const out = recordContribution(pieceScore(), { ...CONTRIBUTION, name: "$' $& o'brien" });
	assert.equal(SyntaxValidator.validate(out), true);
	assert.match(out, /<persName role="contributor">\$' \$&amp; o'brien<\/persName>/);
	// The header still holds exactly one titleStmt: nothing was duplicated.
	assert.equal((out.match(/<titleStmt\b/g) ?? []).length, 1);
});

test('an application name carrying replacement-string patterns is inserted literally', () => {
	// A header without <encodingDesc> takes the replace-based insertion path.
	const bare =
		'<mei>\n   <meiHead>\n      <fileDesc>\n         <titleStmt>\n            <title>Bare</title>\n' +
		'         </titleStmt>\n         <pubStmt>\n         </pubStmt>\n      </fileDesc>\n   </meiHead>\n   <music/>\n</mei>';
	const out = recordContribution(bare, { ...CONTRIBUTION, application: "ed$'tor" });
	assert.equal(SyntaxValidator.validate(out), true);
	assert.match(out, /<name>ed\$'tor<\/name>/);
	assert.equal((out.match(/<fileDesc\b/g) ?? []).length, 1);
});

test('returns a score with no header unchanged', () => {
	assert.equal(recordContribution('<mei><music/></mei>', CONTRIBUTION), '<mei><music/></mei>');
});

test('omits the application when none is given', () => {
	const out = recordContribution(pieceScore(), { ...CONTRIBUTION, application: undefined });
	assert.ok(!out.includes('mei-friend'));
	assert.match(out, /<change n="2"/);
});
