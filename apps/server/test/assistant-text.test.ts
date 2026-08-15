import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { TimelineItem } from "@evie/contracts/timeline"
import type { StoredEvent } from "@evie/contracts/events"
import { apply, emptyReadModel } from "../src/domain/project.ts"

/**
 * The bot's reply has to survive the schema boundary.
 *
 * This is the regression test for the defect that made Evie look broken while
 * every other part of it worked: eve produced the text, the model was billed
 * for it, `turn.completed` arrived -- and nothing was ever shown.
 *
 * `TimelineItem.turnId` was typed as `TurnId`, Evie's minted ULID, while the
 * value the projector puts there is the *provider's* turn reference, which eve
 * writes as `turn_7`. The projector cast to `TurnId`, so it type-checked; the
 * failure landed at `Schema.encodeSync` inside `persistTimeline`, which throws
 * rather than fails. That defect rolled back the whole ingest transaction, so
 * the stream cursor never advanced -- meaning the next attach re-read the same
 * events and threw again, forever, with nothing logged.
 *
 * Encoding is asserted rather than merely projecting, because projection alone
 * was never the broken half: `apply` produced a perfectly good row and the
 * schema rejected it one layer down.
 */

const CLOCK = 1_786_760_000_000
const threadId = "01M01C46ZKX9GT28EFXEEK73ME"
const botId = "01M01C46XSV5ZYJTMYGN9G0GGW"

/** One mirrored eve stream event, in the shape eve actually emits. */
const mirrored = (eveType: string, payload: unknown): StoredEvent =>
  ({
    id: "evt_01M01K3DGRCHC11D2ABCDEFGHJ",
    orgId: "org_1",
    threadId,
    botId,
    at: CLOCK,
    actorUserId: "user_1",
    data: { _tag: "EveMirrored", threadId, botId, sessionId: "wrun_1", streamIndex: 1, eveType, payload },
  }) as unknown as StoredEvent

const project = (eveType: string, payload: unknown) => {
  const changes = apply(emptyReadModel(), mirrored(eveType, payload))
  const change = changes.find((candidate) => candidate.kind === "timeline")
  return change === undefined ? undefined : (change as { row: { item: unknown } }).row.item
}

/** Exactly what `EveAdapter.persistTimeline` does, and where the defect surfaced. */
const encode = Schema.encodeSync(TimelineItem)

describe("an assistant reply", () => {
  const reply = {
    finishReason: "stop",
    message: "Hi again! What can I help you with?",
    sequence: 7,
    stepIndex: 0,
    // eve numbers its turns. This is not a ULID and never was.
    turnId: "turn_7",
  }

  it("projects to a timeline row", () => {
    const item = project("message.completed", reply) as { kind: string; parts: unknown }
    expect(item?.kind).toBe("assistant")
    expect(JSON.stringify(item?.parts)).toContain("What can I help you with?")
  })

  it("survives encoding, which is where it used to be thrown away", () => {
    const item = project("message.completed", reply)
    expect(() => encode(item as never)).not.toThrow()
  })

  it("reads the text out of the field eve actually sends", () => {
    // Not `text`. A completion carries `message`; reading the wrong name gave
    // a well-formed assistant row with an empty body.
    const item = project("message.completed", reply) as { parts: ReadonlyArray<{ text: string }> }
    expect(item.parts[0]?.text).toBe("Hi again! What can I help you with?")
  })

  it("prefers the cumulative field on a streaming delta", () => {
    const item = project("message.appended", {
      messageDelta: "! What can I help you with?",
      messageSoFar: "Hi again! What can I help you with?",
      sequence: 7,
      stepIndex: 0,
      turnId: "turn_7",
    }) as { parts: ReadonlyArray<{ text: string }> }
    expect(item.parts[0]?.text).toBe("Hi again! What can I help you with?")
  })

  it("keeps the provider's turn reference verbatim", () => {
    const item = project("message.completed", reply) as { turnId: string }
    expect(item.turnId).toBe("turn_7")
  })

  /* Streaming deltas take the same path, and broke the same way. */
  it("encodes a partial reply mid-stream", () => {
    const item = project("message.appended", {
      messageDelta: "Hi again",
      messageSoFar: "Hi again",
      sequence: 7,
      stepIndex: 0,
      turnId: "turn_7",
    })
    expect(item).toBeDefined()
    expect(() => encode(item as never)).not.toThrow()
  })
})
