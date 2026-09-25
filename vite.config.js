import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// Each deployed instance builds from its own branch (README §6); the branch
// selects the .env.<mode> overlay, so `npm run build` takes no --mode flag.
// Any other branch builds in development mode; a detached HEAD has no branch
// and must name the mode on the command line.
const branchModes = {
  main: "production",
  staging: "staging",
  testing: "testing",
};

function modeForBranch() {
  const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (branch === "HEAD") {
    throw new Error(
      "detached HEAD: pass --mode production|staging|testing to vite build",
    );
  }
  const mode = branchModes[branch];
  if (!mode)
    console.log(
      `branch "${branch}" is not deployed; building in development mode`,
    );
  return mode ?? "development";
}

// The project website's index.html (static/) answers "/" on the dev server,
// as mod_dir's DirectoryIndex does deployed. Vite serves the other static/
// files at the root itself; only the directory index needs this. Registered
// before Vite's own middleware, so the SPA router never sees "/".
const serveWebsiteIndex = () => ({
  name: "serve-website-index",
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (new URL(req.url, "http://x").pathname !== "/") return next();
      res.setHeader("Content-Type", "text/html");
      res.end(
        await readFile(join(import.meta.dirname, "static", "index.html")),
      );
    });
  },
});

// The text recognition's language data (src/lib/ocr.ts), served at
// /ocr/<lang>.traineddata.gz: tesseract.js builds the file names from a
// directory URL itself, so the files need fixed names rather than hashed
// asset URLs. Served from node_modules on the dev server and written into the
// build output.
const OCR_LANGUAGES = ["deu", "eng"];
const ocrLanguageFile = (lang) =>
  join(
    import.meta.dirname,
    "node_modules",
    "@tesseract.js-data",
    lang,
    "4.0.0_best_int",
    `${lang}.traineddata.gz`,
  );
const ocrLanguageData = () => ({
  name: "ocr-language-data",
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const lang = /^\/ocr\/([a-z]+)\.traineddata\.gz$/.exec(
        new URL(req.url, "http://x").pathname,
      )?.[1];
      if (!lang || !OCR_LANGUAGES.includes(lang)) return next();
      res.setHeader("Content-Type", "application/octet-stream");
      res.end(await readFile(ocrLanguageFile(lang)));
    });
  },
  async generateBundle() {
    for (const lang of OCR_LANGUAGES) {
      this.emitFile({
        type: "asset",
        fileName: `ocr/${lang}.traineddata.gz`,
        source: await readFile(ocrLanguageFile(lang)),
      });
    }
  },
});

export default defineConfig(({ command, mode }) => {
  if (command === "build") {
    // A --mode on the command line overrides the branch-derived mode. The
    // decision is stored in the environment because SvelteKit's build forks
    // child processes that load this config again without the command
    // line; they inherit the parent's choice instead of deriving their own.
    const cliMode = process.argv.some(
      (a) => a === "--mode" || a === "-m" || a.startsWith("--mode="),
    );
    mode = process.env.INSTIGATION_BUILD_MODE ??= cliMode
      ? mode
      : modeForBranch();
  }
  return {
    mode,
    // The .env files live in instances-config/ with services.json; svelte.config.js
    // points SvelteKit's env loader at the same directory.
    envDir: "instances-config",
    plugins: [serveWebsiteIndex(), ocrLanguageData(), sveltekit()],
    define: {
      // The footer's "app last updated" date, fixed at build time.
      __BUILD_DATE__: JSON.stringify(
        new Date().toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        }),
      ),
    },
    optimizeDeps: {
      exclude: ["verovio/wasm", "verovio/esm"],
    },
    server: {
      // The build output is not part of the served app; without this, a
      // `vite build` while the dev server runs force-reloads its clients.
      watch: {
        ignored: ["**/website/**"],
      },
      // The browser-side MEI check (src/lib/mei-check.ts) imports the
      // vendored libxml2-wasm from scripts/, outside the directories the
      // dev server serves by default.
      fs: {
        allow: ["scripts/vendor"],
      },
      // Mount the session broker under the SPA's own origin, mirroring the
      // deployed reverse proxy's /auth/ mount (README §6) — its session cookie
      // must be first-party. Run it with:  flask --app app run --port 7777  (in broker/)
      proxy: {
        "/auth": {
          target: "http://127.0.0.1:7777",
          rewrite: (path) => path.replace(/^\/auth/, ""),
        },
        // The slug registry is part of the broker, as a blueprint mounted at
        // /registry (see broker/registry.py), so the path passes through
        // unchanged to the same server.
        "/registry": {
          target: "http://127.0.0.1:7777",
        },
      },
    },
  };
});
