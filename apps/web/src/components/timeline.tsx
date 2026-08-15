import { memo, useCallback, useRef, useState } from "react"
import type { ThreadId } from "@evie/contracts/ids"
import { ArrowDownIcon } from "@evie/ui/components/icon"
import { TimelineRow, type TimelineRowCallbacks } from "@evie/ui/components/timeline-row"
import { cn } from "@evie/ui/lib/utils"
import { useThread, useTimelineItem } from "~/lib/hooks.ts"

/**
 * The virtualized thread.
 *
 * Two ideas carry the whole perf budget, and both are easy to undo by accident:
 *
 * 1. **The container renders when the set of ids changes; a row renders when
 *    its own item changes.** `useThread` gives the ids, `useTimelineItem` gives
 *    one item. A single thread-level subscription would re-render this
 *    component on every 50 ms frame and run 2,000 memo comparisons to discover
 *    that one row moved.
 *
 * 2. **Only what is on screen is mounted.** A 2,000-row thread mounts about
 *    thirty rows. Heights are measured when a row attaches and cached by item
 *    id, so scrolling back up does not re-measure and does not jump.
 *
 * There is no `useEffect` in this file. Measurement rides on a ref callback --
 * React 19 lets one return a cleanup -- and scroll is an event.
 *
 * Deliberately NOT `@evie/ui/components/message-scroller`: its items lean on
 * `content-visibility: auto`, which skips paint but still mounts every row, so
 * a 2,000-message thread would parse 2,000 markdown bodies on open. Idea 2
 * above is the whole reason that does not happen here. Swapping it in is fine
 * only with a measured pass on a long real thread.
 *
 * From `MessageScroller` this takes the one behaviour that survives contact with
 * a virtualizer: **a way back to the live edge.** Scrolling up disengages
 * follow-output, and without a control that says so the only way back is a
 * flick and a guess.
 *
 * Two of its behaviours are deliberately NOT here.
 *
 * **Anchored turns**, and the last-anchor opening position that comes with
 * them. The mechanism is a bottom spacer sized so the open turn can reach the
 * top of the viewport, and it was tried: it works, and it is wrong. Anchoring
 * only earns its keep when a reply is longer than the viewport, and in exactly
 * that case the spacer has shrunk to nothing before the reader could benefit
 * from it. What is left is the short-reply case, where it holds a screenful of
 * dead space open above the composer forever. It bought nothing and cost that.
 *
 * **`scroll-fade` on the viewport.** It masks the scroll container, and a mask
 * on the one surface in this app that scrolls two thousand rows re-rasterizes
 * the visible tile on every scroll tick. It is cosmetic; this list is not the
 * place to spend that.
 */

/** Before a row has been measured. Roughly one line of a bubble plus its padding. */
const ESTIMATED_ROW = 72
/** Rows rendered above and below the viewport, so a fast scroll does not show gaps. */
const OVERSCAN = 6

export interface TimelineProps extends TimelineRowCallbacks {
  readonly threadId: ThreadId
  readonly viewerId: string
  readonly nameOf?: (userId: string) => string | undefined
  /**
   * The item currently receiving deltas. Drives the caret.
   *
   * Optional because the store already knows -- the deltas name the row they
   * extend. The prop is an override for the gallery, which has no store.
   */
  readonly streamingId?: string
  /** Rendered above the first row: the day divider, a "load more" affordance. */
  readonly header?: React.ReactNode
}

export function Timeline({
  threadId,
  viewerId,
  nameOf,
  streamingId,
  header,
  ...callbacks
}: TimelineProps) {
  const { order, streamingId: liveId } = useThread(threadId)
  const streaming = streamingId ?? liveId

  const heights = useRef(new Map<string, number>())
  const viewport = useRef<HTMLDivElement | null>(null)
  const pinned = useRef(true)
  /**
   * Pixels the reader is owed, banked between a row being measured and the
   * offsets that measurement changes being committed. See `record`.
   */
  const shift = useRef(0)

  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  /**
   * Whether the reader is at the live edge. `pinned` is the ref the scroll
   * handler writes twenty times a second; this is the same fact as state,
   * flipped only when it crosses the threshold, because a button has to render.
   */
  const [atEdge, setAtEdge] = useState(true)
  /**
   * A revision counter, not data. Bumped only when a row that is NOT the last
   * one changes height, which is the only case that moves rows below it. The
   * last row grows constantly while a turn streams and moves nothing, so
   * re-deriving offsets for it would be twenty wasted passes a second for a
   * scroll position the content observer is about to overwrite anyway.
   */
  const [, revise] = useState(0)
  const bumpLayout = () => revise((n) => n + 1)

  // Offsets are derived during render, never stored. 2,000 additions is
  // microseconds and it cannot go stale, which a cached prefix-sum can.
  const offsets: number[] = new Array(order.length + 1)
  offsets[0] = 0
  for (let i = 0; i < order.length; i++) {
    offsets[i + 1] = offsets[i]! + (heights.current.get(order[i]!) ?? ESTIMATED_ROW)
  }
  const total = offsets[order.length]!

  const first = findIndex(offsets, scrollTop - OVERSCAN * ESTIMATED_ROW)
  const last = Math.min(order.length, findIndex(offsets, scrollTop + viewportHeight) + OVERSCAN + 1)
  const visible = order.slice(first, last)

  const onScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget
    setScrollTop(el.scrollTop)
    // 24px of slack: a user who has scrolled *almost* to the bottom still wants
    // to follow the stream, and an exact comparison never matches on a
    // fractional-pixel display.
    const edge = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    pinned.current = edge
    setAtEdge(edge)
  }, [])

  /**
   * Back to the live edge.
   *
   * Instant, not smoothed. A smooth scroll fires `onScroll` the whole way down,
   * and every one of those events reads a position that is not yet the bottom
   * and unpins -- so the button that just re-pinned would un-re-pin itself
   * before it arrived. It would also race the content observer, which writes
   * `scrollTop` directly whenever a streaming turn grows. Animating two
   * thousand rows past the eye was never the nice version of this anyway.
   */
  const jumpToEdge = useCallback(() => {
    const el = viewport.current
    if (!el) return
    pinned.current = true
    setAtEdge(true)
    el.scrollTop = el.scrollHeight
  }, [])

  /**
   * Observes the viewport for its own size, and the content for growth. When
   * the content grows and we are pinned, follow it. This is the whole
   * stick-to-bottom implementation: no timer, no rAF loop, and nothing runs
   * while the thread is idle.
   */
  const attachViewport = useCallback((el: HTMLDivElement | null) => {
    viewport.current = el
    if (!el) return
    const observer = new ResizeObserver(() => setViewportHeight(el.clientHeight))
    observer.observe(el)
    setViewportHeight(el.clientHeight)
    return () => observer.disconnect()
  }, [])

  /**
   * Follows the stream when pinned, and pays back `shift` when not.
   *
   * A `ResizeObserver` callback runs after layout and before paint, which is
   * the only moment both halves of a correction are true at once: the new
   * offsets are committed, and nothing has been drawn yet. Adjusting
   * `scrollTop` from the ref callback that took the measurement instead is a
   * frame too early -- the rows have not moved yet, and the browser clamps the
   * write against a content height that is about to change.
   */
  const attachContent = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    const observer = new ResizeObserver(() => {
      const view = viewport.current
      if (!view) return
      if (pinned.current) {
        view.scrollTop = view.scrollHeight
        shift.current = 0
        return
      }
      if (shift.current === 0) return
      view.scrollTop += shift.current
      shift.current = 0
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  /*
   * Row measurement: ONE observer for every row, and a ref callback per id that
   * is created once and reused.
   *
   * The obvious version -- a fresh arrow function per row per render, each
   * making its own ResizeObserver -- looks identical and is a scroll-time
   * disaster: `scrollTop` is state, so every scroll event re-renders this
   * component, every ref identity changes, and React detaches and reattaches
   * all thirty rows. That is thirty observer teardowns and thirty
   * constructions per scroll event, which is exactly the "long task during
   * streaming" the budget forbids.
   */
  const rowIds = useRef(new WeakMap<Element, string>())
  const refs = useRef(new Map<string, (el: HTMLDivElement | null) => (() => void) | undefined>())
  const observer = useRef<ResizeObserver | null>(null)

  // `isLast` is read at callback time, not baked into the closure: which row is
  // last changes as the thread grows, and a stale answer would skip the layout
  // pass for a row that has stopped being the bottom one.
  const lastId = order.length > 0 ? order[order.length - 1] : undefined
  const lastIdRef = useRef(lastId)
  lastIdRef.current = lastId

  /**
   * One row's real height, and the scroll correction it owes the reader.
   * Returns whether anything changed.
   *
   * **Measuring a row above the fold moves what is on screen.** A row enters
   * the window costed at `ESTIMATED_ROW` and reports its real height on attach;
   * a bubble of markdown is routinely five to ten times that. Correcting it
   * grows every offset below it, so the text in the viewport slides down by the
   * difference while `scrollTop` stays where it was -- and the slide reveals
   * more unmeasured rows, which correct, which slide again. That compounding is
   * why a scroll upward used to land somewhere unrelated: not a glitch, an
   * un-repaid debt. Banking the delta here and settling it in `attachContent`
   * is what makes measurement invisible.
   *
   * `+ prev` rather than a bare `<`: a row straddling the top edge grows
   * downward, so it moves the content below it and not the reader.
   */
  const record = (id: string, el: HTMLElement, next: number): boolean => {
    const prev = heights.current.get(id) ?? ESTIMATED_ROW
    if (prev === next) return false
    heights.current.set(id, next)
    const view = viewport.current
    if (view && !pinned.current && el.offsetTop + prev <= view.scrollTop) {
      shift.current += next - prev
    }
    return true
  }

  const rowObserver = () => {
    observer.current ??= new ResizeObserver((entries) => {
      let moved = false
      for (const entry of entries) {
        const id = rowIds.current.get(entry.target)
        if (id === undefined) continue
        const el = entry.target as HTMLElement
        if (!record(id, el, el.offsetHeight)) continue
        if (id !== lastIdRef.current) moved = true
      }
      if (moved) bumpLayout()
    })
    return observer.current
  }

  const measure = (id: string) => {
    let cached = refs.current.get(id)
    if (!cached) {
      cached = (el) => {
        if (!el) return undefined
        const ro = rowObserver()
        rowIds.current.set(el, id)
        // The bump matters as much as the measurement: without a render the
        // offsets stay estimated, the row keeps its wrong position, and the
        // correction lands on whatever scroll event happens to come next.
        if (record(id, el, el.offsetHeight) && id !== lastIdRef.current) bumpLayout()
        ro.observe(el)
        return () => ro.unobserve(el)
      }
      refs.current.set(id, cached)
    }
    return cached
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={attachViewport}
        onScroll={onScroll}
        /*
         * A scroll container is only keyboard-scrollable in Firefox unless it is
         * focusable, and this one is the whole conversation. `region` plus a name
         * also gets it into the rotor, which is how a screen reader user finds
         * the transcript without walking the rail.
         */
        role="region"
        aria-label="Conversation"
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto px-7 pt-5 pb-3 focus-visible:outline-none"
      >
        {header}
        <div ref={attachContent} style={{ height: total, position: "relative" }}>
          {visible.map((id, i) => (
            <div
              key={id}
              ref={measure(id)}
              // Absolute placement rather than a spacer div: a spacer changes
              // height as rows are measured and drags the scroll position with it.
              style={{ position: "absolute", top: offsets[first + i], left: 0, right: 0 }}
              className="pb-2"
            >
              <Row
                threadId={threadId}
                itemId={id}
                viewerId={viewerId}
                nameOf={nameOf}
                streaming={streaming === id}
                {...callbacks}
              />
            </div>
          ))}
        </div>
      </div>

      {/*
        Only while the reader is away from the live edge, and it transitions
        rather than appearing: a control that pops into existence under a moving
        cursor gets clicked by accident. One 150ms transition on show and hide,
        nothing running while it sits there.
      */}
      <button
        type="button"
        onClick={jumpToEdge}
        aria-hidden={atEdge}
        tabIndex={atEdge ? -1 : 0}
        className={cn(
          "absolute bottom-3 left-1/2 flex size-8 -translate-x-1/2 items-center justify-center rounded-full",
          "border border-line-subtle bg-raised text-fg shadow-sm",
          "transition-[opacity,scale] duration-150 ease-out",
          "hover:bg-raised-strong focus-visible:ring-2 focus-visible:ring-focus/50 focus-visible:outline-none",
          atEdge ? "pointer-events-none scale-95 opacity-0" : "scale-100 opacity-100",
        )}
      >
        <ArrowDownIcon size={16} />
        <span className="sr-only">Jump to the latest message</span>
      </button>
    </div>
  )
}

/**
 * One subscribed row.
 *
 * Memoized, and its only changing prop is the item it pulls from the store
 * itself. That is the arrangement that keeps a streaming turn to one
 * reconciliation per frame instead of two thousand.
 */
const Row = memo(function Row({
  threadId,
  itemId,
  viewerId,
  nameOf,
  streaming,
  ...callbacks
}: {
  readonly threadId: ThreadId
  readonly itemId: string
  readonly viewerId: string
  readonly nameOf?: (userId: string) => string | undefined
  readonly streaming: boolean
} & TimelineRowCallbacks) {
  const item = useTimelineItem(threadId, itemId)
  if (!item) return null
  return (
    <TimelineRow
      item={item}
      viewerId={viewerId}
      nameOf={nameOf}
      streaming={streaming}
      {...callbacks}
    />
  )
})

/** Last index whose offset is <= `y`. Binary search: the list can be long. */
const findIndex = (offsets: readonly number[], y: number): number => {
  if (y <= 0) return 0
  let low = 0
  let high = offsets.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (offsets[mid]! <= y) low = mid
    else high = mid - 1
  }
  return low
}
