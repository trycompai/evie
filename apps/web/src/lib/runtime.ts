import { createContext, useContext } from "react"
import { createEvieClient } from "@evie/client-runtime/client"
import { makeCommands, type Commands } from "@evie/client-runtime/commands"
import { makePresence, type Presence } from "@evie/client-runtime/presence"
import { EvieStore } from "@evie/client-runtime/store"
import { createEvieAuthClient, type EvieAuthClient } from "@evie/client-runtime/auth"

/**
 * One client, one store, one set of command senders, created once at module
 * scope and handed to React through context.
 *
 * Module scope rather than a provider that builds it: a socket is not a render
 * result, and creating it inside a component means creating a second one under
 * StrictMode's double-invoke. The store outlives every component that reads it,
 * which is the whole point of an external store.
 */

export interface Runtime {
  readonly store: EvieStore
  readonly commands: Commands
  readonly presence: Presence
  readonly auth: EvieAuthClient
  /** Where the server lives. Same origin in the packaged app; proxied in dev. */
  readonly baseURL: string
}

export const resolveBaseURL = (): string => {
  // The desktop shell and `npx evie` both serve the bundle from the server, so
  // same-origin is right. A tryevie.ai tab dials an environment it was given.
  const configured = import.meta.env.VITE_EVIE_SERVER
  return typeof configured === "string" && configured.length > 0
    ? configured
    : globalThis.location.origin
}

const socketURL = (baseURL: string): string => {
  const url = new URL("/rpc", baseURL)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url.toString()
}

export function createRuntime(): Runtime {
  const baseURL = resolveBaseURL()

  // The store owns the connection: it builds the client with its own state
  // handler, so there is no moment where one of the two exists without the
  // other. See `EvieStore`'s constructor.
  const store = new EvieStore((onState) => createEvieClient({ url: socketURL(baseURL), onState }))

  return {
    store,
    commands: makeCommands(store.client),
    presence: makePresence(store.client, store),
    auth: createEvieAuthClient(baseURL),
    baseURL,
  }
}

const RuntimeContext = createContext<Runtime | null>(null)

export const RuntimeProvider = RuntimeContext.Provider

export function useRuntime(): Runtime {
  const runtime = useContext(RuntimeContext)
  if (!runtime) throw new Error("useRuntime called outside <RuntimeProvider>")
  return runtime
}
