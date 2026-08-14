import { useEffect } from "react"

/**
 * The one sanctioned `useEffect` in this codebase.
 *
 * Data fetching, subscription lifecycle, and derived values do not use effects
 * here: server state lives in an external store read with
 * `useSyncExternalStore`, and derived values are computed during render. What
 * is left is imperative DOM work with no declarative equivalent -- focus
 * management, and attaching an observer to something React does not model.
 *
 * Most of even that is better done with a ref callback, which React 19 lets you
 * return a cleanup from and which fires exactly when the node attaches. Reach
 * for this only when there is no node to hang the work off.
 */
export function useMountEffect(fn: () => void | (() => void)): void {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(fn, [])
}
