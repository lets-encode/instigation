import { test } from 'node:test';
import assert from 'node:assert/strict';

import { appendEnvelopeToPrBody, envelopeFromPrBody, envelopeColumns } from './command-envelope.js';
import type { CommandEnvelope } from './command-envelope.js';

const ENVELOPE: CommandEnvelope = {
	command: 'campaign.claimValidation',
	version: 1,
	user_id: 'alice',
	timestamp: '2026-07-13T10:00:00Z',
	input: { task_id: 'T0001', subtask_id: 'S0001' }
};

test('envelope: round-trips through a PR body', () => {
	const body = appendEnvelopeToPrBody('Reserves T0001/S0001 for validation.', ENVELOPE);
	assert.match(body, /^Reserves T0001\/S0001 for validation\./);
	assert.deepEqual(envelopeFromPrBody(body), ENVELOPE);
});

test('envelopeFromPrBody: null on bodies without an envelope', () => {
	assert.equal(envelopeFromPrBody('A hand-written PR body.'), null);
	assert.equal(envelopeFromPrBody(''), null);
	assert.equal(envelopeFromPrBody(null), null);
});

test('envelopeFromPrBody: null on a malformed envelope', () => {
	assert.equal(envelopeFromPrBody('<!-- lets-encode:command {not json} -->'), null);
	assert.equal(envelopeFromPrBody('<!-- lets-encode:command {"input":{}} -->'), null);
});

test('envelopeFromPrBody: rejects invalid envelope fields', () => {
	const body = (envelope: unknown) => `<!-- lets-encode:command ${JSON.stringify(envelope)} -->`;
	assert.equal(envelopeFromPrBody(body({ ...ENVELOPE, command: '' })), null);
	assert.equal(envelopeFromPrBody(body({ ...ENVELOPE, version: 0 })), null);
	assert.equal(envelopeFromPrBody(body({ ...ENVELOPE, version: 1.5 })), null);
	assert.equal(envelopeFromPrBody(body({ ...ENVELOPE, user_id: '' })), null);
	assert.equal(envelopeFromPrBody(body({ ...ENVELOPE, timestamp: 'not-a-date' })), null);
	assert.equal(envelopeFromPrBody(body({ ...ENVELOPE, input: [] })), null);
});

test('envelopeColumns: the command columns for a history row, empty without an envelope', () => {
	assert.deepEqual(envelopeColumns(ENVELOPE), {
		command: 'campaign.claimValidation',
		version: '1',
		input: '{"task_id":"T0001","subtask_id":"S0001"}'
	});
	assert.deepEqual(envelopeColumns(null), { command: '', version: '', input: '' });
});
