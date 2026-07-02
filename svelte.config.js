import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { loadEnv } from 'vite';

// The CSP must allow fetches to the token broker, whose URL is deployment
// config — read it from the same env files Vite gives the app.
const env = loadEnv(process.env.NODE_ENV ?? 'production', process.cwd(), 'PUBLIC_');
const brokerOrigin = env.PUBLIC_OAUTH_BROKER_URL ? new URL(env.PUBLIC_OAUTH_BROKER_URL).origin : '';
const dev = process.env.NODE_ENV === 'development';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		// Static SPA: all routes are client-rendered and served via the fallback,
		// so the dynamic /campaign/[owner]/[repo] route resolves without a server.
		adapter: adapter({ fallback: 'index.html' }),
		// Strict CSP: the forge token lives in sessionStorage, so it is reachable
		// from any script that runs on the page — allow only our own scripts and
		// the exact hosts the app talks to. `hash` mode works on static pages
		// (nonces need a server). `ws:` is for Vite's dev-server HMR socket only.
		csp: {
			mode: 'hash',
			directives: {
				'default-src': ['self'],
				'script-src': ['self'],
				'style-src': ['self', 'unsafe-inline'],
				'img-src': ['self', 'https://avatars.githubusercontent.com'],
				'connect-src': [
					'self',
					'https://api.github.com',
					...(brokerOrigin ? [brokerOrigin] : []),
					...(dev ? ['ws:'] : [])
				],
				'base-uri': ['self'],
				'object-src': ['none']
			}
		}
	}
};

export default config;
