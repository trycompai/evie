import { useState, useSyncExternalStore } from "react"

/**
 * Smooth reveal for streamed text.
 *
 * The wire is lumpy by design: the hub coalesces deltas into 50 ms frames to
 * keep a streaming turn under its byte budget, so a fast model lands thirty
 * characters at a time, three times the size of an animation frame apart. This
 * decouples what the reader sees from what the socket delivered: arriving text
 * goes into a backlog and is revealed a few characters per animation frame, so
 * the reply reads as writing rather than as slabs.
 *
 * The reveal rate is proportional to the backlog, which is the property that
 * makes it safe to ship without tuning per model: a reply arriving at R chars/s
 * settles at a constant `HORIZON_MS` of lag behind the wire regardless of R,
 * so a fast model still *feels* fast -- it writes faster, it never falls
 * further behind, and the drain after the last delta is a beat, not a crawl.
 *
 * Budget notes (`docs/internals/performance.md`):
 * - The rAF loop is bounded by the backlog. It arms when a delta lands, stops
 *   the moment the backlog drains or the subscriber detaches, and an idle
 *   thread schedules nothing. This is not a loop that re-arms unconditionally.
 * - One commit per animation frame, in the one row that is streaming -- the
 *   ceiling the budget already grants.
 * - Reduced motion means the lumps land as they arrive, unpaced.
 */

/** Steady-state lag between the wire and the glass. Two coalescing windows deep. */
const HORIZON_MS = 200

/**
 * The most stream time one frame may reveal. A tab that was hidden through half
 * a reply comes back to a fast catch-up, not to a replay of everything it missed.
 */
const MAX_FRAME_MS = 100

/**
 * Characters revealed after a `dtMs` frame, given `shown` of `target`.
 *
 * Drains `1/HORIZON_MS` of the backlog per ms, floored at one character per
 * frame so the tail never stalls, and snapping when the target has moved under
 * `shown` -- a `replace` op is allowed to rewrite a reply shorter.
 */
export const advance = (shown: number, target: number, dtMs: number): number => {
  const backlog = target - shown
  if (backlog <= 0) return target
  const dt = Math.min(Math.max(dtMs, 0), MAX_FRAME_MS)
  return Math.min(target, shown + Math.max(1, Math.round((backlog * dt) / HORIZON_MS)))
}

/**
 * The first `end` characters, without ever splitting a surrogate pair: a cut
 * through the middle of an emoji paints U+FFFD for a frame. `end` is a UTF-16
 * index, so the boundary is nudged one unit right when it would land mid-pair.
 */
export const sliceVisible = (text: string, end: number): string => {
  if (end >= text.length) return text
  if (end <= 0) return ""
  const last = text.charCodeAt(end - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? end + 1 : end)
}

/** Read live rather than cached, so toggling the OS setting takes effect now. */
const still = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches

interface Pacer {
  readonly subscribe: (onChange: () => void) => () => void
  readonly snapshot: () => number
  readonly retarget: (text: string, pacing: boolean) => void
}

/**
 * One instance per hook, held in `useState` so it survives renders. It is an
 * external store in the `useSyncExternalStore` sense: the rAF tick advances
 * `shown` and notifies, React re-renders the one component that is subscribed.
 */
const createPacer = (initial: string): Pacer => {
  // Whatever exists at mount is history, not a stream. A client that opened or
  // reconnected mid-turn hydrates the full reply in one frame, and replaying
  // it as a typewriter would be a lie about what the model is doing right now.
  let shown = initial.length
  let target = initial.length
  let frame = 0
  let last = 0
  let notify: (() => void) | null = null

  const tick = (now: DOMHighResTimeStamp) => {
    frame = 0
    shown = advance(shown, target, now - last)
    last = now
    notify?.()
    // Re-arms only while there is backlog AND a committed subscriber -- the
    // two conditions that make this a drain, not a loop.
    if (shown < target && notify) frame = requestAnimationFrame(tick)
  }

  const arm = () => {
    if (frame !== 0 || shown >= target) return
    last = performance.now()
    frame = requestAnimationFrame(tick)
  }

  return {
    subscribe(onChange) {
      notify = onChange
      arm()
      return () => {
        notify = null
        if (frame) {
          cancelAnimationFrame(frame)
          frame = 0
        }
      }
    },
    snapshot: () => shown,
    /*
     * Called during render, deliberately: the render *is* the delta arriving
     * (the store replaced the item, the row re-rendered), so this is the only
     * moment that knows the target moved. Everything it does is idempotent --
     * a StrictMode double render arms one frame, a discarded render arms a
     * frame whose tick notifies nobody and does not re-arm.
     */
    retarget(text, pacing) {
      target = text.length
      if (!pacing || target < shown || still()) {
        shown = target
        if (frame) {
          cancelAnimationFrame(frame)
          frame = 0
        }
        return
      }
      arm()
    },
  }
}

/**
 * The visible prefix of a streaming string.
 *
 * While `streaming`, text appended after mount is revealed a few characters per
 * animation frame instead of a 50 ms lump at a time. The moment `streaming`
 * goes false the full text returns -- at most `HORIZON_MS` of it was pending,
 * so the snap is a beat, and a caret typing after the model finished would be
 * the lying spinner in another costume.
 */
export function useSmoothText(text: string, streaming: boolean): string {
  const [pacer] = useState(() => createPacer(text))
  const shown = useSyncExternalStore(pacer.subscribe, pacer.snapshot, pacer.snapshot)
  pacer.retarget(text, streaming)
  return streaming ? sliceVisible(text, shown) : text
}
