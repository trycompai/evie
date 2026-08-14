import { useCallback, useSyncExternalStore } from "react"
import type { ThreadId } from "@evie/contracts/ids"
import type { TimelineItem } from "@evie/contracts/timeline"
import type { ConnectionState } from "@evie/client-runtime/client"
import type { FleetSnapshot } from "@evie/client-runtime/store"
import type { TimelineSnapshot } from "@evie/client-runtime/timeline"
import { deepLinkStore, type DeepLinkEvent } from "./desktop.ts"
import { useRuntime } from "./runtime.ts"

/**
 * The only way components read server state.
 *
 * `useSyncExternalStore` throughout: React commits once per batch rather than
 * once per delta, and there is no effect anywhere that syncs server state into
 * component state -- because component state never holds server state.
 *
 * Each getter below returns a cached object the store replaces only when that
 * slice actually changes. A getter that built a fresh object per call would
 * make `useSyncExternalStore` loop forever; it is the single easiest way to get
 * this wrong, and it is why the caching lives in the store rather than here.
 */

export function useConnection(): ConnectionState {
  const { store } = useRuntime()
  return useSyncExternalStore(store.subscribeConnection, store.getConnection)
}

/**
 * The fleet.
 *
 * Deliberately does NOT start the subscription. The fleet stream belongs to the
 * connection, not to whichever component happened to mount first: `runtime.ts`
 * arms it on every successful handshake. Starting it from render would mean a
 * render React discarded had still opened a stream, which concurrent rendering
 * makes a real possibility rather than a theoretical one.
 */
export function useFleet(): FleetSnapshot {
  const { store } = useRuntime()
  return useSyncExternalStore(store.subscribeFleet, store.getFleet)
}

/**
 * Thread-level state: the set of visible ids, the status chip, the frame mode.
 * Fires when the *set* changes, not when a row's content does.
 */
export function useThread(threadId: ThreadId): TimelineSnapshot {
  const { store } = useRuntime()
  const subscribe = useCallback((cb: () => void) => store.subscribeThread(threadId)(cb), [store, threadId])
  const snapshot = useCallback(() => store.getThreadSnapshot(threadId), [store, threadId])
  return useSyncExternalStore(subscribe, snapshot)
}

/**
 * One row.
 *
 * This is the hook that makes the perf budget reachable. A streaming turn
 * replaces one item object; only the component that subscribed to that id
 * re-renders, and the 1,999 rows above it never enter reconciliation.
 */
export function useTimelineItem(threadId: ThreadId, itemId: string): TimelineItem | undefined {
  const { store } = useRuntime()
  const subscribe = useCallback(
    (cb: () => void) => store.subscribeItem(threadId, itemId)(cb),
    [store, threadId, itemId],
  )
  const snapshot = useCallback(() => store.getItemSnapshot(threadId, itemId), [store, threadId, itemId])
  return useSyncExternalStore(subscribe, snapshot)
}

/**
 * The most recent `evie://` link the desktop shell delivered, or null.
 *
 * Always null in a browser -- the store is there, nothing ever writes to it.
 * Callers act on a *change* in `seq` during render rather than in an effect;
 * see `App`, which turns a new thread link into a selection.
 */
export function useDeepLink(): DeepLinkEvent | null {
  return useSyncExternalStore(deepLinkStore.subscribe, deepLinkStore.snapshot, () => null)
}
