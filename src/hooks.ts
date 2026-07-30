import type { Reroute } from '@sveltejs/kit';

// The landing page hands a chosen campaign name off to /c?slug=<name>. There
// is no dedicated /c page: render the onboarding wizard for it, keeping the
// /c?slug= URL. The wizard's name step reads ?slug= and prefills the handle
// (see src/lib/components/CampaignNameStep.svelte).
export const reroute: Reroute = ({ url }) => {
	if (url.pathname === '/c') return '/';
};
