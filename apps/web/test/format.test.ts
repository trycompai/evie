import { describe, expect, it } from "vitest"
import { formatDayDivider, formatRailTime, formatRelative } from "../src/lib/format.ts"

/**
 * Dates are formatted on the client, in the viewer's locale and zone, because a
 * server that pre-formats has to guess both and guesses wrong for every remote
 * client -- which is most of them.
 *
 * These assert the *ladder*, not the strings: which rung a timestamp lands on
 * is the logic, and `Intl` owns the rendering. Asserting "3:53 PM" would pin
 * the test to one locale and one clock format and tell us nothing about the
 * thing that can actually be wrong.
 */

/** A fixed "now" so the tests do not drift across midnight in CI. */
const NOW = new Date("2026-03-12T15:00:00").getTime()
const HOUR = 3_600_000
const DAY = 24 * HOUR

describe("formatRailTime", () => {
  it("shows a clock time for today", () => {
    // Same rung as Mail and Messages, because the rail is scanned the same way:
    // you are looking for "has this moved", not for a date.
    expect(formatRailTime(NOW - 2 * HOUR, NOW)).toMatch(/\d/)
    expect(formatRailTime(NOW - 2 * HOUR, NOW)).not.toBe("Yesterday")
  })

  it("says Yesterday for yesterday", () => {
    expect(formatRailTime(NOW - DAY, NOW)).toBe("Yesterday")
  })

  it("names the weekday inside the last week", () => {
    const label = formatRailTime(NOW - 3 * DAY, NOW)
    expect(label).not.toBe("Yesterday")
    expect(label).toMatch(/^[A-Za-z]+$/)
  })

  it("falls back to a date past a week", () => {
    const label = formatRailTime(NOW - 30 * DAY, NOW)
    expect(label).toMatch(/\d/)
    expect(label).not.toMatch(/^[A-Za-z]+$/)
  })

  it("crosses to Yesterday on the calendar boundary, not on a 24h window", () => {
    // 11pm last night and 1am this morning are two hours apart and belong on
    // different rungs. A `now - at > DAY` comparison gets this wrong every
    // evening, which is exactly when nobody is looking.
    const lateLastNight = new Date("2026-03-11T23:00:00").getTime()
    const earlyToday = new Date("2026-03-12T01:00:00").getTime()
    expect(formatRailTime(lateLastNight, NOW)).toBe("Yesterday")
    expect(formatRailTime(earlyToday, NOW)).not.toBe("Yesterday")
  })
})

describe("formatDayDivider", () => {
  it("leads with Today and keeps the clock", () => {
    const label = formatDayDivider(NOW - HOUR, NOW)
    expect(label.startsWith("Today ")).toBe(true)
    expect(label.length).toBeGreaterThan("Today ".length)
  })

  it("leads with Yesterday for yesterday", () => {
    expect(formatDayDivider(NOW - DAY, NOW).startsWith("Yesterday ")).toBe(true)
  })

  it("includes the year once it is far enough back", () => {
    expect(formatDayDivider(NOW - 400 * DAY, NOW)).toMatch(/202\d/)
  })
})

describe("formatRelative", () => {
  it("says just now inside the first minute", () => {
    expect(formatRelative(NOW - 10_000, NOW)).toBe("just now")
  })

  it("singularises", () => {
    expect(formatRelative(NOW - 60_000, NOW)).toBe("1 minute ago")
    expect(formatRelative(NOW - 2 * HOUR, NOW)).toBe("2 hours ago")
  })

  it("gives up on relative past a day", () => {
    // "37 hours ago" is arithmetic the reader has to do. A date is not.
    expect(formatRelative(NOW - 3 * DAY, NOW)).toMatch(/\d/)
    expect(formatRelative(NOW - 3 * DAY, NOW)).not.toMatch(/ago/)
  })
})
