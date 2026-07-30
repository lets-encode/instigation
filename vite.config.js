import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	optimizeDeps: {
		exclude: ['verovio/wasm', 'verovio/esm']
	},
	server: {
		// Mount the session broker under the SPA's own origin, mirroring the
		// production nginx /auth/ block — its session cookie must be
		// first-party. Run it with:  flask --app app run --port 8787  (in broker/)
		proxy: {
			'/auth': {
				target: 'http://127.0.0.1:8787',
				rewrite: (path) => path.replace(/^\/auth/, '')
			},
			// The slug registry is part of the broker, as a blueprint mounted at
			// /registry (see broker/registry.py), so the path passes through
			// unchanged to the same server.
			'/registry': {
				target: 'http://127.0.0.1:8787'
			}
		}
	}
});
