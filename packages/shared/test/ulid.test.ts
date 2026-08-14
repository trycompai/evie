import { describe, expect, it } from "vitest"
import { isUlid, ulid, ulidTime } from "../src/ulid.ts"

describe("ulid", () => {
  it("sorts lexicographically by time", () => {
    const early = ulid(1_700_000_000_000)
    const late = ulid(1_700_000_001_000)
    expect(early < late).toBe(true)
  })

  it("stays monotonic inside one millisecond", () => {
    // This is the property the whole thing exists for. An ingestion flush mints
    // a burst of ids in the same millisecond, and fresh randomness per id would
    // scramble the order of the batch it is supposed to preserve.
    const now = 1_700_000_000_000
    const ids = Array.from({ length: 500 }, () => ulid(now))
    const sorted = [...ids].sort()
    expect(ids).toEqual(sorted)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("round-trips its timestamp", () => {
    const now = 1_700_000_123_456
    expect(ulidTime(ulid(now))).toBe(now)
  })

  it("is 26 Crockford base32 characters", () => {
    const id = ulid()
    expect(id).toHaveLength(26)
    expect(isUlid(id)).toBe(true)
    // I, L, O, and U are excluded so a transcribed id cannot be misread.
    expect(/[ILOU]/.test(id)).toBe(false)
  })

  it("rejects things that only look like one", () => {
    expect(isUlid("not-a-ulid")).toBe(false)
    expect(isUlid(ulid().slice(0, 25))).toBe(false)
    expect(isUlid(`8${ulid().slice(1)}`)).toBe(false) // time field overflows past 7
  })
})
