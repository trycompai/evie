"use client"

import { gazeArea } from "@evie/ui/lib/gaze"

/**
 * A band of the page whose Evie marks watch the cursor.
 *
 * The second client component on the site, after `ThemeProvider`, and it earns
 * the bytes the same way: it is this file and nothing else. Children arrive as
 * a slot, so every section, screenshot, and mark under it stays a server
 * component -- the page still ships its markup rendered, and the only
 * JavaScript is the ~1KB that makes the eyes move.
 *
 * It renders the `<section>` itself rather than wrapping one, because a ref has
 * to sit on a real element and an extra box inside a band's flex column would
 * change the layout. `Section` in `primitives.tsx` hands off to this when its
 * `alive` prop is set, so the two stay one element with one class contract.
 *
 * **Why the screenshots work.** `ScreenFrame` marks its contents `inert`, so
 * nothing inside a screenshot can be a pointer target. That is fine and is the
 * reason this listens on the band rather than on the frame: `pointermove`
 * bubbles up to here whether it was aimed at a live element or at the section
 * behind an inert one, and the marks inside are still perfectly findable in the
 * DOM and writable. A screenshot that looks back at you is the point.
 */

/*
 * Long saturation, because a band is not a rail. At the rail's 130px every mark
 * on a 1200px hero would sit pinned at full deflection and the only thing that
 * ever changed would be which way they point. Four watchers rather than three:
 * a band holds the big mark and a screenshot full of small ones, and the pool
 * wants to be able to cover a face and its neighbours at once.
 */
const watch = gazeArea({ watchers: 4, saturate: 260 })

export interface GazeAreaProps {
  readonly id?: string
  readonly className?: string
  readonly children: React.ReactNode
}

export function GazeArea({ id, className, children }: GazeAreaProps) {
  return (
    <section id={id} ref={watch} className={className}>
      {children}
    </section>
  )
}
