import { describe, expect, it } from "vitest"
import { slugify, uniqueSlug, withSuffix } from "../src/slug.ts"

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Chief of Staff")).toBe("chief-of-staff")
  })

  it("folds accents rather than dropping them", () => {
    // "rsum" would be a worse slug than "resume", and it is what a naive
    // [^a-z0-9] strip produces.
    expect(slugify("Résumé Reader")).toBe("resume-reader")
  })

  it("never leaves a leading or trailing hyphen", () => {
    expect(slugify("  --Ops!!  ")).toBe("ops")
  })

  it("falls back rather than producing an empty slug", () => {
    // A bot named entirely in a non-Latin script still needs an addressable
    // slug. The display name is untouched and the suffix makes it unique.
    expect(slugify("日本語")).toBe("bot")
  })

  it("truncates without leaving a dangling hyphen", () => {
    const slug = slugify("a".repeat(40) + " " + "b".repeat(40))
    expect(slug.length).toBeLessThanOrEqual(48)
    expect(slug.endsWith("-")).toBe(false)
  })
})

describe("uniqueSlug", () => {
  it("returns the plain slug when it is free", () => {
    expect(uniqueSlug("Ops", new Set())).toBe("ops")
  })

  it("counts up past every collision", () => {
    // Two bots called "Chief of Staff" in one organization is a normal thing to
    // want. The user should not be told no.
    const taken = new Set(["chief-of-staff", "chief-of-staff-2", "chief-of-staff-3"])
    expect(uniqueSlug("Chief of Staff", taken)).toBe("chief-of-staff-4")
  })

  it("truncates the base to make room for the suffix", () => {
    const long = "x".repeat(60)
    const suffixed = withSuffix(slugify(long), 12)
    expect(suffixed.length).toBeLessThanOrEqual(48)
    expect(suffixed.endsWith("-12")).toBe(true)
  })
})
