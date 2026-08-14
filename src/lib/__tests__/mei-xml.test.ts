import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeRegex, indent, textOf, xmlEscape, xmlUnescape } from '../mei-xml.ts';

test('xmlEscape covers text and double-quoted attribute contexts', () => {
	assert.equal(xmlEscape('a & <b> "c"'), 'a &amp; &lt;b&gt; &quot;c&quot;');
	assert.equal(xmlEscape(null), '');
	assert.equal(xmlEscape(42), '42');
});

test('xmlUnescape covers all five predefined entities', () => {
	assert.equal(xmlUnescape('&lt;a&gt; &amp; &quot;b&quot; &apos;c&apos;'), `<a> & "b" 'c'`);
});

test("&apos; round-trips: unescape then escape emits a plain apostrophe, not &amp;apos;", () => {
	const unescaped = xmlUnescape('d&apos;un');
	assert.equal(unescaped, "d'un");
	assert.equal(xmlEscape(unescaped), "d'un");
});

test('escape and unescape are inverse over markup-significant text', () => {
	const value = `<x a="1">&'"</x>`;
	assert.equal(xmlUnescape(xmlEscape(value)), value);
	// Already-escaped entities survive the round trip undoubled.
	assert.equal(xmlEscape(xmlUnescape('&amp;lt;')), '&amp;lt;');
});

test('textOf strips tags, collapses whitespace and unescapes', () => {
	assert.equal(textOf('  J. <hi>S.</hi>\n  Bach &amp; Co  '), 'J. S. Bach & Co');
});

test('indent is three spaces per depth', () => {
	assert.equal(indent(0), '');
	assert.equal(indent(2), '      ');
});

test('escapeRegex makes a value match itself literally', () => {
	const value = 'a.b$c[d]';
	assert.ok(new RegExp(`^${escapeRegex(value)}$`).test(value));
});
