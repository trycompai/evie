import type { StoredEvent } from "@evie/contracts/events"
import type { TimelineItem } from "@evie/contracts/timeline"
import { describe, expect, it } from "vitest"
import { diffItem, type TrackedItem } from "../src/gateway/timeline-diff.ts"
import { apply, emptyReadModel, type ReadModel } from "../src/domain/project.ts"

/**
 * A reply streams as suffixes, not as the whole message over and over.
 *
 * eve republishes the cumulative text on every delta and the gateway diffs it
 * down to what actually grew. That diff compares the row minus its text, so it
 * only works if a growing row is otherwise identical between deltas -- and it
 * was not: each delta carried eve's timestamp for that delta, so the row
 * changed every time and the diff chose `replace`, every time. A 2,000-word
 * reply sent every one of its prefixes down the socket.
 *
 * These tests run the two halves together, projection into diff, because
 * either one alone looks correct.
 */

const threadId = "01M01C46ZKX9GT28EFXEEK73ME"
const botId = "01M01C46XSV5ZYJTMYGN9G0GGW"

/** One mirrored eve event, at its own moment in time -- as eve stamps them. */
const mirrored = (eveType: string, payload: unknown, at: number): StoredEvent =>
  ({
    id: `evt_${at}`,
    orgId: "org_1",
    threadId,
    botId,
    at,
    actorUserId: "user_1",
    data: { _tag: "EveMirrored", threadId, botId, sessionId: "wrun_1", streamIndex: 1, eveType, payload },
  }) as unknown as StoredEvent

const project = (model: ReadModel, eveType: string, payload: unknown, at: number): TimelineItem => {
  const change = apply(model, mirrored(eveType, payload, at)).find(
    (candidate) => candidate.kind === "timeline",
  )
  if (change === undefined) throw new Error(`${eveType} projected no timeline row`)
  return (change as { row: { item: TimelineItem } }).row.item
}

const append = (messageSoFar: string) => ({
  messageSoFar,
  messageDelta: messageSoFar,
  sequence: 7,
  stepIndex: 0,
  turnId: "turn_7",
})

describe("a streaming reply", () => {
  it("sends the suffix, not the message again", () => {
    const model = emptyReadModel()
    let tracked: TrackedItem | undefined

    const first = diffItem(tracked, project(model, "message.appended", append("Hello"), 1_000))
    tracked = first.tracked ?? undefined
    expect(first.ops).toEqual([{ op: "insert", item: expect.objectContaining({ id: "turn_7/0/7" }) }])

    // The next delta lands 750 ms later, which is what used to change the row.
    const second = diffItem(tracked, project(model, "message.appended", append("Hello! What"), 1_750))
    tracked = second.tracked ?? undefined
    expect(second.ops).toEqual([
      { op: "appendText", id: "turn_7/0/7", partIndex: 0, chunk: "! What" },
    ])

    const third = diffItem(
      tracked,
      project(model, "message.appended", append("Hello! What can I help with?"), 2_500),
    )
    expect(third.ops).toEqual([
      { op: "appendText", id: "turn_7/0/7", partIndex: 0, chunk: " can I help with?" },
    ])
  })

  it("keeps the time the row first appeared", () => {
    const model = emptyReadModel()
    const first = project(model, "message.appended", append("Hello"), 1_000)
    const second = project(model, "message.appended", append("Hello there"), 9_999)

    // A message does not change when it was sent while it is being written.
    expect(second.at).toBe(first.at)
    expect(second.seq).toBe(first.seq)
  })

  it("replaces the row when the reply finishes", () => {
    const model = emptyReadModel()
    const tracked =
      diffItem(undefined, project(model, "message.appended", append("Hello"), 1_000)).tracked ??
      undefined

    const done = diffItem(
      tracked,
      project(
        model,
        "message.completed",
        { message: "Hello there", finishReason: "stop", sequence: 7, stepIndex: 0, turnId: "turn_7" },
        2_000,
      ),
    )

    // `finishReason` is a state change, so the whole row goes -- and the row
    // stops being tracked, because it can never grow again.
    expect(done.ops[0]?.op).toBe("replace")
    expect(done.tracked).toBeNull()
  })

  it("replaces the row when the text is rewritten rather than extended", () => {
    const model = emptyReadModel()
    const tracked =
      diffItem(undefined, project(model, "message.appended", append("Hello there"), 1_000))
        .tracked ?? undefined

    // A retried step re-emits the block under the same id from the start.
    const retried = diffItem(tracked, project(model, "message.appended", append("Sorry"), 2_000))
    expect(retried.ops[0]?.op).toBe("replace")
  })
})
