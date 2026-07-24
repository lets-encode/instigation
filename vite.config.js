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
			// Mount the slug registry (redirector) under the SPA's own origin, the
			// same way, so its calls need no CORS. Run it with:
			//   uvicorn app.asgi:app --port 8000  (in redirector/)
			'/registry': {
				target: 'http://127.0.0.1:8000',
				rewrite: (path) => path.replace(/^\/registry/, '')
			}
		}
	}
});
