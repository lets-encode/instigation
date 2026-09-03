# libxml2-wasm 0.7.1 (vendored)

Source: https://github.com/jameslan/libxml2-wasm — npm package `libxml2-wasm`
version 0.7.1, MIT licence (see LICENSE). Copied: `lib/*.mjs` and the
`lib/*.d.mts` type declarations, without the source maps and without
`nodejs.mjs` (a Node-only file input provider the coordinator does not use).

The coordinator runs on GitHub-hosted runners with no `npm ci`; vendoring
the library lets `scripts/mei-validate.ts` validate MEI against the RelaxNG
schema with the runner's own Node and nothing installed. The WebAssembly
binary is embedded in `libxml2raw.mjs`.

To update: `npm pack libxml2-wasm@<version>`, unpack, copy the same files,
update the version here, run `npm run check` and `npm test`.
