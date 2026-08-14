import { memo, useCallback, useRef, useState } from "react"
import type { ThreadId } from "@evie/contracts/ids"
import { TimelineRow, type TimelineRowCallbacks } from "@evie/ui/components/timeline-row"
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
 */

/** Before a row has been measured. Roughly one line of a bubble plus its padding. */
const ESTIMATED_ROW = 72
/** Rows rendered above and below the viewport, so a fast scroll does not show gaps. */
const OVERSCAN = 6

export interface TimelineProps extends TimelineRowCallbacks {
  readonly threadId: ThreadId
  readonly viewerId: string
  readonly nameOf?: (userId: string) => string | undefined
  /** The item currently receiving deltas, if any. Drives the caret. */
  readonly streamingId?: string
  /** Rendered above the first row: the day divider, a "load more" affordance. */
  readonly header?: React.ReactNode
}

export function Timeline({ threadId, viewerId, nameOf, streamingId, header, ...callbacks }: TimelineProps) {
  const { order } = useThread(threadId)

  const heights = useRef(new Map<string, number>())
  const viewport = useRef<HTMLDivElement | null>(null)
  const pinned = useRef(true)

  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
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
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
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

  const attachContent = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    const observer = new ResizeObserver(() => {
      const view = viewport.current
      if (view && pinned.current) view.scrollTop = view.scrollHeight
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

  const rowObserver = () => {
    observer.current ??= new ResizeObserver((entries) => {
      let moved = false
      for (const entry of entries) {
        const id = rowIds.current.get(entry.target)
        if (id === undefined) continue
        const next = (entry.target as HTMLElement).offsetHeight
        if (heights.current.get(id) === next) continue
        heights.current.set(id, next)
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
        heights.current.set(id, el.offsetHeight)
        ro.observe(el)
        return () => ro.unobserve(el)
      }
      refs.current.set(id, cached)
    }
    return cached
  }

  return (
    <div
      ref={attachViewport}
      onScroll={onScroll}
      className="min-h-0 flex-1 overflow-y-auto px-7 pt-5 pb-3"
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
              streaming={streamingId === id}
              {...callbacks}
            />
          </div>
        ))}
      </div>
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
