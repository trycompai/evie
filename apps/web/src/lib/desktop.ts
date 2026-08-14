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
import type { DeepLink, EvieBridge } from "@evie/shared/desktop-bridge"

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

/* --- deep links as an external store ------------------------------------------
 *
 * `evie://thread/<id>` can arrive at any moment, including before React has
 * mounted -- the shell buffers links that land during a cold start and flushes
 * them the instant the page finishes loading. So the subscription is opened
 * here, at module load, and components read the result through
 * `useSyncExternalStore` like every other piece of external state in this app.
 *
 * `seq` is what makes a *repeat* of the same link observable: opening
 * `evie://thread/x` twice while already looking at thread x must still count as
 * an event, and comparing link objects cannot see that. */

export interface DeepLinkEvent {
  readonly seq: number
  readonly link: DeepLink
}

let current: DeepLinkEvent | null = null
const listeners = new Set<() => void>()

if (bridge !== null) {
  bridge.onDeepLink((link) => {
    current = { seq: (current?.seq ?? 0) + 1, link }
    for (const listener of listeners) listener()
  })
}

/** Cached: a fresh object per call would spin `useSyncExternalStore` forever. */
export const deepLinkStore = {
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  snapshot: (): DeepLinkEvent | null => current,
} as const
