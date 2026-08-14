// Shared string helpers for the MEI modules. Pure string handling, no DOM,
// filesystem or network access.

/**
 * Escape the minimum needed to keep substituted values well-formed XML, in
 * text and double-quoted attribute contexts.
 */
export function xmlEscape(value: unknown): string {
	return String(value ?? '')
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

/** Unescape the five predefined XML entities. `&amp;` last, so it never doubles. */
export function xmlUnescape(value: string): string {
	return value
		.replaceAll('&lt;', '<')
		.replaceAll('&gt;', '>')
		.replaceAll('&quot;', '"')
		.replaceAll('&apos;', "'")
		.replaceAll('&amp;', '&');
}

/** An element's readable text: nested tags stripped, whitespace collapsed. */
export const textOf = (inner: string): string =>
	xmlUnescape(
		inner
			.replace(/<[^>]*>/g, ' ')
			.replace(/\s+/g, ' ')
			.trim()
	);

/** Indentation at `depth` levels of three spaces. */
export const indent = (depth: number): string => ' '.repeat(depth * 3);

/** Escape a value so a RegExp built from it matches it literally. */
export function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
