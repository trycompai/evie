import { createLoader, createSerializer } from "nuqs/server"
import { describe, expect, it } from "vitest"
import { connectedAppsParser } from "../src/lib/url-state.ts"

/**
 * The query string holds one thing now -- the services picked during setup --
 * because the path holds everything that names a place. What is asserted here
 * is the round trip: half-finished setup survives a reload only if what the
 * screen writes is what it reads back.
 */

const serialize = createSerializer({ apps: connectedAppsParser })
const load = createLoader({ apps: connectedAppsParser })

describe("connected apps", () => {
  it("round-trips a selection made during setup", () => {
    expect(load(serialize({ apps: ["slack", "linear"] })).apps).toEqual(["slack", "linear"])
  })

  it("clears itself once nothing is picked", () => {
    expect(serialize({ apps: [] })).toBe("")
    expect(load("").apps).toEqual([])
  })
})
