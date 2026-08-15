import { build } from "esbuild"
import { chmodSync, cpSync, existsSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Bundles the `evie` command.
 *
 * | Output | Why |
 * | --- | --- |
 * | `dist/evie.mjs` | The CLI and the whole server, self-contained. |
 * | `dist/web` | The built web app, served from the same origin. |
 *
 * The server is bundled rather than published from source because every
 * `@evie/*` package exports raw `.ts` and emits nothing: a tarball cannot carry
 * the workspace, and Node's type stripping refuses to touch anything under
 * `node_modules`. Bundling resolves that at build time and leaves one file to
 * publish -- the same trade `apps/desktop/scripts/build.mjs` makes, which is
 * the point: `specs/06` wants `npx evie` to be the same binary the desktop app
 * runs, and two bundlers agreeing is how that stays true.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "..")
const DIST = join(ROOT, "dist")
const CLI = join(DIST, "evie.mjs")
const WEB_DIST = join(ROOT, "..", "web", "dist")

await build({
  entryPoints: [join(ROOT, "src", "cli.ts")],
  outfile: CLI,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: true,
  logLevel: "info",
  banner: {
    js: [
      "#!/usr/bin/env node",
      // Effect's ESM reaches for `require` at load; without the shim the bundle
      // throws in a CJS-interop context.
      "import { createRequire as __createRequire } from 'node:module'",
      "const require = __createRequire(import.meta.url)",
    ].join("\n"),
  },
  // Nothing external. `node:sqlite` -- the server's one hard runtime
  // requirement -- comes from the host, which is why the published package
  // needs Node 24.
  packages: undefined,
})

// npm sets the bit on install from `bin`; this is for running the artifact in
// place, which is the only way it gets tested before it is published.
chmodSync(CLI, 0o755)

/* --- the web app -------------------------------------------------------------
 * Copied, not proxied: the server mounts `EVIE_WEB_DIST` with an SPA fallback,
 * so the app loads from the same origin as the RPC socket and the auth cookie.
 * Turbo builds it first -- `@evie/web` is a dependency for exactly this. */

if (existsSync(WEB_DIST)) {
  rmSync(join(DIST, "web"), { recursive: true, force: true })
  cpSync(WEB_DIST, join(DIST, "web"), { recursive: true })
  console.log("build: copied apps/web/dist -> dist/web")
} else {
  console.warn(
    `build: no web build at ${WEB_DIST}. Run \`turbo run build --filter=@evie/web\` first, ` +
      "or the command will serve the API with no app in front of it.",
  )
}
