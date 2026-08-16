import { describe, expect, it } from "vitest"
import { BOT_TONE_FILLS, BOT_TONES, defaultMark, markOf } from "@evie/ui/components/bot-mark"

/**
 * The tone palette grew from six neutrals to twelve. Two things must survive
 * that: a bot that never picked a face keeps the face it has always had, and
 * an avatar string written by a newer client still parses. Both fail quietly
 * -- the mark just draws something else -- so they get tests.
 */
describe("defaultMark", () => {
  it("still deals only the six neutral tones", () => {
    // A hundred ids covers every residue of the hash's modulus many times over.
    for (let i = 0; i < 100; i++) {
      const { tone } = defaultMark(`01J${i}QZKX8G3T${i}`)
      expect(tone).toBeGreaterThanOrEqual(1)
      expect(tone).toBeLessThanOrEqual(6)
    }
  })

  it("keeps the exact faces bots were dealt before the palette grew", () => {
    // Pinned outputs from the six-tone era. If widening the palette changed
    // these, every default-marked bot in every fleet just changed colour.
    expect(defaultMark("01JBOT0000000000000000000A")).toEqual({ shape: "circle", tone: 4 })
    expect(defaultMark("01JBOT0000000000000000000B")).toEqual({ shape: "blob", tone: 4 })
    expect(defaultMark("bot")).toEqual({ shape: "hexagon", tone: 3 })
  })
})

describe("markOf", () => {
  it("accepts every tone the picker offers, hues included", () => {
    for (const tone of BOT_TONES) {
      expect(markOf({ id: "x", avatar: `hexagon:${tone}` })).toEqual({ shape: "hexagon", tone })
    }
  })

  it("falls back to the stable default on a tone this build does not know", () => {
    const bot = { id: "01JSOMEBOT", avatar: "hexagon:99" }
    expect(markOf(bot)).toEqual(defaultMark(bot.id))
  })

  it("has a swatch for every tone, so the picker cannot offer an unpaintable one", () => {
    for (const tone of BOT_TONES) {
      expect(BOT_TONE_FILLS[tone]).toMatch(/^var\(--color-/)
    }
  })
})
