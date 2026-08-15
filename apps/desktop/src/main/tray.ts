import { Menu, Tray, nativeImage } from "electron"
import { trayIcon } from "./paths.ts"
import type { ServerStatus } from "@evie/shared/desktop-bridge"

/**
 * The menu bar item, and the only place Evie can actually be quit.
 *
 * Tray-resident is the product decision, not a packaging detail: a bot that
 * stops the moment you close its window is a chat box, and the whole premise is
 * that work continues while you are not looking. Closing the window hides it;
 * this menu is where you stop the server.
 *
 * It also carries the server's state, because when the server is down the
 * window cannot tell you so -- it is a page served by that server.
 */

const statusLabel = (status: ServerStatus): string => {
  switch (status.kind) {
    case "starting":
      return "Starting…"
    case "ready":
      return `Running on ${status.origin.replace(/^https?:\/\//, "")}`
    case "restarting":
      return `Restarting (attempt ${status.attempt})…`
    case "failed":
      // Names what "Reveal Log in Finder" below opens. This said "see Console"
      // until there was a log -- advice to go and read somewhere the shell had
      // never written a word.
      return "Stopped — see the log"
  }
}

export interface TrayActions {
  readonly onOpen: () => void
  readonly onRestart: () => void
  readonly onRevealLog: () => void
  readonly onQuit: () => void
}

export class EvieTray {
  #tray: Tray | null = null
  #status: ServerStatus = { kind: "starting" }

  constructor(private readonly actions: TrayActions) {}

  create(): void {
    // A template image is a black-and-alpha mask that macOS recolours for the
    // menu bar, so it stays legible in light mode, dark mode, and inverted.
    const icon = nativeImage.createFromPath(trayIcon)
    icon.setTemplateImage(true)
    const tray = new Tray(icon)
    tray.setToolTip("Evie")
    this.#tray = tray
    this.#render()
  }

  status(status: ServerStatus): void {
    this.#status = status
    this.#render()
  }

  destroy(): void {
    this.#tray?.destroy()
    this.#tray = null
  }

  #render(): void {
    const tray = this.#tray
    if (tray === null || tray.isDestroyed()) return
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: statusLabel(this.#status), enabled: false },
        { type: "separator" },
        { label: "Open Evie", accelerator: "Command+O", click: this.actions.onOpen },
        { label: "Restart Server", click: this.actions.onRestart },
        { label: "Reveal Log in Finder", click: this.actions.onRevealLog },
        { type: "separator" },
        // The only exit. `window-all-closed` deliberately does not quit.
        { label: "Quit Evie", accelerator: "Command+Q", click: this.actions.onQuit },
      ]),
    )
  }
}
