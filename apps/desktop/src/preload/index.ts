import { contextBridge, ipcRenderer } from "electron"
import { CHANNEL, type DeepLink, type EvieBridge, type ServerStatus } from "@evie/shared/desktop-bridge"

/**
 * The preload. Runs sandboxed with no Node access of its own beyond `electron`,
 * and hands the renderer exactly the surface in `bridge.ts` -- no `ipcRenderer`,
 * no `require`, no invoke-anything escape hatch.
 *
 * That matters more here than in most apps: the page this preloads is served
 * over loopback by a server whose whole job is running an agent with a shell in
 * the user's home directory. A generic `invoke(channel, ...args)` bridge would
 * make every future main-process handler reachable from any script that ever
 * gets injected into the page.
 */

/** Subscribes and hands back the unsubscribe, so callers need no cleanup ceremony. */
const subscribe = <T>(channel: string, handler: (value: T) => void): (() => void) => {
  const listener = (_event: unknown, value: T) => handler(value)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.off(channel, listener)
  }
}

/**
 * The shell's version, handed over as a launch argument.
 *
 * Not `process.env`: a sandboxed preload gets a stripped `process`, and reading
 * the environment there is the kind of thing that works in development and
 * returns undefined in a packaged build. `additionalArguments` is the channel
 * Electron provides for exactly this.
 */
const VERSION_FLAG = "--evie-version="
const version =
  process.argv.find((arg) => arg.startsWith(VERSION_FLAG))?.slice(VERSION_FLAG.length) ?? "0.0.0"

const bridge: EvieBridge = {
  platform: process.platform,
  version,
  window: {
    close: () => ipcRenderer.send(CHANNEL.windowClose),
    minimize: () => ipcRenderer.send(CHANNEL.windowMinimize),
    zoom: () => ipcRenderer.send(CHANNEL.windowZoom),
    // Plain numbers: everything crossing this bridge is structured-cloned, so
    // the payload is rebuilt here rather than forwarded by reference.
    setButtonPosition: (position) =>
      ipcRenderer.send(
        CHANNEL.windowButtonPosition,
        position === null ? null : { x: Math.round(position.x), y: Math.round(position.y) },
      ),
  },
  onDeepLink: (handler) => subscribe<DeepLink>(CHANNEL.deepLink, handler),
  onServerStatus: (handler) => subscribe<ServerStatus>(CHANNEL.serverStatus, handler),
}

contextBridge.exposeInMainWorld("evie", bridge)
