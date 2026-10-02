import { redirect } from "@sveltejs/kit";
import type { LayoutLoad } from "./$types";

// Campaign names are lowercase (broker/slug_validation.py), so a name with
// capitals addresses the campaign of the lowercased name.
export const load: LayoutLoad = ({ params, url }) => {
  const name = params.campaign.toLowerCase();
  if (name !== params.campaign)
    redirect(
      308,
      url.pathname.replace(/^\/[^/]*/, `/${encodeURIComponent(name)}`) +
        url.search,
    );
};
