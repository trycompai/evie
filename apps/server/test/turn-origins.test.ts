import type { SessionId, TurnId, UserId } from "@evie/contracts/ids"
import { ThreadStatus } from "@evie/contracts/thread"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { makeTurnOrigins } from "../src/provider/turn-origins.ts"

/**
 * Evie's turn ids and eve's turn references are different identifiers, and the
 * status chip is where mixing them up costs the most.
 *
 * `ThreadStatus.turnId` is a `TurnId` -- the ULID Evie mints on dispatch --
 * because that is the only id `CancelTurn` will match. The adapter used to put
 * eve's own reference there behind a cast: it type-checked, and then the frame
 * failed to encode on the wire. The stream carrying it died mid-turn, so the
 * assistant's reply was written to the database and delivered to nobody until
 * the client reconnected. The thread looked frozen and a reload "fixed" it.
 *
 * The encoding assertions are the point: projecting the wrong id was never the
 * visible half, the schema boundary one layer down was.
 */

const session = "wrun_01M01JGC6XK1ZDQSHS6PNWHXN3" as SessionId
const other = "wrun_01M01JGC6XK1ZDQSHS6PNWHXN4" as SessionId
const alice = "user_alice" as UserId
const bob = "user_bob" as UserId
const turnOne = "01M01KXE2QWMA6QBV9W81YBZRQ" as TurnId
const turnTwo = "01M01MRE8BT37X5TBGZYZ18S8B" as TurnId

const encodeStatus = Schema.encodeSync(ThreadStatus)

describe("the status a turn produces", () => {
  it("encodes with Evie's turn id", () => {
    expect(() => encodeStatus({ kind: "thinking", turnId: turnOne })).not.toThrow()
  })

  it("does not encode with eve's turn reference", () => {
    // The whole defect in one line. `turn_24` is what eve calls its turn.
    expect(() => encodeStatus({ kind: "thinking", turnId: "turn_24" as TurnId })).toThrow()
  })

  it("encodes with no turn at all", () => {
    // A turn this process did not dispatch: the composer offers Send, not Stop.
    expect(() => encodeStatus({ kind: "thinking", turnId: null })).not.toThrow()
  })
})

describe("turn origins", () => {
  it("pins a dispatch to the reference eve names it with", () => {
    const origins = makeTurnOrigins()
    origins.dispatched(session, { userId: alice, turnId: turnOne })
    origins.named(session, "turn_24")

    expect(origins.of(session, "turn_24")).toEqual({ userId: alice, turnId: turnOne })
  })

  it("hands out turns in dispatch order", () => {
    const origins = makeTurnOrigins()
    origins.dispatched(session, { userId: alice, turnId: turnOne })
    origins.dispatched(session, { userId: bob, turnId: turnTwo })
    origins.named(session, "turn_24")
    origins.named(session, "turn_25")

    expect(origins.of(session, "turn_24")?.turnId).toBe(turnOne)
    expect(origins.of(session, "turn_25")?.turnId).toBe(turnTwo)
  })

  it("knows nothing about a turn it never dispatched", () => {
    const origins = makeTurnOrigins()
    // The shape after a restart: eve resumes a turn this process never sent.
    origins.named(session, "turn_24")

    expect(origins.of(session, "turn_24")).toBeNull()
    expect(origins.of(session, null)).toBeNull()
  })

  it("keeps sessions apart", () => {
    const origins = makeTurnOrigins()
    origins.dispatched(session, { userId: alice, turnId: turnOne })
    origins.named(session, "turn_24")

    // eve numbers turns per session, so the same reference means two things.
    expect(origins.of(other, "turn_24")).toBeNull()
  })

  it("translates back, so cancelling names the turn eve knows", () => {
    const origins = makeTurnOrigins()
    origins.dispatched(session, { userId: alice, turnId: turnOne })
    origins.dispatched(session, { userId: alice, turnId: turnTwo })
    origins.named(session, "turn_24")
    origins.named(session, "turn_25")

    expect(origins.providerRef(session, turnTwo)).toBe("turn_25")
    expect(origins.providerRef(session, turnOne)).toBe("turn_24")
  })

  it("has no reference for a turn eve never named", () => {
    const origins = makeTurnOrigins()
    origins.dispatched(session, { userId: alice, turnId: turnOne })

    // Cancel then asks eve to stop whatever is running, which is the ask.
    expect(origins.providerRef(session, turnOne)).toBeNull()
  })
})
