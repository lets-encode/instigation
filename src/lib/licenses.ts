// The licences a campaign may publish its encoding under.
//
// Each carries a short summary of what the choice allows, shown next to the
// dropdown so the implications are visible before the campaign is created —
// the licence binds every volunteer's contribution, and changing it later means
// asking all of them.

export interface LicenseOption {
	/** SPDX identifier, written into config.yaml and each piece's header. */
	id: string;
	name: string;
	url: string;
	/** What choosing this licence allows, in plain terms. */
	info: string;
}

export const LICENSES: LicenseOption[] = [
	{
		id: 'CC0-1.0',
		name: 'CC0 1.0 — Public domain',
		url: 'https://creativecommons.org/publicdomain/zero/1.0/',
		info: 'No rights reserved: anyone may copy, adapt and redistribute the encoding for any purpose, including commercially, without crediting anyone.'
	},
	{
		id: 'CC-BY-4.0',
		name: 'CC BY 4.0 — Attribution',
		url: 'https://creativecommons.org/licenses/by/4.0/',
		info: 'Anyone may share and adapt the encoding, including commercially, as long as they credit the campaign.'
	},
	{
		id: 'CC-BY-SA-4.0',
		name: 'CC BY-SA 4.0 — Attribution, ShareAlike',
		url: 'https://creativecommons.org/licenses/by-sa/4.0/',
		info: 'Like CC BY, but anything built on the encoding must be published under this same license.'
	},
	{
		id: 'CC-BY-NC-4.0',
		name: 'CC BY-NC 4.0 — Attribution, NonCommercial',
		url: 'https://creativecommons.org/licenses/by-nc/4.0/',
		info: 'Sharing and adapting with credit is allowed for non-commercial purposes only. Commercial reuse (e.g. in paid publications or apps) needs separate permission.'
	},
	{
		id: 'CC-BY-NC-SA-4.0',
		name: 'CC BY-NC-SA 4.0 — Attribution, NonCommercial, ShareAlike',
		url: 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
		info: 'Non-commercial use only, with credit, and anything built on the encoding must keep this same license.'
	}
];

/** The licence a campaign takes when the organiser makes no other choice. */
export const DEFAULT_LICENSE = 'CC-BY-4.0';

export const licenseById = (id: string): LicenseOption =>
	LICENSES.find((license) => license.id === id) ?? LICENSES[1];
