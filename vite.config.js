import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => {
	// svelte.config.js loads the PUBLIC_ env itself but has no access to Vite's
	// mode; pass it through so both read the same .env files.
	process.env.VITE_CONFIG_MODE = mode;
	return {
		plugins: [sveltekit()],
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
			// production nginx /auth/ proxy block (deploy/apache.conf) — its session cookie must be
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
