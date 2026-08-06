// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
	namespace App {
		// Static SPA: no server request context, so no App.Locals.
	}
	/** Build date for the footer, injected by Vite's define. */
	const __BUILD_DATE__: string;
}

export {};
