// The Musibot OMR service, reached through the broker's /omr relay (the
// service sends no CORS headers and its token stays in the broker). A unit of
// work is one ephemeral page: create it, upload files, run pipelines over
// them, download what they wrote, delete it. Files travel over presigned URLs
// on the service's host, which the relay's /omr/blob transfers.
//
// Browser and Node: fetch only, no DOM.

/** A pipeline or model of the service, identified by name and version. */
export interface OmrPipeline {
	name: string;
	version: string;
}

/** One pipeline of the service's listing. */
export interface OmrPipelineEntry extends OmrPipeline {
	/** What the pipeline reads and writes, as page-relative file patterns. */
	signature: { input: string[]; output: string[] };
	/** Whether the entry is a model callable on its own rather than a composed pipeline. */
	implicit: boolean;
}

/** A pipeline execution as the service reports it. */
export interface OmrExecution {
	execution_id: number;
	pipeline_name: string;
	pipeline_version: string;
	input: string[];
	/** 'running' while under way, then 'completed' or 'failed'. */
	state: string;
	/** Why it failed; null otherwise. */
	error: string | null;
}

export interface OmrClientOptions {
	/** The fetch to use; defaults to the global one. */
	fetch?: typeof fetch;
	/** Ceiling on one relay request. */
	requestTimeoutMs?: number;
	/** Interval between execution polls. */
	pollMs?: number;
	/** Ceiling on one execution, start to settled. */
	executionTimeoutMs?: number;
	/** Waits `ms`; injectable so tests need not wait. */
	sleep?: (ms: number) => Promise<void>;
}

const DEFAULTS = {
	requestTimeoutMs: 60_000,
	pollMs: 1000,
	executionTimeoutMs: 5 * 60_000
};

/** The relay's error for a failed call, with the HTTP status. */
export class OmrError extends Error {
	constructor(
		message: string,
		readonly status: number
	) {
		super(message);
	}
}

export interface OmrClient {
	/** The service's current pipelines and models. */
	pipelines(): Promise<OmrPipelineEntry[]>;
	/**
	 * Throws unless every required pipeline is offered at exactly that
	 * version, naming the ones that are not.
	 */
	requirePipelines(required: OmrPipeline[]): Promise<void>;
	createPage(): Promise<string>;
	deletePage(pageId: string): Promise<void>;
	/** Upload files by page-relative path (`image.jpg`, `Staves/3/image.jpg`). */
	upload(pageId: string, files: Record<string, Blob>): Promise<void>;
	/** Download files by page-relative path. */
	download(pageId: string, paths: string[]): Promise<Record<string, Blob>>;
	/**
	 * Start a pipeline over `input` and wait until it has settled. A failed
	 * execution is returned, not thrown: its `error` says why, and one failed
	 * staff must not fail a page.
	 */
	run(
		pageId: string,
		pipeline: OmrPipeline,
		input: string[],
		parameters?: Record<string, unknown>
	): Promise<OmrExecution>;
	/** Create a page, do `work` on it, and delete it whatever `work` did. */
	withPage<T>(work: (pageId: string) => Promise<T>): Promise<T>;
}

/** A client over the relay mounted under `brokerUrl` (same-origin path, e.g. `/auth`). */
export function createOmrClient(brokerUrl: string, options: OmrClientOptions = {}): OmrClient {
	const base = `${brokerUrl.replace(/\/$/, '')}/omr`;
	const doFetch = options.fetch ?? fetch;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs;
	const pollMs = options.pollMs ?? DEFAULTS.pollMs;
	const executionTimeoutMs = options.executionTimeoutMs ?? DEFAULTS.executionTimeoutMs;

	// One relay call. Network failures and timeouts become OmrErrors with
	// status 0; a failing status carries the relay's or the service's message.
	async function call(method: string, url: string, init: RequestInit = {}): Promise<Response> {
		let res: Response;
		try {
			res = await doFetch(url, { ...init, method, signal: AbortSignal.timeout(requestTimeoutMs) });
		} catch (err) {
			const timedOut = err instanceof DOMException && err.name === 'TimeoutError';
			throw new OmrError(
				timedOut
					? `The OMR service did not answer within ${requestTimeoutMs / 1000}s (${method} ${url}).`
					: `Could not reach the OMR relay (${method} ${url}).`,
				0
			);
		}
		if (res.ok) return res;
		let detail = '';
		try {
			const body = (await res.json()) as { error?: unknown; detail?: unknown };
			const text = body.error ?? body.detail;
			if (typeof text === 'string') detail = text;
		} catch {
			// Not JSON: the status alone names the failure.
		}
		throw new OmrError(
			`The OMR service returned ${res.status} for ${method} ${url}${detail ? `: ${detail}` : '.'}`,
			res.status
		);
	}

	const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
		const res = await call(method, `${base}/api/${path}`, {
			headers: body === undefined ? undefined : { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		});
		return (await res.json()) as T;
	};

	const blobUrl = (presigned: string) => `${base}/blob?url=${encodeURIComponent(presigned)}`;

	async function fileUrls(
		pageId: string,
		request: { put?: string[]; get?: string[] }
	): Promise<{ put: Record<string, string>; get: Record<string, string> }> {
		const urls = await api<{ put?: Record<string, string>; get?: Record<string, string> }>(
			'POST',
			`musicorpus-pages/${pageId}/file-urls`,
			request
		);
		return { put: urls.put ?? {}, get: urls.get ?? {} };
	}

	const client: OmrClient = {
		async pipelines() {
			const listing = await api<{ pipelines?: OmrPipelineEntry[] }>('GET', 'pipelines');
			return listing.pipelines ?? [];
		},

		async requirePipelines(required) {
			const offered = await client.pipelines();
			const missing = required.filter(
				(p) => !offered.some((o) => o.name === p.name && o.version === p.version)
			);
			if (missing.length) {
				throw new OmrError(
					`The OMR service no longer offers ${missing.map((p) => `${p.name} ${p.version}`).join(', ')}.`,
					0
				);
			}
		},

		async createPage() {
			const page = await api<{ page_id?: string }>('POST', 'musicorpus-pages');
			if (!page.page_id) throw new OmrError('The OMR service created a page without an id.', 0);
			return page.page_id;
		},

		async deletePage(pageId) {
			await call('DELETE', `${base}/api/musicorpus-pages/${pageId}`);
		},

		async upload(pageId, files) {
			const paths = Object.keys(files);
			if (!paths.length) return;
			const { put } = await fileUrls(pageId, { put: paths });
			for (const path of paths) {
				const url = put[path];
				if (!url) throw new OmrError(`The OMR service gave no upload URL for ${path}.`, 0);
				await call('PUT', blobUrl(url), {
					headers: { 'content-type': files[path].type || 'application/octet-stream' },
					body: files[path]
				});
			}
		},

		async download(pageId, paths) {
			if (!paths.length) return {};
			const { get } = await fileUrls(pageId, { get: paths });
			const out: Record<string, Blob> = {};
			for (const path of paths) {
				const url = get[path];
				if (!url) throw new OmrError(`The OMR service gave no download URL for ${path}.`, 0);
				out[path] = await (await call('GET', blobUrl(url))).blob();
			}
			return out;
		},

		async run(pageId, pipeline, input, parameters = {}) {
			const started = await api<OmrExecution>('POST', `musicorpus-pages/${pageId}/pipeline-executions`, {
				pipeline_name: pipeline.name,
				pipeline_version: pipeline.version,
				input,
				parameters
			});
			let execution = started;
			const deadline = Date.now() + executionTimeoutMs;
			while (execution.state === 'running') {
				if (Date.now() >= deadline) {
					throw new OmrError(
						`${pipeline.name} ${pipeline.version} did not finish within ${executionTimeoutMs / 1000}s.`,
						0
					);
				}
				await sleep(pollMs);
				execution = await api<OmrExecution>(
					'GET',
					`musicorpus-pages/${pageId}/pipeline-executions/${started.execution_id}`
				);
			}
			return execution;
		},

		async withPage(work) {
			const pageId = await client.createPage();
			try {
				return await work(pageId);
			} finally {
				// The page is ephemeral by contract; a failed delete leaves it to
				// the service's own eviction and must not mask `work`'s outcome.
				await client.deletePage(pageId).catch(() => undefined);
			}
		}
	};
	return client;
}
