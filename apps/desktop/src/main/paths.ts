import { join } from "node:path"
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
export const evieHome = (): { readonly path: string; readonly live: boolean } =>
  app.isPackaged
    ? { path: join(app.getPath("home"), ".evie"), live: true }
    : { path: join(__dirname, "..", "..", "..", ".evie"), live: false }
