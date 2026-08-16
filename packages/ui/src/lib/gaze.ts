/**
 * Bot eyes that follow the pointer.
 *
 * `gazeArea(options)` returns a ref callback. Hand it to the element whose
 * pointer movement the eyes should answer -- the app's rail, a section of the
 * marketing page -- and the `BotMark`s nearest the cursor inside it look at it.
 * Nothing else has to be wired: the marks are found in the DOM by class, so
 * `BotMark` stays a plain function with no hooks and no context, which is what
 * lets the landing site keep rendering it on the server.
 *
 * Only the nearest `watchers` of them react at once, so what travels across an
 * area is a small pool of attention rather than a wave. The marks it leaves
 * behind are eased back to centre by the same CSS transition that carries the
 * ones it reaches, so the edge of the pool is a handover rather than a snap.
 *
 * The budget in `docs/internals/performance.md` says nothing repaints
 * continuously, and this does not:
 *
 * - A still pointer schedules no frames. There is no loop, no timer, and an
 *   idle area costs exactly zero.
 * - A moving pointer schedules at most one frame, whatever the event rate --
 *   a 1000 Hz mouse still gets 120 writes a second, not 1000.
 * - Geometry is cached and re-read only when it can actually have changed. A
 *   frame does no layout reads beyond one scroll offset, and writes only to
 *   the handful of marks whose deflection actually changed.
 *
 * The easing is not here. The frame writes a target transform and
 * `.evie-gaze`'s CSS transition carries the eyes to it, which is what gives
 * them weight and what walks them home when the pointer leaves. Interpolating
 * in JS would cost a frame loop to buy something the compositor does for free.
 */

/** Marks whose eyes this owns. `BotMark` puts the class on every mark it draws. */
const EYES = ".evie-gaze"

/**
 * Full deflection, in the mark's 34-unit box.
 *
 * Authored in user units rather than px so a 34px rail avatar and a 72px hero
 * deflect by the same *proportion* of a face -- one drawing, one gaze, at every
 * size. Wider than tall because the slots have more room beside them than under
 * them, and because a face that mostly looks side to side reads as attentive
 * while one that rolls its eyes up and down reads as unwell.
 *
 * The ceiling is the triangle, which is the tightest shape by a distance: its
 * slots sit where the left edge has run in to x=6.9, and the left slot starts
 * at 11.6. 3.0 leaves ~1.7 units of wall at the corner that gets closest, and
 * more than that once the slot's 1.8 corner radius is taken into account. Going
 * past this does not read as livelier, it reads as eyes falling out of a face.
 *
 * Not an option, deliberately: it is a fact about the drawing, not a taste.
 */
const REACH_X = 3.0
const REACH_Y = 2.2

export interface GazeOptions {
  /**
   * How many marks answer the cursor at once.
   *
   * A whole rail turning to look in unison is a stadium crowd -- it reads as
   * one scripted effect rather than as twelve individuals, and the further ones
   * are all pinned at full deflection anyway, so their motion carries no
   * information. A small pool travels with the cursor instead: what you are
   * pointing at notices you, and the rest is minding its own business.
   */
  readonly watchers?: number
  /**
   * Distance in px past which a mark is looking as hard as it can.
   *
   * Scale it to the area. The rail is 280px wide and wants this short, so a
   * cursor in the far column has the near marks fully committed. A hero band is
   * ten times that and wants it long, or every mark on it sits pinned and the
   * only thing that ever changes is which way they point.
   */
  readonly saturate?: number
}

const DEFAULTS = { watchers: 3, saturate: 130 } as const

/**
 * How far the eyes deflect for a cursor `dx, dy` away, in mark units.
 *
 * Direction is exact and magnitude ramps to full at `saturate`, so a mark under
 * the cursor stares straight at it and one across the area leans the right way
 * without pinning. Normalising by distance rather than clamping each axis is
 * what keeps a diagonal glance pointing at the cursor instead of at the corner
 * of its own travel box.
 */
export const gazeOffset = (
  dx: number,
  dy: number,
  saturate: number = DEFAULTS.saturate,
): { readonly x: number; readonly y: number } => {
  const away = Math.hypot(dx, dy)
  if (away < 1) return { x: 0, y: 0 }
  const pull = Math.min(1, away / saturate) / away
  return { x: dx * pull * REACH_X, y: dy * pull * REACH_Y }
}

/**
 * Tracking is a pointer affordance. A touch device has no hovering cursor to
 * follow -- it would only ever see the eyes snap on tap -- and someone who
 * asked for less motion did not ask for this.
 */
const pointerLed = () =>
  typeof window !== "undefined" && window.matchMedia("(hover: hover) and (pointer: fine)").matches

/**
 * Builds a ref callback for a region the eyes watch.
 *
 * The returned function is safe to keep at module scope and hand to several
 * elements: every attach builds its own state, and React 19 calls the cleanup
 * it returns when that node detaches.
 */
export function gazeArea(options: GazeOptions = {}) {
  const watchers = options.watchers ?? DEFAULTS.watchers
  const saturate = options.saturate ?? DEFAULTS.saturate

  return function attach(root: HTMLElement | null): (() => void) | undefined {
    if (!root || !pointerLed()) return

    /** Eye group -> the centre of the mark it belongs to, in *page* px. */
    const aim = new Map<SVGGElement, { readonly x: number; readonly y: number }>()
    /** The marks currently deflected, so a frame only writes what it must. */
    const looking = new Set<SVGGElement>()
    /** Read live rather than at attach, so toggling the setting takes effect now. */
    const stillness = window.matchMedia("(prefers-reduced-motion: reduce)")

    let stale = true
    let frame = 0
    let pointerX = 0
    let pointerY = 0
    let following = false

    /*
     * Page coordinates, not client. A marketing page scrolls constantly, and in
     * client space every mark on it moves on every scroll event -- which would
     * mean re-measuring the whole area every frame the user scrolls with the
     * cursor over it. In page space a window scroll moves nothing, so the cache
     * survives it and `paint` corrects for the offset with a single read.
     *
     * The mark's own box is measured, not the eye group's. The eye group carries
     * the gaze transform, and `getBoundingClientRect` includes it, so aiming from
     * there would feed each frame's offset into the next frame's target and let
     * the eyes drift away from centre on their own.
     */
    const measure = () => {
      aim.clear()
      const originX = window.scrollX
      const originY = window.scrollY
      for (const eyes of root.querySelectorAll<SVGGElement>(EYES)) {
        const mark = eyes.ownerSVGElement
        if (!mark) continue
        const box = mark.getBoundingClientRect()
        if (box.width === 0) continue
        aim.set(eyes, {
          x: box.x + originX + box.width / 2,
          y: box.y + originY + box.height / 2,
        })
      }
      stale = false
    }

    /**
     * The `watchers` marks nearest the cursor, rebuilt each frame.
     *
     * A fixed pair of arrays rather than a sort of the whole area: this runs on
     * every frame the pointer moves, and a frame that allocates is a frame that
     * eventually collects.
     */
    const watching: (SVGGElement | null)[] = Array(watchers).fill(null)
    const watchingAway: number[] = Array(watchers).fill(Infinity)

    const rank = (eyes: SVGGElement, away: number) => {
      for (let i = 0; i < watchers; i++) {
        if (away >= watchingAway[i]!) continue
        for (let j = watchers - 1; j > i; j--) {
          watching[j] = watching[j - 1]!
          watchingAway[j] = watchingAway[j - 1]!
        }
        watching[i] = eyes
        watchingAway[i] = away
        return
      }
    }

    const lookAway = () => {
      for (const eyes of looking) eyes.style.transform = ""
      looking.clear()
    }

    const paint = () => {
      frame = 0
      /* Handing the eyes back to centre needs no geometry, so it reads none. */
      if (!following) {
        lookAway()
        return
      }
      if (stale) measure()

      /* The frame's one layout read, hoisted out of both loops below. */
      const atX = pointerX + window.scrollX
      const atY = pointerY + window.scrollY

      watching.fill(null)
      watchingAway.fill(Infinity)
      for (const [eyes, centre] of aim) {
        rank(eyes, Math.hypot(atX - centre.x, atY - centre.y))
      }

      /*
        A mark that has just dropped out of the pool has to be told to look
        away, or it keeps the last transform it was given and stares at a cursor
        that has moved on. Everything else is left alone -- writing centre to
        forty marks that were already centred is the cost this set exists to
        avoid on a page with screenshots all down it.
      */
      for (const eyes of looking) {
        if (!watching.includes(eyes)) eyes.style.transform = ""
      }
      looking.clear()

      for (const eyes of watching) {
        if (!eyes) continue
        const centre = aim.get(eyes)
        if (!centre) continue
        const { x, y } = gazeOffset(atX - centre.x, atY - centre.y, saturate)
        if (x === 0 && y === 0) {
          eyes.style.transform = ""
          continue
        }
        eyes.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`
        looking.add(eyes)
      }
    }

    const draw = () => {
      if (frame === 0) frame = requestAnimationFrame(paint)
    }

    const onMove = (event: PointerEvent) => {
      if (stillness.matches) return
      pointerX = event.clientX
      pointerY = event.clientY
      following = true
      draw()
    }

    /** One last frame to clear the transforms; the CSS transition walks them home. */
    const onLeave = () => {
      following = false
      draw()
    }

    /** Marks slid under a still pointer, so their aim has to be re-read. */
    const onShift = () => {
      stale = true
      if (following) draw()
    }

    /*
     * A window scroll is the one kind that costs nothing: the cache is in page
     * coordinates, so nothing has moved in it. The pointer has though -- it sat
     * still while the document slid under it -- so this still needs a frame,
     * just not a re-measure. Anything else scrolling is a real scroller (the
     * rail's own list) whose rows have genuinely moved.
     */
    const onScroll = (event: Event) => {
      if (event.target === document || event.target === window) {
        if (following) draw()
        return
      }
      onShift()
    }

    /*
     * A bot created while the pointer is already in the area would otherwise
     * have dead eyes until the next scroll.
     *
     * Direct children only, deliberately. `subtree: true` would also fire on
     * every preview a streaming turn rewrites, and with the pointer resting in
     * the rail that is a re-measure every frame -- the one case where this could
     * put layout reads in a frame callback. A row cannot change height from its
     * own content (both its lines truncate, the mark is a fixed 34px, and the
     * health dot is absolutely positioned), so a row appearing or leaving is the
     * only mutation that actually moves any aim.
     */
    const rows = new MutationObserver(onShift)
    rows.observe(root, { childList: true })

    root.addEventListener("pointermove", onMove, { passive: true })
    root.addEventListener("pointerleave", onLeave, { passive: true })
    /* `scroll` does not bubble, but it does capture, so this catches any scroller. */
    window.addEventListener("scroll", onScroll, { capture: true, passive: true })
    window.addEventListener("resize", onShift, { passive: true })

    return () => {
      rows.disconnect()
      root.removeEventListener("pointermove", onMove)
      root.removeEventListener("pointerleave", onLeave)
      window.removeEventListener("scroll", onScroll, { capture: true })
      window.removeEventListener("resize", onShift)
      if (frame) cancelAnimationFrame(frame)
    }
  }
}
