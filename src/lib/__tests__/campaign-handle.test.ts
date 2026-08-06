import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidHandle } from '../campaign-handle.ts';

test('accepts handles matching the registry slug rules', () => {
	assert.equal(isValidHandle('sym'), true);
	assert.equal(isValidHandle('symphony-9-choral'), true);
	assert.equal(isValidHandle('a1'), false); // under 3 characters
	assert.equal(isValidHandle('Symphony'), false); // uppercase
	assert.equal(isValidHandle('-leading'), false);
	assert.equal(isValidHandle('trailing-'), false);
	assert.equal(isValidHandle('double--hyphen'), false);
	assert.equal(isValidHandle('a'.repeat(41)), false);
});
