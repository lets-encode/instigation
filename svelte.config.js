import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { loadEnv } from 'vite';

// Hosts the app talks to are deployment config — read them from the same env
// files Vite gives the app. The OAuth session broker needs no CSP entry: it is
// mounted on the SPA's own origin, covered by 'self'.
const env = loadEnv(process.env.NODE_ENV ?? 'production', process.cwd(), 'PUBLIC_');
// The measure-detector the campaign scaffolder POSTs page images to.
const detectorOrigin = new URL(
	env.PUBLIC_MEASURE_DETECTOR_URL || 'https://measure-detector.edirom.de'
).origin;
const dev = process.env.NODE_ENV === 'development';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		// Static SPA: all routes are client-rendered and served via the fallback,
		// so the dynamic /campaign/[owner]/[repo] route resolves without a server.
		adapter: adapter({ fallback: 'index.html' }),
		// Strict CSP as defence in depth: the forge token lives server-side in
		// the broker session, but scripts on the page could still act through
		// the authenticated proxy — allow only our own scripts and the exact
		// hosts the app talks to. `hash` mode works on static pages (nonces
		// need a server). `ws:` is for Vite's dev-server HMR socket only.
		csp: {
			mode: 'hash',
			directives: {
				'default-src': ['self'],
				// 'wasm-unsafe-eval' permits compiling WebAssembly (the Verovio
				// score renderer) but not JS eval().
				'script-src': ['self', 'wasm-unsafe-eval'],
				'style-src': ['self', 'unsafe-inline'],
				// avatars: the signed-in user's avatar. raw.githubusercontent.com:
				// repo file contents by URL (the Contents API download_url) — the
				// page facsimiles the zone editor renders as a background, tokenised
				// for private repos.
				'img-src': [
					'self',
					'https://avatars.githubusercontent.com',
					'https://raw.githubusercontent.com'
				],
				'connect-src': [
					'self',
					'https://api.github.com',
					detectorOrigin,
					...(dev ? ['ws:'] : [])
				],
				'base-uri': ['self'],
				'object-src': ['none']
			}
		}
	}
};

export default config;
