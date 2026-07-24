import type { Reroute } from '@sveltejs/kit';

// The slug registry (redirector) hands a chosen campaign name off to
// /c?slug=<name>. There is no dedicated /c page: render the home create page
// for it, keeping the /c?slug= URL. The home page reads ?slug= and opens its
// create form prefilled (see src/routes/+page.svelte).
export const reroute: Reroute = ({ url }) => {
	if (url.pathname === '/c') return '/';
};
