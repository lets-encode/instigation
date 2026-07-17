<script lang="ts">
	import { goto } from '$app/navigation';
	import { auth, login, forge } from '$lib/auth.svelte.ts';
	import { provider, automation, automationRefPinned, measureDetectorUrl } from '$lib/forge/config.ts';
	import { searchReposByTopic, repoExists } from '$lib/forge/github-rest.ts';
	import type { FileChange, RepoSummary } from '$lib/forge/types.ts';
	import {
		buildCampaignConfig,
		configToYaml,
		stampTemplate,
		buildTaskCsv,
		buildStateCsv,
		buildLockCsv,
		buildHistoryCsv
	} from '$lib/campaign-init.ts';
	import { initialFacsimileModel, buildFacsimileMei } from '$lib/mei-facsimile.ts';
	// Type-only: erased at build, so the heavy pdf.js module it lives in is loaded
	// (dynamically) only when a facsimile campaign is actually submitted.
	import type { PreparedFacsimile } from '$lib/facsimile-detect.ts';

	// The repository listing, fetched client-side (a logged-in token also surfaces
	// the user's private matches; anonymous sees public ones).
	let repos = $state<RepoSummary[]>([]);
	let listError = $state<string | null>(null);

	$effect(() => {
		if (auth.status === 'loading') return;
		const token = auth.token ?? undefined;
		searchReposByTopic(provider.repoTopic, token)
			.then((r) => {
				repos = r;
				listError = null;
			})
			.catch((e) => {
				listError = (e as Error).message;
				repos = [];
			});
	});

	// Create form state.
	let showForm = $state(false);
	let submitting = $state(false);
	let error = $state<string | null>(null);
	let created = $state<{ html_url: string; full_name: string; initWarning: boolean } | null>(null);
	let retryInitialisation = $state<(() => Promise<void>) | null>(null);

	async function retryCreatedCampaign() {
		if (!created || !retryInitialisation) return;
		submitting = true;
		error = null;
		try {
			await retryInitialisation();
			const [owner, repo] = created.full_name.split('/');
			await goto(`/campaign/${owner}/${repo}`);
		} catch (err) {
			error = `Campaign initialisation still failed: ${(err as Error).message}`;
			submitting = false;
		}
	}

	// Score source: scaffold from uploaded page images/PDF (measure detection),
	// start from a blank template, or an existing MEI/MusicXML upload (that
	// option is disabled in the form).
	let sourceMode = $state<'facsimile' | 'blank' | 'existing'>('facsimile');
	let sourceFiles = $state<File[]>([]);
	let progress = $state<string | null>(null);
	let dragActive = $state(false);
	let dropNote = $state<string | null>(null);

	const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'application/pdf'];

	function onFilesChange(e: Event) {
		sourceFiles = Array.from((e.currentTarget as HTMLInputElement).files ?? []);
		dropNote = null;
	}

	function onDrop(e: DragEvent) {
		e.preventDefault();
		dragActive = false;
		const dropped = Array.from(e.dataTransfer?.files ?? []);
		const accepted = dropped.filter((f) => ACCEPTED_TYPES.includes(f.type));
		if (accepted.length === 0) {
			dropNote = 'Only JPG, PNG or PDF files are supported.';
			return;
		}
		sourceFiles = accepted;
		dropNote =
			accepted.length < dropped.length
				? `${dropped.length - accepted.length} file(s) skipped — only JPG, PNG or PDF are supported.`
				: null;
	}

	// Creative Commons license options. Each carries a short summary of what the
	// choice allows, shown next to the dropdown so the implications are visible
	// before the campaign is created.
	const LICENSES = [
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
		},
	];

	let visibility = $state('public');
	let title = $state('');
	let handle = $state('');
	let handleTouched = $state(false);
	let description = $state('');
	let license = $state('CC-BY-4.0');
	let composer = $state('');

	const selectedLicense = $derived(LICENSES.find((l) => l.id === license) ?? LICENSES[0]);

	$effect(() => {
		if (!handleTouched) handle = makeHandle(title);
	});

	// Live availability check for the handle: against the campaign repos already
	// fetched (public ones of every user, plus the user's own private matches),
	// and against the user's own account for any other repo of the same name.
	// Debounced; a sequence number discards results of superseded checks.
	let handleCheck = $state<
		| { state: 'idle' }
		| { state: 'invalid' }
		| { state: 'checking' }
		| { state: 'available' }
		| { state: 'taken'; by: string }
		| { state: 'unknown' }
	>({ state: 'idle' });
	let handleCheckSeq = 0;

	$effect(() => {
		const h = handle.trim();
		const user = auth.user;
		const token = auth.token ?? undefined;
		const campaignRepos = repos;
		const seq = ++handleCheckSeq;
		if (!h || !user) {
			handleCheck = { state: 'idle' };
			return;
		}
		if (!/^[A-Za-z0-9_-]+$/.test(h)) {
			handleCheck = { state: 'invalid' };
			return;
		}
		handleCheck = { state: 'checking' };
		const timer = setTimeout(async () => {
			const clash = campaignRepos.find((r) => r.name.toLowerCase() === h.toLowerCase());
			if (clash) {
				if (seq === handleCheckSeq) handleCheck = { state: 'taken', by: clash.full_name };
				return;
			}
			try {
				const exists = await repoExists(user.login, h, token);
				if (seq === handleCheckSeq) {
					handleCheck = exists ? { state: 'taken', by: `${user.login}/${h}` } : { state: 'available' };
				}
			} catch {
				if (seq === handleCheckSeq) handleCheck = { state: 'unknown' };
			}
		}, 400);
		return () => clearTimeout(timer);
	});

	// Generic words dropped when deriving a handle, so the distinctive words of a
	// title survive. Articles, prepositions and conjunctions in the languages
	// common to the music repertoire. Single letters (a, e, y, à…) need no entry —
	// the lone-letter rule below drops them. Words with diacritics are listed as
	// they arrive after transliteration (für → fuer, dièse → diese).
	const STOP_WORDS = new Set([
		// English
		'the', 'an', 'of', 'in', 'for', 'and', 'or', 'to', 'from', 'on', 'by', 'at', 'with',
		// German
		'der', 'die', 'das', 'dem', 'den', 'des', 'ein', 'eine', 'einem', 'einen', 'einer', 'eines',
		'und', 'oder', 'im', 'am', 'an', 'auf', 'aus', 'bei', 'mit', 'nach', 'von', 'vor', 'zu',
		'zum', 'zur', 'fuer', 'ueber', 'unter',
		// Italian
		'il', 'lo', 'gli', 'le', 'un', 'uno', 'una', 'di', 'da', 'su', 'con', 'per', 'tra', 'fra',
		'ed', 'ad', 'al', 'allo', 'alla', 'alle', 'agli', 'dal', 'dallo', 'dalla', 'dalle',
		'del', 'dello', 'della', 'delle', 'dei', 'degli', 'nel', 'nello', 'nella', 'nelle',
		'sul', 'sullo', 'sulla', 'sulle',
		// French
		'la', 'les', 'une', 'de', 'du', 'des', 'et', 'ou', 'au', 'aux', 'en',
		'sur', 'pour', 'dans', 'par', 'avec', 'sans',
		// Spanish
		'el', 'los', 'las', 'unos', 'unas', 'sin', 'sobre', 'para', 'por',
		// Latin
		'ad', 'ab', 'cum', 'ex', 'pro', 'sub', 'super'
	]);
	// Key designations ("Si bémol majeur", "c-Moll", "C sharp minor") are collapsed
	// into one normalised token — note letter, s/b for sharp/flat, English mode —
	// so the key survives in the handle as a uniform qualifier: bb-major, cs-minor.
	const KEY_MODES: Record<string, string> = {
		major: 'major', dur: 'major', maggiore: 'major', majeur: 'major', mayor: 'major',
		minor: 'minor', moll: 'minor', minore: 'minor', mineur: 'minor', menor: 'minor'
	};
	const KEY_ACCIDENTALS: Record<string, string> = {
		sharp: 's', diesis: 's', diese: 's', sostenido: 's',
		flat: 'b', bemolle: 'b', bemol: 'b'
	};
	const SOLFEGE_NOTES: Record<string, string> = {
		do: 'c', ut: 'c', re: 'd', mi: 'e', fa: 'f', sol: 'g', la: 'a', si: 'b'
	};
	// German note names carry their accidental ("Fis"), and b/h differ from the
	// English letters: German B is B flat, H is B natural.
	const GERMAN_NOTES: Record<string, string> = {
		c: 'c', d: 'd', e: 'e', f: 'f', g: 'g', a: 'a', h: 'b', b: 'bb',
		ces: 'cb', cis: 'cs', des: 'db', dis: 'ds', es: 'eb', fis: 'fs',
		ges: 'gb', gis: 'gs', as: 'ab', ais: 'as'
	};
	// Key vocabulary that appears outside a parsable key designation (a stray
	// "majeur" or "sol") is dropped rather than kept as a title word.
	const MODE_WORDS = new Set([
		...Object.keys(KEY_MODES),
		...Object.keys(KEY_ACCIDENTALS),
		...Object.keys(SOLFEGE_NOTES),
		'ces', 'cis', 'des', 'dis', 'es', 'fis', 'ges', 'gis', 'as', 'ais'
	]);

	// Match a key designation at tokens[i]: a note, an optional accidental word,
	// and a mode word. The note is read per the mode word's language — German
	// Dur/Moll uses the German note names, anything else a letter or solfège.
	// Returns the normalised token and how many tokens the designation spans.
	function matchKey(tokens: string[], i: number): { token: string; span: number } | null {
		for (const span of [3, 2]) {
			const modeWord = tokens[i + span - 1] ?? '';
			const mode = KEY_MODES[modeWord];
			if (!mode) continue;
			const accidental = span === 3 ? KEY_ACCIDENTALS[tokens[i + 1]] : '';
			if (span === 3 && !accidental) continue;
			const note =
				modeWord === 'dur' || modeWord === 'moll'
					? GERMAN_NOTES[tokens[i]]
					: (SOLFEGE_NOTES[tokens[i]] ?? (/^[a-g]$/.test(tokens[i]) ? tokens[i] : undefined));
			if (!note) continue;
			return { token: `${note}${accidental}-${mode}`, span };
		}
		return null;
	}
	// Catalogue labels (e.g. "Op. 125", "BWV 1043"): the label and its number are
	// both dropped, since they don't help recognise the piece by name.
	const CATALOGUE_WITH_NUMBER = new Set(['op', 'opus', 'k', 'kv', 'bwv', 'woo', 'hob', 'rv', 'd', 's', 'l', 'wq', 'hwv', 'twv']);
	// Labels whose following number names the piece (Symphony No. 9): drop the
	// label, keep the number.
	const CATALOGUE_KEEP_NUMBER = new Set(['no', 'nr', 'num', 'number', 'nummer', 'numero']);

	// Derive a short, slug-safe handle from a piece title: lowercase and strip
	// diacritics, normalise key designations, drop stop words and catalogue noise,
	// then keep the first few distinctive words (a normalised key counts as one).
	// Falls back to the raw words if everything was dropped.
	function makeHandle(name: string): string {
		const tokens = name
			.replace(/[äÄ]/g, 'ae')
			.replace(/[öÖ]/g, 'oe')
			.replace(/[üÜ]/g, 'ue')
			.replace(/ß/g, 'ss')
			.normalize('NFKD')
			.replace(/\p{Diacritic}/gu, '')
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter(Boolean);

		const kept: string[] = [];
		for (let i = 0; i < tokens.length; i++) {
			const t = tokens[i];
			const key = matchKey(tokens, i);
			if (key) {
				kept.push(key.token);
				i += key.span - 1;
				continue;
			}
			if (CATALOGUE_WITH_NUMBER.has(t)) {
				if (/^\d+$/.test(tokens[i + 1] ?? '')) i++; // drop the catalogue number too
				continue;
			}
			if (CATALOGUE_KEEP_NUMBER.has(t)) continue; // drop the label, keep its number
			if (STOP_WORDS.has(t) || MODE_WORDS.has(t)) continue;
			if (t.length === 1 && !/\d/.test(t)) continue; // lone letters (key names, initials)
			kept.push(t);
		}

		const words = (kept.length ? kept : tokens).slice(0, 4);
		return words.join('-').slice(0, 40).replace(/-+$/, '');
	}

	// Create the campaign repo and initialise it (Action A), entirely client-side
	// with the user's token: generate from the template, tag it, give its Actions a
	// write token, then commit the config, stamped score, and tracking tables.
	async function createCampaign(e: SubmitEvent) {
		e.preventDefault();
		error = null;
		created = null;
		retryInitialisation = null;
		const user = auth.user;
		const f = forge();
		if (!user || !f) return;

		const t = title.trim();
		const h = handle.trim();
		if (!t) return void (error = 'Campaign name is required.');
		if (!h) return void (error = 'A handle is required.');
		if (!/^[A-Za-z0-9_-]+$/.test(h)) {
			return void (error = 'The handle may only contain letters, numbers, hyphens and underscores.');
		}
		if (handleCheck.state === 'taken') {
			return void (error = `The handle "${h}" is already in use by ${handleCheck.by}. Pick a different one.`);
		}
		if (sourceMode === 'facsimile' && sourceFiles.length === 0) {
			return void (error = 'Add at least one page image or a PDF, or choose a different source.');
		}

		submitting = true;
		console.log('[create] creating campaign', { title: t, handle: h, sourceMode, visibility });

		// Facsimile source: render pages and detect measures BEFORE creating the
		// repo, so a detection failure doesn't leave an orphaned repository behind.
		let facsimile: PreparedFacsimile | null = null;
		if (sourceMode === 'facsimile') {
			try {
				progress = 'Reading your upload…';
				const { prepareFacsimile } = await import('$lib/facsimile-detect.ts');
				facsimile = await prepareFacsimile(
					sourceFiles,
					(_done, _total, note) => (progress = note),
					{ detectorUrl: measureDetectorUrl }
				);
			} catch (err) {
				console.error('Facsimile preparation failed:', (err as Error).message);
				error = `Could not process the upload: ${(err as Error).message}`;
				submitting = false;
				progress = null;
				return;
			}
			console.log(
				'[create] facsimile prepared:',
				facsimile.pages.length,
				'page(s),',
				facsimile.pages.reduce((n, p) => n + p.measures.length, 0),
				'measure(s) detected'
			);
			if (facsimile.pages.every((p) => p.measures.length === 0)) {
				error = 'No measures were detected on the uploaded pages. Check the images and try again.';
				submitting = false;
				progress = null;
				return;
			}
			progress = null;
		}

		try {
			const repo = await f.createRepoFromTemplate({
				templateOwner: provider.template.owner,
				templateRepo: provider.template.repo,
				owner: user.login,
				name: h,
				description: description.trim(),
				isPrivate: visibility === 'private'
			});
			const owner = repo.owner.login;
			console.log('[create] repo created:', repo.full_name, repo.html_url);

			// Tag it so it shows up in the listing (non-fatal: repo already exists).
			try {
				await f.setRepoTopics(owner, repo.name, [provider.repoTopic]);
			} catch (err) {
				console.warn('Could not tag new repo with topic:', (err as Error).message);
			}
			// Give the campaign's Actions a read/write token (non-fatal for org limits).
			try {
				await f.setActionsWorkflowPermissions(owner, repo.name);
			} catch (err) {
				console.warn('Could not set Actions workflow permissions:', (err as Error).message);
			}
			// Initialise (Action A). The repo already exists, so on failure we surface
			// a retry hint rather than treating creation itself as failed.
			const initialise = async () => {
				const template = await f.waitForRepoContents(owner, repo.name, 'templates/score.template.mei');
				const config = buildCampaignConfig(
					{
						title: t,
						description: description.trim(),
						license: license.trim() || undefined,
						composer: composer.trim(),
						sourceKind: facsimile ? 'facsimile' : 'mei-template'
					},
					user.login,
					automation
				);
				const header = {
					title: config.campaign.title,
					composer: config.sources[0].header.composer,
					license: config.campaign.license
				};

				// The score is either a facsimile scaffold (with its committed page
				// images) or the stamped blank template.
				const imageFiles: FileChange[] = [];
				let mei: string;
				if (facsimile) {
					// Stage A: facsimile + labelled zones only. The measure body is
					// generated once the measure-correction pre-task validates.
					mei = buildFacsimileMei(initialFacsimileModel(facsimile.pages, header));
					const { blobToBase64 } = await import('$lib/facsimile-detect.ts');
					for (const img of facsimile.images) {
						imageFiles.push({ path: img.path, contentBase64: await blobToBase64(img.blob) });
					}
				} else {
					mei = stampTemplate(template, header);
				}

				await f.commitFiles(
					owner,
					repo.name,
					[
						{ path: 'config.yaml', content: configToYaml(config) },
						{ path: 'sources/score.mei', content: mei },
						...imageFiles,
						{ path: 'tracking/task.csv', content: buildTaskCsv(config) },
						{ path: 'tracking/state.csv', content: buildStateCsv(config) },
						{ path: 'tracking/lock.csv', content: buildLockCsv() },
						{ path: 'tracking/history.csv', content: buildHistoryCsv() }
					],
					'Initialise campaign'
				);
				console.log('[create] campaign initialised: committed config, score and tracking tables');
			};
			try {
				await initialise();
			} catch (err) {
				console.error('Campaign initialisation failed:', (err as Error).message);
				created = { html_url: repo.html_url, full_name: repo.full_name, initWarning: true };
				retryInitialisation = initialise;
				error = `Campaign initialisation failed: ${(err as Error).message}`;
				submitting = false;
				progress = null;
				return;
			}

			// Some pages the detector couldn't process were left out (creation still
			// succeeded on the rest). Carry the skipped list to the console so it can
			// warn there, then navigate as for a clean creation.
			if (facsimile && facsimile.skipped.length) {
				console.warn('[create] pages skipped (detector error):', facsimile.skipped.join(', '));
				sessionStorage.setItem(
					`facsimile-skipped:${owner}/${repo.name}`,
					JSON.stringify(facsimile.skipped)
				);
			}

			// Take the organiser straight to the new repo's console. Keep the overlay
			// up through navigation rather than flashing it away.
			await goto(`/campaign/${owner}/${repo.name}`);
		} catch (err) {
			console.error('Repo creation failed:', (err as Error).message);
			error = 'Could not create the repository. Check the handle isn’t already taken, then try again.';
			submitting = false;
			progress = null;
		}
	}
</script>

{#if submitting}
	<div class="overlay" role="status" aria-live="polite">
		<div class="overlay-card">
			<div class="spinner" aria-hidden="true"></div>
			<p class="overlay-title">Creating your campaign…</p>
			<p class="overlay-sub">{progress ?? 'Setting up the campaign files. This takes a few seconds.'}</p>
		</div>
	</div>
{/if}

<section class="hero">
	<h1>Start a new encoding campaign</h1>
	<p>
		Log in with GitHub and fill in your campaign details. We'll create a GitHub repository from a
		template — it holds your campaign's score, configuration and progress.
	</p>

	{#if auth.user}
		{#if !showForm}
			<button class="cta" type="button" onclick={() => (showForm = true)}>
				Create a new campaign →
			</button>
		{/if}
	{:else}
		<button class="cta github" type="button" onclick={() => login()}>
			<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" fill="currentColor">
				<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
			</svg>
			Log in with GitHub
		</button>
	{/if}
</section>

{#if auth.user && showForm}
	<section class="create">
		<h2>Create a campaign</h2>
		{#if !automationRefPinned}
			<div class="banner warn">
				Development mode: new campaigns will follow the moving automation ref <code>{automation.ref}</code>.
				Pin <code>PUBLIC_AUTOMATION_REF</code> to a commit SHA before a production release.
			</div>
		{/if}

		{#if created}
			<div class="banner ok">
				Created <a href={created.html_url} target="_blank" rel="noreferrer">{created.full_name}</a> 🎉
			</div>
			{#if created.initWarning}
				<div class="banner warn">
					The repository was created, but setting up its campaign files didn't finish.
					<button type="button" class="linkish" onclick={retryCreatedCampaign}>Retry initialisation</button>
					without creating another repository.
				</div>
				{#if error}<div class="banner err">{error}</div>{/if}
			{/if}
		{:else if error}
			<div class="banner err">{error}</div>
		{/if}

		<form onsubmit={createCampaign}>
			<label>
				Campaign name
				<input bind:value={title} placeholder="e.g. Symphony No. 9 in D minor, Op. 125" required />
			</label>

			<label>
				Handle
				<input
					bind:value={handle}
					oninput={(e) => (handleTouched = e.currentTarget.value.trim() !== '')}
					placeholder="symphony-9-choral"
					required
				/>
				<span class="hint">Used in the URL and as the Git repository name. Auto-filled from the campaign name — edit it if you like.</span>
				{#if handleCheck.state === 'checking'}
					<span class="hint">Checking availability…</span>
				{:else if handleCheck.state === 'available'}
					<span class="hint hint-ok">✓ Available</span>
				{:else if handleCheck.state === 'taken'}
					<span class="hint hint-err">✗ Already used by {handleCheck.by}</span>
				{:else if handleCheck.state === 'invalid'}
					<span class="hint hint-err">Only letters, numbers, hyphens and underscores.</span>
				{:else if handleCheck.state === 'unknown'}
					<span class="hint">Couldn't check availability — it will be verified when the repository is created.</span>
				{/if}
			</label>

			<fieldset class="source">
				<legend>Score source</legend>

				<label class="radio">
					<input type="radio" name="source" value="facsimile" bind:group={sourceMode} />
					<span>
						Page images or PDF
						<span class="opt-hint">Detect measures and scaffold an empty score linked to the pages.</span>
					</span>
				</label>

				{#if sourceMode === 'facsimile'}
					<div
						class="upload dropzone"
						class:drag={dragActive}
						role="group"
						aria-label="File upload"
						ondragover={(e) => {
							e.preventDefault();
							dragActive = true;
						}}
						ondragleave={() => (dragActive = false)}
						ondrop={onDrop}
					>
						<span class="drop-label">Drag &amp; drop files here, or pick them:</span>
						<input
							type="file"
							accept="image/png,image/jpeg,application/pdf"
							multiple
							onchange={onFilesChange}
						/>
						<span class="hint">
							{#if sourceFiles.length}
								{sourceFiles.length} file{sourceFiles.length === 1 ? '' : 's'} selected. Each PDF is split into
								one image per page; all pages are combined into one score in the order shown.
							{:else}
								One or more PDFs (split into one image per page) and/or JPG/PNG page images.
							{/if}
						</span>
						{#if dropNote}
							<span class="hint hint-err">{dropNote}</span>
						{/if}
						<span class="hint">
							Page images are sent to <a href={measureDetectorUrl} target="_blank" rel="noreferrer">the configured measure detector</a>
							before the campaign repository is created.
						</span>
					</div>
				{/if}

				<label class="radio">
					<input type="radio" name="source" value="blank" bind:group={sourceMode} />
					<span>
						I don't have a facsimile file
						<span class="opt-hint">Start from a blank one-measure template.</span>
					</span>
				</label>

				<label class="radio disabled">
					<input type="radio" name="source" value="existing" disabled />
					<span>
						Existing MEI / MusicXML <span class="soon">coming soon</span>
						<span class="opt-hint">Upload a score you already have.</span>
					</span>
				</label>
			</fieldset>

			<details class="extra">
				<summary>Additional metadata</summary>
				<label>
					Composer <span class="muted">(optional)</span>
					<input bind:value={composer} placeholder="e.g. Anonymous" />
				</label>
			</details>

			<label>
				Description <span class="muted">(optional)</span>
				<input bind:value={description} placeholder="What is this repo for?" />
			</label>

			<label>
				License
				<select bind:value={license}>
					{#each LICENSES as l (l.id)}
						<option value={l.id}>{l.name}</option>
					{/each}
				</select>
				<span class="hint">
					{selectedLicense.info}
					<a href={selectedLicense.url} target="_blank" rel="noreferrer">Full license text →</a>
				</span>
			</label>

			<fieldset>
				<legend>Visibility of the GitHub repository</legend>
				<label class="radio">
					<input type="radio" name="visibility" value="private" bind:group={visibility} />
					Private
				</label>
				<label class="radio">
					<input type="radio" name="visibility" value="public" bind:group={visibility} />
					Public
				</label>
			</fieldset>

			<button type="submit" disabled={submitting}>
				{submitting ? 'Creating…' : 'Create campaign'}
			</button>
		</form>
	</section>
{/if}

<section class="repos">
	<h2>Repositories created from this template</h2>

	{#if listError}
		<p class="muted">Couldn't load the list: {listError}</p>
	{:else if repos.length === 0}
		<p class="muted">None yet. Be the first to create one!</p>
	{:else}
		<ul>
			{#each repos as repo (repo.full_name)}
				<li>
					<div class="row">
						<a href={`/campaign/${repo.owner}/${repo.name}`}>{repo.full_name}</a>
						{#if repo.private}
							<span class="badge" title="Private — only visible to its owner">
								<svg
									class="badge-lock"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2.2"
									stroke-linecap="round"
									aria-hidden="true"
								>
									<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"></rect>
									<path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"></path>
								</svg>
								Private
							</span>
						{/if}
						{#if auth.user}
							<a class="gh-link" href={repo.html_url} target="_blank" rel="noreferrer">View on GitHub →</a>
						{/if}
					</div>
					{#if repo.description}
						<p class="desc">{repo.description}</p>
					{/if}
				</li>
			{/each}
		</ul>
		{#if !auth.user}
			<p class="muted small">Log in to also see your own private repositories here.</p>
		{/if}
	{/if}
</section>

<style>
	.overlay {
		position: fixed;
		inset: 0;
		z-index: 50;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(255, 255, 255, 0.75);
		backdrop-filter: blur(2px);
	}
	.overlay-card {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.8rem;
		padding: 2rem 2.5rem;
		background: #fff;
		border: 1px solid #e5e5e5;
		border-radius: 12px;
		box-shadow: 0 10px 40px rgba(0, 0, 0, 0.12);
		text-align: center;
	}
	.spinner {
		width: 38px;
		height: 38px;
		border: 3px solid #e5e5e5;
		border-top-color: #1a1a1a;
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	.overlay-title {
		margin: 0;
		font-weight: 600;
	}
	.overlay-sub {
		margin: 0;
		color: #777;
		font-size: 0.88rem;
	}
	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation-duration: 2s;
		}
	}

	.hero {
		text-align: center;
		padding-top: 2rem;
	}
	h1 {
		font-size: 1.9rem;
		margin-bottom: 0.5rem;
	}
	.hero p {
		color: #555;
		margin-bottom: 2rem;
	}
	.cta {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		text-decoration: none;
		font-weight: 600;
		padding: 0.7rem 1.2rem;
		border-radius: 8px;
		background: #1a1a1a;
		color: #fff;
	}
	.cta:hover {
		background: #000;
	}
	button.cta {
		border: none;
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}

	.create {
		margin-top: 3rem;
		border-top: 1px solid #e5e5e5;
		padding-top: 1.5rem;
	}
	.create form {
		display: flex;
		flex-direction: column;
		gap: 1.1rem;
		margin-top: 1.5rem;
	}
	.create label {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		font-weight: 600;
		font-size: 0.9rem;
	}
	.create input:not([type='radio']),
	.create select {
		font: inherit;
		padding: 0.55rem 0.7rem;
		border: 1px solid #d0d0d0;
		border-radius: 6px;
	}
	.create select {
		background: #fff;
	}
	.create fieldset {
		border: 1px solid #e0e0e0;
		border-radius: 8px;
		display: flex;
		gap: 1.5rem;
		padding: 0.8rem 1rem;
	}
	.create legend {
		font-weight: 600;
		font-size: 0.9rem;
		padding: 0 0.3rem;
	}
	.create .radio {
		flex-direction: row;
		align-items: center;
		gap: 0.4rem;
		font-weight: 400;
	}
	.create .source {
		flex-direction: column;
		gap: 0.7rem;
		align-items: stretch;
	}
	.create .source .radio {
		align-items: flex-start;
		gap: 0.55rem;
		font-weight: 600;
	}
	.create .source .radio input {
		margin-top: 0.15rem;
	}
	.create .source .radio.disabled {
		opacity: 0.55;
	}
	.create .opt-hint {
		display: block;
		font-weight: 400;
		font-size: 0.8rem;
		color: #888;
		margin-top: 0.1rem;
	}
	.create .soon {
		font-size: 0.7rem;
		font-weight: 600;
		color: #8a6d00;
		background: #fff4d6;
		border: 1px solid #f0dca0;
		padding: 0.05rem 0.4rem;
		border-radius: 999px;
	}
	.create .upload {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		margin: -0.2rem 0 0.2rem 1.6rem;
	}
	.create .upload input[type='file'] {
		font: inherit;
		font-size: 0.85rem;
	}
	.create .dropzone {
		border: 2px dashed #d0d0d0;
		border-radius: 8px;
		padding: 0.9rem 1rem;
		background: #fafafa;
		transition: border-color 0.15s, background 0.15s;
	}
	.create .dropzone.drag {
		border-color: #1a1a1a;
		background: #f0f0f0;
	}
	.create .drop-label {
		font-weight: 600;
		font-size: 0.85rem;
	}
	.create button[type='submit'] {
		align-self: flex-start;
		font: inherit;
		font-weight: 600;
		padding: 0.6rem 1.1rem;
		border: none;
		border-radius: 8px;
		background: #1a1a1a;
		color: #fff;
		cursor: pointer;
	}
	.create button[disabled] {
		opacity: 0.6;
		cursor: default;
	}
	.create .muted {
		color: #999;
		font-weight: 400;
	}
	.create .hint {
		color: #888;
		font-weight: 400;
		font-size: 0.8rem;
	}
	.create .hint-ok {
		color: #1a7f37;
	}
	.create .hint-err {
		color: #b42318;
	}
	.create .extra {
		border: 1px solid #e0e0e0;
		border-radius: 8px;
		padding: 0 1rem;
	}
	.create .extra[open] {
		padding-bottom: 1rem;
	}
	.create .extra summary {
		cursor: pointer;
		font-weight: 600;
		font-size: 0.9rem;
		padding: 0.7rem 0;
	}
	.create .extra label {
		margin-top: 1rem;
	}
	.banner {
		padding: 0.7rem 1rem;
		border-radius: 8px;
		margin-bottom: 1rem;
	}
	.banner.ok {
		background: #e8f7ec;
		border: 1px solid #b6e2c1;
	}
	.banner.err {
		background: #fdeaea;
		border: 1px solid #f3c0c0;
	}
	.banner.warn {
		background: #fff8e1;
		border: 1px solid #f0dca0;
		color: #6a5300;
	}
	.repos {
		margin-top: 3.5rem;
		border-top: 1px solid #e5e5e5;
		padding-top: 1.5rem;
	}
	h2 {
		font-size: 1.15rem;
	}
	ul {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
	}
	li {
		border: 1px solid #e5e5e5;
		border-radius: 8px;
		padding: 0.8rem 1rem;
		background: #fff;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}
	.row a {
		font-weight: 600;
		text-decoration: none;
		color: #1a1a1a;
	}
	.row a:hover {
		text-decoration: underline;
	}
	.row a.gh-link {
		margin-left: auto;
		font-size: 0.8rem;
		font-weight: 600;
		color: #3056d3;
	}
	.badge {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.72rem;
		font-weight: 600;
		color: #8a6d00;
		background: #fff4d6;
		border: 1px solid #f0dca0;
		padding: 0.1rem 0.45rem;
		border-radius: 999px;
	}
	.badge-lock {
		width: 11px;
		height: 11px;
	}
	.desc {
		margin: 0.35rem 0 0;
		color: #666;
		font-size: 0.88rem;
	}
	.muted {
		color: #888;
	}
	.small {
		font-size: 0.85rem;
		margin-top: 1rem;
	}
</style>
