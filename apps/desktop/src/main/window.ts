import { join } from "node:path"
import { BrowserWindow, nativeTheme, shell, app } from "electron"
import { CHANNEL, type DeepLink, type ServerStatus } from "../shared/bridge.ts"

/**
 * The one window.
 *
 * The design draws its own traffic lights inside the rail (`traffic-lights.tsx`,
 * `rail.tsx`), so the native buttons are hidden rather than the whole frame
 * removed: `titleBarStyle: "hidden"` plus `setWindowButtonVisibility(false)`
 * keeps macOS's rounded corners, shadow, and resize edges while giving the rail
 * the top of the window. `frame: false` would have thrown those away too.
 *
 * Closing hides. Evie is tray-resident (see `tray.ts`) because "it keeps working
 * after you close the window" is the thing a local agent app is for; quitting is
 * an explicit tray action, and only quitting stops the server.
 */

const MIN_WIDTH = 720
const MIN_HEIGHT = 520

/** Pure black / pure white, matching `--color-surface-primary` in both themes. */
const backgroundFor = (): string => (nativeTheme.shouldUseDarkColors ? "#000000" : "#ffffff")

export class MainWindow {
  #window: BrowserWindow | null = null
  /** Buffered until the renderer is listening: a cold-start deep link arrives first. */
  #pendingLinks: DeepLink[] = []
  #lastStatus: ServerStatus = { kind: "starting" }

  get browserWindow(): BrowserWindow | null {
    return this.#window
  }

  /**
   * Creates the window if it does not exist and brings it forward.
   * `url` is used only on first creation -- reopening reuses the loaded page,
   * which still holds the session cookie.
   */
  async show(url: string): Promise<BrowserWindow> {
    const existing = this.#window
    if (existing !== null && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      return existing
    }

    const window = new BrowserWindow({
      width: 1_100,
      height: 760,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      titleBarStyle: "hidden",
      backgroundColor: backgroundFor(),
      // Nothing is drawn until the app has painted, so there is no white flash
      // and no empty frame while the first RPC round-trip lands.
      show: false,
      webPreferences: {
        preload: join(app.getAppPath(), "out", "preload.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    this.#window = window

    // The rail draws the close/minimize/zoom buttons itself.
    if (process.platform === "darwin") window.setWindowButtonVisibility(false)

    window.once("ready-to-show", () => {
      window.show()
    })

    // Close hides; only `app.quit()` from the tray gets past this, and it sets
    // `isQuitting` first so this handler stands down.
    window.on("close", (event) => {
      if ((app as { isQuitting?: boolean }).isQuitting === true) return
      event.preventDefault()
      window.hide()
    })

    window.on("closed", () => {
      this.#window = null
    })

    // Anything the page did not serve itself opens in the user's browser. The
    // agent renders links it was given by a model or a tool; none of them get
    // to replace the app or open a second Electron window with a preload in it.
    const origin = new URL(url).origin
    window.webContents.setWindowOpenHandler(({ url: target }) => {
      void shell.openExternal(target)
      return { action: "deny" }
    })
    window.webContents.on("will-navigate", (event, target) => {
      if (new URL(target).origin === origin) return
      event.preventDefault()
      void shell.openExternal(target)
    })

    // Everything queued before the page existed is delivered once, in order.
    window.webContents.on("did-finish-load", () => {
      window.webContents.send(CHANNEL.serverStatus, this.#lastStatus)
      const pending = this.#pendingLinks
      this.#pendingLinks = []
      for (const link of pending) window.webContents.send(CHANNEL.deepLink, link)
    })

    nativeTheme.on("updated", () => {
      if (!window.isDestroyed()) window.setBackgroundColor(backgroundFor())
    })

    await window.loadURL(url)
    return window
  }

  /** Reloads onto a URL -- used when the server came back with a new session. */
  async reload(url: string): Promise<void> {
    const window = this.#window
    if (window === null || window.isDestroyed()) return
    await window.loadURL(url)
  }

  send(link: DeepLink): void {
    const window = this.#window
    if (window === null || window.isDestroyed() || window.webContents.isLoading()) {
      this.#pendingLinks.push(link)
      return
    }
    window.webContents.send(CHANNEL.deepLink, link)
  }

  status(status: ServerStatus): void {
    this.#lastStatus = status
    const window = this.#window
    if (window === null || window.isDestroyed()) return
    window.webContents.send(CHANNEL.serverStatus, status)
  }
}
