import type { ForgeClient } from './forge/types.ts';

/** Resolve a relative MEI graphic target to its repository path. */
export function resolveRepoRelativeTarget(fragment: string, target: string): string | null {
	if (!target || target.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) {
		return null;
	}
	const parts = [...fragment.split('/').slice(0, -1), ...target.split('/')];
	const resolved: string[] = [];
	for (const part of parts) {
		if (!part || part === '.') continue;
		if (part === '..') {
			if (!resolved.length) return null;
			resolved.pop();
		} else {
			resolved.push(part);
		}
	}
	return resolved.join('/') || null;
}

/** Resolve MEI graphic targets and fetch their download URLs per directory, in parallel. */
export async function resolveFacsimileImageUrls(
	forge: Pick<ForgeClient, 'getDirDownloadUrls'>,
	owner: string,
	repo: string,
	fragment: string,
	targets: string[],
	ref?: string
): Promise<string[]> {
	const paths = targets.map((target) => resolveRepoRelativeTarget(fragment, target));
	const directories = [...new Set(paths.filter((path): path is string => path !== null).map(dirname))];
	const listings = new Map(
		await Promise.all(
			directories.map(
				async (directory) =>
					[directory, await forge.getDirDownloadUrls(owner, repo, directory, ref)] as const
			)
		)
	);
	return paths.map((path) => {
		if (!path) return '';
		return listings.get(dirname(path))?.[basename(path)] ?? '';
	});
}

function dirname(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash < 0 ? '' : path.slice(0, slash);
}

function basename(path: string): string {
	const slash = path.lastIndexOf('/');
	return path.slice(slash + 1);
}
