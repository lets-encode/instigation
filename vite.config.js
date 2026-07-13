import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	optimizeDeps: {
		exclude: ['verovio/wasm', 'verovio/esm']
	},
	server: {
		// Mount the OAuth session broker under the SPA's own origin, mirroring
		// the production nginx /oauth/ block — its session cookie must be
		// first-party. Run it with:  flask --app app run --port 8787  (in broker/)
		proxy: {
			'/oauth': {
				target: 'http://127.0.0.1:8787',
				rewrite: (path) => path.replace(/^\/oauth/, '')
			}
		}
	}
});
