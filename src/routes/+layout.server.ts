import type { LayoutServerLoad } from './$types';

// Expose the current user to every page/layout.
export const load: LayoutServerLoad = ({ locals }) => {
	return { user: locals.user ?? null };
};
