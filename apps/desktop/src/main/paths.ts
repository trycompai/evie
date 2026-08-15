import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { app } from "electron"

/**
 * Where the shell's own files are.
 *
 * Anchored on `__dirname` rather than `app.getAppPath()`, which is a trap here:
 * it returns the directory Electron was *pointed at*, so `electron .` and
 * `electron out/main.cjs` give two different answers and only one of them is
 * the package root. Every path below is a sibling of the bundled `main.cjs`, so
 * `__dirname` is both correct and invocation-independent.
 *
 * Packaged, the same four files are copied into `Contents/Resources`.
 */

const ASSETS = app.isPackaged ? process.resourcesPath : __dirname

export const serverEntry = join(ASSETS, "server.mjs")
export const webDist = join(ASSETS, "web")
export const preloadScript = join(ASSETS, "preload.cjs")
export const trayIcon = join(ASSETS, "trayTemplate.png")
/** The mark in its committed colours, for the dock. Packaged builds use `icon.icns`. */
export const appIcon = join(ASSETS, "icon.png")

/**
 * The data directory.
 *
 * Packaged, this *is* the live install, which is what `EVIE_ALLOW_LIVE_HOME`
 * exists to say out loud. Unpackaged it points at the worktree's gitignored
 * `.evie`: running the shell from a checkout must never open the developer's
 * real database, and the server's own `assertNotLiveInstall` would refuse to
 * start if it tried.
 */
export const evieHome = (): { readonly path: string; readonly live: boolean } => {
  /*
   * An inherited `EVIE_HOME` wins, in both modes. Without this a packaged build
   * could only ever be tested against the developer's real install, which
   * `AGENTS.md` rule 2 exists to prevent -- and "the only way to try the
   * shipped artifact is to point it at your live data" is how that rule gets
   * broken by someone following instructions.
   */
  const override = process.env["EVIE_HOME"]
  if (override !== undefined && override.length > 0) {
    return { path: resolve(override), live: false }
  }
  if (!app.isPackaged) return { path: join(__dirname, "..", "..", "..", ".evie"), live: false }

  /*
   * A bundle built from a checkout is packaged but is not an install.
   * `scripts/package.mjs` stamps the workspace's own `.evie` into the app
   * manifest; a release pipeline will not, and only then does `~/.evie` --
   * the live install, and the one thing AGENTS.md rule 2 protects -- apply.
   */
  const devHome = readDevHome()
  if (devHome !== undefined) return { path: devHome, live: false }

  return { path: join(app.getPath("home"), ".evie"), live: true }
}

const readDevHome = (): string | undefined => {
  try {
    const manifest = JSON.parse(
      readFileSync(join(process.resourcesPath, "app", "package.json"), "utf8"),
    ) as { devHome?: unknown }
    return typeof manifest.devHome === "string" ? resolve(manifest.devHome) : undefined
  } catch {
    // No manifest, or no stamp: a real install. Fall through to ~/.evie.
    return undefined
  }
}
