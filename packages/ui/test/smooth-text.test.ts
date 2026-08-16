import { describe, expect, it } from "vitest"
import { advance, sliceVisible } from "@evie/ui/lib/smooth-text"

/**
 * The pacing math, which is the part that can be wrong while looking fine: the
 * text still streams, it just stalls on tails, jumps on tab return, or falls
 * ever further behind a fast model. The hook around it is rAF and
 * `useSyncExternalStore` plumbing a jsdom test can only pretend to exercise.
 *
 * The contract under test: a reply arriving at any rate settles at a constant
 * lag (200 ms of it) rather than a constant fraction, drains completely once
 * the wire goes quiet, and never reveals out of order or beyond the target.
 */
describe("how the backlog drains", () => {
  it("stands still when there is nothing to reveal", () => {
    expect(advance(10, 10, 16)).toBe(10)
  })

  it("reveals at least one character per frame, so tails never stall", () => {
    // 3 chars left at 60 fps: 3 * 16 / 200 rounds to 0, and rounding to zero
    // forever is a reply that ends mid-word.
    expect(advance(97, 100, 16)).toBeGreaterThan(97)
  })

  it("never overshoots the target", () => {
    expect(advance(99, 100, 16)).toBe(100)
    expect(advance(0, 5, 1000)).toBeLessThanOrEqual(5)
  })

  it("snaps when the target moves under what is shown", () => {
    // A `replace` op may rewrite a reply shorter; clinging to the old length
    // would slice past the end forever.
    expect(advance(500, 300, 16)).toBe(300)
  })

  it("drains a big lump proportionally, not a fixed dribble", () => {
    // 1000 chars of backlog at 60 fps: 1/12.5 of it per frame. A fixed-rate
    // typewriter here is seconds of lag on a fast model.
    expect(advance(0, 1000, 16)).toBe(80)
  })

  it("settles at constant lag whatever the arrival rate", () => {
    // Simulate a model landing `lump` chars every 50 ms wire frame while we
    // tick at 60 fps. Steady-state backlog should approach rate * 200 ms,
    // i.e. 4 lumps -- not grow without bound, not drain to zero mid-stream.
    for (const lump of [10, 40, 160]) {
      let target = 0
      let shown = 0
      let clock = 0
      let backlog = 0
      for (let frame = 0; frame < 600; frame++) {
        clock += 16
        if (clock % 48 === 0) target += lump // ~every 50 ms, in tick units
        shown = advance(shown, target, 16)
        backlog = target - shown
      }
      expect(backlog).toBeLessThan(lump * 5)
      expect(backlog).toBeGreaterThan(0)
    }
  })

  it("drains fully once the wire goes quiet", () => {
    let shown = 0
    let frames = 0
    while (shown < 500 && frames < 120) {
      shown = advance(shown, 500, 16)
      frames++
    }
    expect(shown).toBe(500)
    // Everything pending drains within roughly a second of the last delta.
    expect(frames).toBeLessThan(70)
  })

  it("caps what one frame may reveal, so a hidden tab catches up rather than replays", () => {
    // A 5 s gap is clamped to MAX_FRAME_MS (100 ms): half the backlog, not all
    // of it in one paint, and not 25x the backlog's worth of rounding error.
    expect(advance(0, 1000, 5000)).toBe(500)
  })
})

describe("where the visible slice may end", () => {
  it("returns the whole text at or past the end", () => {
    expect(sliceVisible("abc", 3)).toBe("abc")
    expect(sliceVisible("abc", 99)).toBe("abc")
  })

  it("returns nothing at or below zero", () => {
    expect(sliceVisible("abc", 0)).toBe("")
    expect(sliceVisible("abc", -1)).toBe("")
  })

  it("never splits a surrogate pair", () => {
    // "🙂" is two UTF-16 units; a cut between them paints U+FFFD for a frame.
    const text = "ok 🙂 done"
    const cut = sliceVisible(text, 4) // lands mid-emoji
    expect(cut).toBe("ok 🙂")
    expect([...cut].at(-1)).toBe("🙂")
  })

  it("cuts plain text exactly where asked", () => {
    expect(sliceVisible("hello", 2)).toBe("he")
  })
})
