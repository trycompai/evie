import { describe, expect, it } from "vitest"
import { gazeOffset } from "@evie/ui/lib/gaze"

/**
 * Where a bot's eyes land for a cursor at a given offset.
 *
 * The rest of `gaze.ts` is DOM plumbing a jsdom test can only pretend to
 * exercise -- `getBoundingClientRect` returns zeros here, so a "test" of the
 * frame loop would assert on geometry that does not exist. This is the part
 * that can be wrong while looking completely fine: the eyes still move, they
 * just move somewhere subtly incorrect, and no screenshot catches it.
 *
 * Full deflection is 3.0 x 2.2 mark units, fixed because it is a fact about the
 * drawing. Saturation defaults to the rail's 130px and is per-area.
 */
describe("where the eyes look", () => {
  it("stares dead ahead when the cursor is on the mark", () => {
    expect(gazeOffset(0, 0)).toEqual({ x: 0, y: 0 })
  })

  it("leans the full amount once the cursor is past saturation", () => {
    expect(gazeOffset(400, 0).x).toBeCloseTo(3.0, 5)
    expect(gazeOffset(0, -400).y).toBeCloseTo(-2.2, 5)
  })

  it("ramps rather than snapping, so a cursor drifting closer is tracked", () => {
    const near = gazeOffset(65, 0).x
    const far = gazeOffset(104, 0).x
    expect(near).toBeCloseTo(1.5, 5)
    expect(far).toBeCloseTo(2.4, 5)
    expect(near).toBeLessThan(far)
  })

  /*
   * The deflection ceiling is set by the triangle, the tightest of the six
   * shapes: its left edge has run in to x=6.87 by the time it reaches the top
   * of the slots, and the left slot starts at x=11.6. Nothing may push a slot
   * through the side of the face it lives in.
   */
  it("keeps the slots inside even the triangle", () => {
    const TRIANGLE_EDGE_AT_SLOT_TOP = 6.87
    const LEFT_SLOT_X = 11.6
    for (let degrees = 0; degrees < 360; degrees += 5) {
      const radians = (degrees * Math.PI) / 180
      const { x } = gazeOffset(Math.cos(radians) * 999, Math.sin(radians) * 999)
      expect(LEFT_SLOT_X + x).toBeGreaterThan(TRIANGLE_EDGE_AT_SLOT_TOP)
    }
  })

  /*
   * The reason the magnitude is normalised by distance instead of each axis
   * being clamped on its own. Clamping per axis pins a diagonal glance to the
   * corner of the travel box, so every mark looks at 45 degrees regardless of
   * where the cursor actually is -- a rail of bots all staring at the same
   * imaginary point.
   */
  it("points at the cursor on a diagonal, not at the corner of its travel box", () => {
    const { x, y } = gazeOffset(300, 300)
    expect(x / 3.0).toBeCloseTo(Math.SQRT1_2, 5)
    expect(y / 2.2).toBeCloseTo(Math.SQRT1_2, 5)
    expect(x).toBeLessThan(3.0)
  })

  /*
   * A band on the marketing page is ten times the rail's width. It stretches
   * the ramp rather than the ceiling, so the same drawing reads as attentive at
   * both scales instead of sitting pinned across a whole hero.
   */
  it("stretches the ramp for a wider area without moving the ceiling", () => {
    expect(gazeOffset(130, 0, 260).x).toBeCloseTo(1.5, 5)
    expect(gazeOffset(260, 0, 260).x).toBeCloseTo(3.0, 5)
    expect(gazeOffset(900, 0, 260).x).toBeCloseTo(3.0, 5)
    /* Same cursor, tighter area: already fully committed. */
    expect(gazeOffset(130, 0).x).toBeCloseTo(3.0, 5)
  })

  it("mirrors, so a cursor above looks up as far as one below looks down", () => {
    expect(gazeOffset(-90, -60)).toEqual({
      x: -gazeOffset(90, 60).x,
      y: -gazeOffset(90, 60).y,
    })
  })

  /* Sub-pixel jitter is not a glance. */
  it("ignores a cursor sitting on the mark's own centre", () => {
    expect(gazeOffset(0.4, 0.3)).toEqual({ x: 0, y: 0 })
  })
})
