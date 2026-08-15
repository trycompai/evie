/**
 * The desktop shell, from the web app's side.
 *
 * `apps/desktop` preloads a small object onto `window.evie`; this is the only
 * place the app reads it. Everything is null-safe because the same bundle is
 * the browser build -- `npx evie` and `tryevie.ai` load these exact files with
 * no shell underneath them, and none of this may throw there.
 *
 * The shape comes from `@evie/shared/desktop-bridge`, the one definition the
 * shell's preload also builds against -- types plus a parser, no Electron
 * import, so the browser build pays nothing for it and the two sides cannot
 * drift.
 */

export type { DeepLink, ServerStatus, EvieBridge } from "@evie/shared/desktop-bridge"
import type { DeepLink, EvieBridge, ServerStatus } from "@evie/shared/desktop-bridge"

const bridge = (globalThis as { evie?: EvieBridge }).evie ?? null

/**
 * True inside the Electron shell.
 *
 * Read once at module load rather than per render: the preload runs before any
 * script on the page, so this cannot change during a session, and a component
 * that re-checked it would be re-checking a constant on every commit.
 */
export const IS_DESKTOP = bridge !== null

/**
 * Window controls for the rail's drawn traffic lights.
 *
 * `null` in a browser, which is what `AppRail` switches on -- there is no
 * window to close in a tab, and three buttons that do nothing is worse than
 * three buttons that are not there.
 */
export const windowControls = bridge?.window ?? null

/** Subscribes to `evie://` links. Returns an unsubscribe; no-op off desktop. */
export const onDeepLink = (handler: (link: DeepLink) => void): (() => void) =>
  bridge?.onDeepLink(handler) ?? (() => {})

/** Subscribes to the shell's view of its server child. No-op off desktop. */
export const onServerStatus = (handler: (status: ServerStatus) => void): (() => void) =>
  bridge?.onServerStatus(handler) ?? (() => {})

export const shellVersion = bridge?.version ?? null

/* --- deep links ----------------------------------------------------------------
 *
 * `evie://thread/<id>` can arrive at any moment, including before React has
 * mounted -- the shell buffers links that land during a cold start and flushes
 * them the instant the page finishes loading. So the bridge subscription is
 * opened here, at module load, and anything that arrives with no handler
 * attached waits in `pending` until one is.
 *
 * A link is an *event*, not state: it asks the window to go somewhere, and
 * where the window is now lives in the URL. Delivering it to a handler is why
 * there is no sequence number here any more -- opening `evie://thread/x` twice
 * while already looking at thread x is two calls, which is the behaviour a
 * counter existed to fake. */

const handlers = new Set<(link: DeepLink) => void>()
let pending: DeepLink | null = null

if (bridge !== null) {
  bridge.onDeepLink((link) => {
    if (handlers.size === 0) {
      // Last one wins. Two links queued behind a cold start are two requests to
      // be in two places, and the window can only honour the newer one.
      pending = link
      return
    }
    for (const handler of handlers) handler(link)
  })
}

export const deepLinkStore = {
  /**
   * Registers a handler, replaying whatever the shell delivered before React
   * was ready. Returns an unsubscribe. No-op off desktop -- nothing ever
   * writes here in a browser.
   */
  listen: (handler: (link: DeepLink) => void): (() => void) => {
    handlers.add(handler)
    if (pending !== null) {
      const link = pending
      pending = null
      handler(link)
    }
    return () => {
      handlers.delete(handler)
    }
  },
} as const
