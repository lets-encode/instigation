import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

// Serve the project website (website/) on the dev server the way Apache serves
// it deployed: its index.html answers "/", its files are served as-is, and
// every other path falls through to the SPA. Registered before Vite's own
// middleware, so the SPA router never sees these paths — same order as the
// vhost's DocumentRoot lookup ahead of FallbackResource.
const websiteRoot = join(import.meta.dirname, 'website');
const websiteTypes = {
	'.html': 'text/html',
	'.css': 'text/css',
	'.js': 'text/javascript',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.pdf': 'application/pdf'
};
const serveWebsite = () => ({
	name: 'serve-website',
	configureServer(server) {
		server.middlewares.use(async (req, res, next) => {
			const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
			const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
			const file = normalize(join(websiteRoot, rel));
			if (!file.startsWith(websiteRoot + sep)) return next();
			let body;
			try {
				body = await readFile(file);
			} catch {
				return next(); // not a website file: the SPA's
			}
			res.setHeader('Content-Type', websiteTypes[extname(file)] ?? 'application/octet-stream');
			res.end(body);
		});
	}
});

export default defineConfig(({ mode }) => {
	// svelte.config.js loads the PUBLIC_ env itself but has no access to Vite's
	// mode; pass it through so both read the same .env files.
	process.env.VITE_CONFIG_MODE = mode;
	return {
		plugins: [serveWebsite(), sveltekit()],
		define: {
			// The footer's "app last updated" date, fixed at build time.
			__BUILD_DATE__: JSON.stringify(
				new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
			)
		},
		optimizeDeps: {
			exclude: ['verovio/wasm', 'verovio/esm']
		},
		server: {
			// The build output is not part of the served app; without this, a
			// `vite build` while the dev server runs force-reloads its clients.
			watch: {
				ignored: ['**/build/**']
			},
			// Mount the session broker under the SPA's own origin, mirroring the
			// production Apache /auth/ ProxyPass (deploy/apache.conf) — its session cookie must be
			// first-party. Run it with:  flask --app app run --port 7777  (in broker/)
			proxy: {
				'/auth': {
					target: 'http://127.0.0.1:7777',
					rewrite: (path) => path.replace(/^\/auth/, '')
				},
				// The slug registry is part of the broker, as a blueprint mounted at
				// /registry (see broker/registry.py), so the path passes through
				// unchanged to the same server.
				'/registry': {
					target: 'http://127.0.0.1:7777'
				}
			}
		}
	};
});
