// Expose the current user to every page/layout.
export function load({ locals }) {
	return { user: locals.user ?? null };
}
