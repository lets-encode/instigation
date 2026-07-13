// The command envelope: the machine-readable record of one console command
// invocation (which command, which version, what input). Commands whose
// mutation travels as a pull request embed the envelope in the PR body; the
// campaign automation extracts it and fills the command columns of the
// history.csv row it authors for the event. Pure functions: strings/objects
// in, strings out.

/** One command invocation, as embedded in a PR body or logged to history.csv. */
export interface CommandEnvelope {
	command: string;
	version: number;
	user_id: string;
	timestamp: string;
	input: Record<string, unknown>;
}

const MARKER = 'lets-encode:command';

/** Append the envelope to a PR body as an HTML comment (invisible on GitHub). */
export function appendEnvelopeToPrBody(body: string, envelope: CommandEnvelope): string {
	return `${body}\n\n<!-- ${MARKER} ${JSON.stringify(envelope)} -->`;
}

/** Extract the envelope from a PR body, or null if absent or malformed. */
export function envelopeFromPrBody(body: string | null): CommandEnvelope | null {
	const m = new RegExp(`<!--\\s*${MARKER}\\s+(\\{.*?\\})\\s*-->`, 's').exec(body ?? '');
	if (!m) return null;
	try {
		const parsed = JSON.parse(m[1]) as CommandEnvelope;
		if (typeof parsed.command !== 'string' || typeof parsed.input !== 'object' || parsed.input == null) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

/**
 * The command columns of a history.csv row: the envelope's command id,
 * version, and input as JSON — or all empty when the event carried no
 * envelope. Everything else on the row (user, time, outcome) is authored by
 * the writer, never taken from the envelope's client-supplied claims.
 */
export function envelopeColumns(
	envelope: CommandEnvelope | null
): { command: string; version: string; input: string } {
	if (!envelope) return { command: '', version: '', input: '' };
	return {
		command: envelope.command,
		version: String(envelope.version),
		input: JSON.stringify(envelope.input)
	};
}
