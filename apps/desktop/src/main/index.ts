import { app, dialog, ipcMain, nativeImage } from "electron"
import { CHANNEL, parseDeepLink, type DeepLink, type ServerStatus } from "@evie/shared/desktop-bridge"
import { parseNotify, showNotification } from "./notifications.ts"
import { EvieServer } from "./server.ts"
import { EvieTray } from "./tray.ts"
import { MainWindow } from "./window.ts"
import { appIcon } from "./paths.ts"

/*
 * Before anything else, and before `whenReady`.
 *
 * `app.getName()` seeds the notification sender, the About panel, the crash
 * reporter, and `app.getPath("userData")` -- and that last one is a directory
 * that gets created the first time anything asks for it, so renaming later
 * would strand Electron's own state under a folder called "Electron".
 *
 * The macOS menu bar title is the one thing this cannot set: AppKit reads it
 * from the running bundle's Info.plist, so it says "Electron" until the app is
 * packaged with `productName`, and no API call changes that.
 */
app.setName("Evie")

/**
 * The Evie desktop shell.
 *
 * Boot order is the whole design: the server starts first and prints the URL to
 * open, the window loads exactly that URL, and the tray is what keeps both
 * alive after the window is closed. There is deliberately no second
 * authentication path -- the shell opens the same one-time claim URL a person
 * would paste into a browser, so desktop and `npx evie` cannot drift apart in
 * how a session begins.
 */

/** Read by the `close` handler in `window.ts` to tell hiding from quitting. */
interface Quittable {
  isQuitting?: boolean
}

const shell = new (class {
  readonly window = new MainWindow()
  readonly server = new EvieServer({
    onStatus: (status) => this.#status(status),
    onNotify: (line) => this.#notify(line),
    onLog: (line) => {
      if (line.trim().length > 0) process.stdout.write(`[server] ${line}\n`)
    },
  })
  readonly tray = new EvieTray({
    onOpen: () => void this.open(),
    onRestart: () => void this.restart(),
    onQuit: () => void this.quit(),
  })

  #status(status: ServerStatus): void {
    this.tray.status(status)
    this.window.status(status)
    if (status.kind === "failed") {
      // Deliberately not `showErrorBox`, which blocks the main process on a
      // modal before the tray exists -- the app then looks frozen rather than
      // broken, with no way to quit it. This stays on the message loop.
      void dialog.showMessageBox({
        type: "error",
        title: "Evie could not start",
        message: "The Evie server stopped.",
        detail: status.reason,
        buttons: ["Quit", "Try Again"],
        defaultId: 1,
        cancelId: 0,
      }).then((choice) => {
        if (choice.response === 1) void this.restart()
        else void this.quit()
      })
    }
  }

  #notify(line: string): void {
    const payload = parseNotify(line)
    if (payload === null) return
    showNotification(payload, (threadId) => {
      void this.open()
      if (threadId !== null) this.window.send({ kind: "thread", threadId })
    })
  }

  /**
   * Opens the window, minting a fresh session if the server can give us one.
   *
   * The boot-printed claim token is single-use and lives 60 seconds, so it is a
   * fine way to open the *first* window and a bad way to open the second. The
   * launcher endpoint exists so reopening never depends on a token that may
   * already be spent or expired; the bare origin is the last resort, and lands
   * on the app's own sign-in state rather than a blank page.
   */
  async open(): Promise<void> {
    const handle = this.server.handle
    if (handle === null) return
    const existing = this.window.browserWindow
    if (existing !== null && !existing.isDestroyed()) {
      await this.window.show(handle.origin)
      return
    }
    const fresh = await this.server.freshClaimUrl()
    await this.window.show(fresh ?? handle.claimUrl)
  }

  async restart(): Promise<void> {
    await this.server.stop()
    const handle = await this.server.start()
    const fresh = await this.server.freshClaimUrl()
    await this.window.reload(fresh ?? handle.claimUrl)
  }

  async quit(): Promise<void> {
    ;(app as Quittable).isQuitting = true
    // Stop the server before Electron tears the process down, so SQLite closes
    // cleanly and the child never outlives the shell that spawned it.
    await this.server.stop()
    this.tray.destroy()
    app.quit()
  }

  deepLink(raw: string): void {
    const link: DeepLink = parseDeepLink(raw)
    if (link.kind === "unknown") return
    void this.open().then(() => this.window.send(link))
  }
})()

/* --- single instance ----------------------------------------------------------
 * Two shells means two servers against one SQLite file and two agents on one
 * bot directory. The second launch hands its argv to the first and exits. */

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on("second-instance", (_event, argv) => {
    const url = argv.find((arg) => arg.startsWith("evie://"))
    if (url === undefined) void shell.open()
    else shell.deepLink(url)
  })

  app.setAsDefaultProtocolClient("evie")

  // macOS delivers deep links as an event, not argv, and can deliver one before
  // `whenReady`; `MainWindow` buffers anything that arrives too early.
  app.on("open-url", (event, url) => {
    event.preventDefault()
    shell.deepLink(url)
  })

  // Tray-resident: closing the window is not quitting. This handler exists to
  // override Electron's default, which would quit on macOS-unlike platforms.
  app.on("window-all-closed", () => {})

  app.on("activate", () => void shell.open())

  app.on("before-quit", () => {
    ;(app as Quittable).isQuitting = true
  })

  /*
   * The server must not outlive the shell.
   *
   * Electron runs `before-quit` for a menu quit and a Cmd-Q, and nothing at all
   * for a signal -- so a `kill` of the shell, or a terminal that closes during
   * development, left a server holding the port and the SQLite file with no
   * parent to stop it. That is the orphan every "address already in use" on the
   * next launch traces back to.
   *
   * SIGKILL is still unreachable; nothing portable survives it. Everything a
   * person or a process manager actually sends is covered here.
   */
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => {
      // Synchronous, before anything is awaited -- see `EvieServer.stopNow`.
      shell.server.stopNow()
      ;(app as Quittable).isQuitting = true
      app.quit()
    })
  }

  ipcMain.on(CHANNEL.windowClose, () => shell.window.browserWindow?.hide())
  ipcMain.on(CHANNEL.windowMinimize, () => shell.window.browserWindow?.minimize())
  ipcMain.on(CHANNEL.windowButtonPosition, (_event, position: { x: number; y: number } | null) => {
    const window = shell.window.browserWindow
    if (window === null || window.isDestroyed() || process.platform !== "darwin") return
    // Guard the cast: this arrives from the renderer, which serves content the
    // agent produced. A bad payload here throws inside Electron's native layer.
    if (position === null) {
      window.setWindowButtonPosition(null)
      return
    }
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) return
    window.setWindowButtonPosition({ x: Math.round(position.x), y: Math.round(position.y) })
  })

  ipcMain.on(CHANNEL.windowZoom, () => {
    const window = shell.window.browserWindow
    if (window === null || window.isDestroyed()) return
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })

  void app.whenReady().then(async () => {
    // The dock icon comes from the bundle when packaged; running from a
    // checkout there is no bundle, so it is set explicitly or the dock shows
    // Electron's own atom.
    const icon = nativeImage.createFromPath(appIcon)
    if (!icon.isEmpty()) app.dock?.setIcon(icon)
    app.setAboutPanelOptions({
      applicationName: "Evie",
      applicationVersion: app.getVersion(),
      credits: "A minimal GUI for eve agents.",
    })

    shell.tray.create()
    try {
      const handle = await shell.server.start()
      await shell.window.show(handle.claimUrl)
    } catch (error) {
      // The status handler has already shown the error box; the tray stays up
      // so the user can quit, or restart once they have fixed the cause.
      process.stderr.write(`[shell] server failed to start: ${String(error)}\n`)
    }
  })
}
