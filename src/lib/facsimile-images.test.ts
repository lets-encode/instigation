import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveFacsimileImageUrls, resolveRepoRelativeTarget } from './facsimile-images.ts';

test('graphic targets resolve relative to the MEI fragment', () => {
	assert.equal(resolveRepoRelativeTarget('sources/score.mei', 'img/page-001.jpg'), 'sources/img/page-001.jpg');
	assert.equal(resolveRepoRelativeTarget('scores/work/score.mei', '../img/page.jpg'), 'scores/img/page.jpg');
	assert.equal(resolveRepoRelativeTarget('sources/score.mei', '../../outside.jpg'), null);
	assert.equal(resolveRepoRelativeTarget('sources/score.mei', 'https://example.org/page.jpg'), null);
});

test('facsimile URLs are read from the targets actual nested directories', async () => {
	const requested: string[] = [];
	const forge = {
		async getDirDownloadUrls(_owner: string, _repo: string, directory: string) {
			requested.push(directory);
			if (directory === 'sources/img') {
				return { 'page-001.jpg': 'https://raw.example/1', 'page-002.jpg': 'https://raw.example/2' };
			}
			return {};
		}
	};
	const urls = await resolveFacsimileImageUrls(
		forge,
		'owner',
		'repo',
		'sources/score.mei',
		['img/page-001.jpg', 'img/page-002.jpg']
	);
	assert.deepEqual(requested, ['sources/img']);
	assert.deepEqual(urls, ['https://raw.example/1', 'https://raw.example/2']);
});
