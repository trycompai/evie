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

const bridge: EvieBridge = {
  platform: process.platform,
  version: process.env["EVIE_SHELL_VERSION"] ?? "0.0.0",
  window: {
    close: () => ipcRenderer.send(CHANNEL.windowClose),
    minimize: () => ipcRenderer.send(CHANNEL.windowMinimize),
    zoom: () => ipcRenderer.send(CHANNEL.windowZoom),
  },
  onDeepLink: (handler) => subscribe<DeepLink>(CHANNEL.deepLink, handler),
  onServerStatus: (handler) => subscribe<ServerStatus>(CHANNEL.serverStatus, handler),
}

contextBridge.exposeInMainWorld("evie", bridge)
