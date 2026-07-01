import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		// Static SPA: all routes are client-rendered and served via the fallback,
		// so the dynamic /campaign/[owner]/[repo] route resolves without a server.
		adapter: adapter({ fallback: 'index.html' })
	}
};

export default config;
