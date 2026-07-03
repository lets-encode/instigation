// The verovio npm package ships no type declarations — minimal shims for the
// entry points used here.
declare module 'verovio/wasm' {
	const createVerovioModule: () => Promise<unknown>;
	export default createVerovioModule;
}

declare module 'verovio/esm' {
	export class VerovioToolkit {
		constructor(module: unknown);
		setOptions(options: Record<string, unknown>): void;
		loadData(data: string): boolean;
		getPageCount(): number;
		renderToSVG(page: number): string;
	}
}
