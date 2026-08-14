import { build } from "esbuild"
import { cpSync, existsSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Bundles the three programs that make up the desktop app.
 *
 * | Output | Format | Why |
 * | --- | --- | --- |
 * | `out/main.cjs` | CJS | Electron's main process. |
 * | `out/preload.cjs` | CJS | A sandboxed preload cannot be ESM. |
 * | `out/server.mjs` | ESM | The Evie server, run by Electron in Node mode. |
 *
 * The server is bundled rather than run from source because the workspace
 * packages it imports (`@evie/contracts`, `@evie/shared`) export raw `.ts`, and
 * Node's type stripping refuses to touch anything under `node_modules`. Bundling
 * resolves them at build time, which also means the packaged app carries one
 * file instead of a workspace.
 *
 * Nothing is left external. Bun installs each workspace in isolation, so
 * `apps/server`'s dependencies live under `apps/server/node_modules` and an
 * external import from `apps/desktop/out/` cannot resolve them -- and a
 * packaged `.app` has no workspace to resolve against at all. Self-contained is
 * both the only thing that works here and the thing packaging needs anyway.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "..")
const OUT = join(ROOT, "out")
const SERVER = join(ROOT, "..", "server")
const WEB_DIST = join(ROOT, "..", "web", "dist")

const common = {
  bundle: true,
  platform: "node",
  target: "node24",
  sourcemap: true,
  logLevel: "info",
}

await build({
  ...common,
  entryPoints: [join(ROOT, "src", "main", "index.ts")],
  outfile: join(OUT, "main.cjs"),
  format: "cjs",
  external: ["electron"],
})

await build({
  ...common,
  entryPoints: [join(ROOT, "src", "preload", "index.ts")],
  outfile: join(OUT, "preload.cjs"),
  format: "cjs",
  external: ["electron"],
})

await build({
  ...common,
  entryPoints: [join(SERVER, "src", "main.ts")],
  outfile: join(OUT, "server.mjs"),
  format: "esm",
  // Effect's ESM reaches for these at load; without the shim the bundle throws
  // on `import.meta.url` being undefined in a CJS-interop context.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module'",
      "const require = __createRequire(import.meta.url)",
    ].join("\n"),
  },
  // `node:sqlite` and friends are provided by the host; Electron 40 embeds
  // Node 24, which is where the server's one hard requirement comes from.
  packages: undefined,
})

/* --- the web app -------------------------------------------------------------
 * Copied rather than served: the server mounts `EVIE_WEB_DIST` with an SPA
 * fallback, so the window loads from the same origin as the RPC socket and the
 * auth cookie. A dev-server origin would be a second origin and a third-party
 * cookie. */

if (existsSync(WEB_DIST)) {
  rmSync(join(OUT, "web"), { recursive: true, force: true })
  cpSync(WEB_DIST, join(OUT, "web"), { recursive: true })
  console.log("build: copied apps/web/dist -> out/web")
} else {
  console.warn(
    `build: no web build at ${WEB_DIST}. Run \`turbo run build --filter=@evie/web\` first, ` +
      "or the window will load an empty server.",
  )
}
