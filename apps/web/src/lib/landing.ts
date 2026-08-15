import type { ThreadId } from "@evie/contracts/ids"
import type { FleetSnapshot } from "@evie/client-runtime/store"

/**
 * Where a window with no destination should open.
 *
 * Opening on a dead end is a small daily tax: the app is up, everything is
 * loaded, and it is asking you to click one more time to get back to the thing
 * you were doing. So the root resolves to the last conversation you touched
 * instead, and only shows an empty state when there genuinely is nothing.
 *
 * Pure and separate from the route so it can be tested without a router, and
 * because "where do I open" is the one piece of logic here worth being sure
 * about -- getting it wrong is what put people on the welcome screen.
 */

export type Landing =
  | { readonly to: "welcome" }
  | { readonly to: "thread"; readonly threadId: ThreadId }
  | { readonly to: "empty" }

/** Call only with a settled fleet: an unanswered one looks exactly like a new account. */
export function resolveLanding(fleet: FleetSnapshot): Landing {
  if (fleet.bots.length === 0) return { to: "welcome" }

  /*
   * Picked by comparing rather than by taking the head. The store does sort
   * threads by recency, but a landing that silently depended on that would
   * start opening the wrong conversation the day someone changed the merge --
   * and it would look like a data bug, not an ordering one.
   */
  let latest = null as { id: ThreadId; lastActivity: number } | null
  for (const thread of fleet.threads) {
    if (latest === null || thread.lastActivity > latest.lastActivity) {
      latest = { id: thread.id, lastActivity: thread.lastActivity }
    }
  }

  return latest === null ? { to: "empty" } : { to: "thread", threadId: latest.id }
}
