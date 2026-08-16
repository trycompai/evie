import { describe, expect, it } from "vitest"
import {
  buildCron,
  DEFAULT_CADENCE,
  describeCron,
  formatClock,
  fromTimeInput,
  isFiveField,
  toTimeInput,
} from "@evie/ui/lib/cron"

/**
 * The sentence a routine row shows instead of `0 9 * * 1-5`.
 *
 * The property that matters is the round trip: every cadence the editor can
 * build must come back out as words. If it does not, the editor has quietly
 * produced a schedule its own list cannot describe, and the person who set it
 * is reading a raw cron expression to find out what they chose.
 *
 * The other half is the refusal. `describeCron` is called while rendering, so
 * it never throws and never guesses -- an expression outside the grammar comes
 * back verbatim rather than as a confident, wrong sentence.
 */

describe("describing a cadence", () => {
  it("says every cadence the editor can build in words", () => {
    const cadences = [
      { ...DEFAULT_CADENCE, kind: "minutes" as const, every: 15 },
      { ...DEFAULT_CADENCE, kind: "hourly" as const, minute: 30 },
      { ...DEFAULT_CADENCE, kind: "daily" as const, hour: 9, minute: 0 },
      { ...DEFAULT_CADENCE, kind: "weekdays" as const, hour: 17, minute: 45 },
      { ...DEFAULT_CADENCE, kind: "weekly" as const, weekday: 3, hour: 8, minute: 5 },
    ]
    for (const cadence of cadences) {
      const cron = buildCron(cadence)
      expect(isFiveField(cron), `${cadence.kind} builds 5 fields`).toBe(true)
      // The fallback returns the expression itself, so "described" means
      // "came back as something other than the cron".
      expect(describeCron(cron), `${cadence.kind} is described`).not.toBe(cron)
    }
  })

  it("names the shapes a person actually picks", () => {
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes")
    expect(describeCron("*/1 * * * *")).toBe("Every minute")
    expect(describeCron("30 * * * *")).toBe("Hourly at :30")
    expect(describeCron("0 9 * * *")).toBe(`Daily at ${formatClock(9, 0)}`)
    expect(describeCron("0 9 * * 1-5")).toBe(`Weekdays at ${formatClock(9, 0)}`)
    expect(describeCron("5 8 * * 3")).toBe(`Every Wednesday at ${formatClock(8, 5)}`)
    expect(describeCron("0 6 1 * *")).toBe(`Monthly on the 1st at ${formatClock(6, 0)}`)
    expect(describeCron("0 6 22 * *")).toBe(`Monthly on the 22nd at ${formatClock(6, 0)}`)
    expect(describeCron("0 6 11 * *")).toBe(`Monthly on the 11th at ${formatClock(6, 0)}`)
  })

  it("hands back anything it cannot say, rather than guessing", () => {
    // Step and list syntax are legal cron this grammar does not cover. Showing
    // the expression is honest; calling it "Daily" would not be.
    for (const cron of ["0 9 * * 1,3,5", "0 */2 * * *", "0 9 1 6 *", "@daily", "0 9 * *"]) {
      expect(describeCron(cron)).toBe(cron)
    }
  })

  it("rejects out-of-range fields instead of formatting them", () => {
    expect(describeCron("99 9 * * *")).toBe("99 9 * * *")
    expect(describeCron("0 41 * * *")).toBe("0 41 * * *")
    expect(describeCron("0 9 * * 9")).toBe("0 9 * * 9")
  })
})

describe("counting cron fields", () => {
  it("accepts exactly five, whatever the spacing", () => {
    expect(isFiveField("0 9 * * 1-5")).toBe(true)
    expect(isFiveField("  0   9  *  *  1-5  ")).toBe(true)
  })

  it("rejects anything else, which is the decider's rule too", () => {
    expect(isFiveField("0 9 * *")).toBe(false)
    expect(isFiveField("0 9 * * 1-5 2026")).toBe(false)
    expect(isFiveField("")).toBe(false)
  })
})

describe("the time field", () => {
  it("round-trips through the input's HH:MM", () => {
    expect(toTimeInput(9, 5)).toBe("09:05")
    expect(fromTimeInput("09:05")).toEqual({ hour: 9, minute: 5 })
    expect(fromTimeInput(toTimeInput(23, 59))).toEqual({ hour: 23, minute: 59 })
  })

  it("refuses a time that is not one", () => {
    expect(fromTimeInput("24:00")).toBeNull()
    expect(fromTimeInput("09:60")).toBeNull()
    expect(fromTimeInput("9am")).toBeNull()
    expect(fromTimeInput("")).toBeNull()
  })
})
