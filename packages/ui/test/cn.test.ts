import { describe, expect, it } from "vitest"
import { cn } from "../src/lib/utils.ts"

describe("cn", () => {
  it("keeps a colour and a font size that both look like text-*", () => {
    // The invisible "Sign in" button: the size must not evict the colour.
    expect(cn("bg-fg text-surface", "text-body")).toContain("text-surface")
    expect(cn("bg-fg text-surface", "text-body")).toContain("text-body")
  })

  it("still lets a later font size replace an earlier one", () => {
    const out = cn("text-ui", "text-body")
    expect(out).toContain("text-body")
    expect(out).not.toContain("text-ui")
  })

  it("still lets a later colour replace an earlier one", () => {
    const out = cn("text-fg", "text-fg-muted")
    expect(out).toContain("text-fg-muted")
    expect(out).not.toMatch(/(^| )text-fg( |$)/)
  })

  it("does not confuse custom radii", () => {
    const out = cn("rounded-pill", "rounded-small")
    expect(out).toBe("rounded-small")
  })
})
