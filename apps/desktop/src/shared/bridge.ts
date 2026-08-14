/**
 * The contract between the Electron shell and the web app it wraps.
 *
 * `apps/web` detects desktop with `"evie" in globalThis` and switches on it in
 * three places (window controls, drag regions, the account row). This file is
 * the only definition of what that global is; the preload builds it and the web
 * app's `~/lib/desktop.ts` reads it back through the same types.
 *
 * Kept deliberately small. Everything the app can already do over the RPC
 * socket it keeps doing over the RPC socket -- this bridge is for the four
 * things a web page genuinely cannot do: move its own window, know it is in a
 * shell, receive an OS deep link, and learn the server went away.
 */

/** IPC channel names. Strings live here so main and preload cannot drift. */
export const CHANNEL = {
  windowClose: "evie:window/close",
  windowMinimize: "evie:window/minimize",
  windowZoom: "evie:window/zoom",
  deepLink: "evie:deep-link",
  serverStatus: "evie:server/status",
} as const

/**
 * `evie://thread/<id>` and `evie://bot/<id>`, parsed in main so the renderer
 * never sees a raw URL. The web app has no router by design (specs/04), so a
 * deep link is a message that selects something, not a navigation.
 */
export type DeepLink =
  | { readonly kind: "thread"; readonly threadId: string }
  | { readonly kind: "bot"; readonly botId: string }
  | { readonly kind: "unknown"; readonly url: string }

/**
 * What the shell knows about its server child. The renderer already shows
 * connection state from its own socket; this is the layer underneath -- the
 * socket cannot distinguish "server restarting" from "network gone", and the
 * shell can.
 */
export type ServerStatus =
  | { readonly kind: "starting" }
  | { readonly kind: "ready"; readonly origin: string }
  | { readonly kind: "restarting"; readonly attempt: number }
  | { readonly kind: "failed"; readonly reason: string }

export interface EvieBridge {
  readonly platform: NodeJS.Platform
  /** The shell's version, not the server's. Shown in About. */
  readonly version: string
  readonly window: {
    /** Hides the window. Evie keeps running in the tray; quit is a tray action. */
    readonly close: () => void
    readonly minimize: () => void
    readonly zoom: () => void
  }
  /** Returns an unsubscribe. Ref-callback friendly, so no `useEffect` is needed. */
  readonly onDeepLink: (handler: (link: DeepLink) => void) => () => void
  readonly onServerStatus: (handler: (status: ServerStatus) => void) => () => void
}

/**
 * `evie://thread/01J…` -> `{ kind: "thread", threadId: "01J…" }`.
 *
 * Tolerant of the two spellings macOS hands back (`evie://thread/x` parses with
 * host `thread`, `evie:///thread/x` with an empty host and a leading path
 * segment) because which one arrives depends on how the link was written, not
 * on anything we control.
 */
export const parseDeepLink = (raw: string): DeepLink => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { kind: "unknown", url: raw }
  }
  const segments = [url.hostname, ...url.pathname.split("/")].filter((part) => part.length > 0)
  const [kind, id] = segments
  if (id === undefined) return { kind: "unknown", url: raw }
  if (kind === "thread") return { kind: "thread", threadId: decodeURIComponent(id) }
  if (kind === "bot") return { kind: "bot", botId: decodeURIComponent(id) }
  return { kind: "unknown", url: raw }
}
