import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// The project website's index.html (static/) answers "/" on the dev server,
// as mod_dir's DirectoryIndex does deployed. Vite serves the other static/
// files at the root itself; only the directory index needs this. Registered
// before Vite's own middleware, so the SPA router never sees "/".
const serveWebsiteIndex = () => ({
	name: 'serve-website-index',
	configureServer(server) {
		server.middlewares.use(async (req, res, next) => {
			if (new URL(req.url, 'http://x').pathname !== '/') return next();
			res.setHeader('Content-Type', 'text/html');
			res.end(await readFile(join(import.meta.dirname, 'static', 'index.html')));
		});
	}
});

export default defineConfig(({ mode }) => {
	// svelte.config.js loads the PUBLIC_ env itself but has no access to Vite's
	// mode; pass it through so both read the same .env files.
	process.env.VITE_CONFIG_MODE = mode;
	return {
		plugins: [serveWebsiteIndex(), sveltekit()],
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
				ignored: ['**/website/**']
			},
			// The browser-side MEI check (src/lib/mei-check.ts) imports the
			// vendored libxml2-wasm from scripts/, outside the directories the
			// dev server serves by default.
			fs: {
				allow: ['scripts/vendor']
			},
			// Mount the session broker under the SPA's own origin, mirroring the
			// deployed reverse proxy's /auth/ mount (README §6) — its session cookie
			// must be first-party. Run it with:  flask --app app run --port 7777  (in broker/)
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
