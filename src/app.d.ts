// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
	namespace App {
		interface Locals {
			token?: string;
			scope?: string;
			user?: { login: string; name: string | null; avatar_url: string };
		}
	}
}

export {};
