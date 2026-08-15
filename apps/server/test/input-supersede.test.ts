import { describe, expect, it } from "vitest"
import type { StoredEvent } from "@evie/contracts/events"
import type { BotId, OrgId, SessionId, ThreadId } from "@evie/contracts/ids"
import { ulid } from "@evie/shared/ulid"
import { apply, emptyReadModel, type ReadModel } from "../src/domain/project.ts"

/**
 * A typed reply overtakes a pending question.
 *
 * eve's default `turnPolicy` is "steer": a message sent while `input.requested`
 * is outstanding cancels the in-flight turn and hands the bot the reply as the
 * answer. The card for that request must not stay pending -- a pending card
 * after the bot has moved on accepts a second answer to a question nobody is
 * asking anymore, which is exactly the double-answer bug this pins.
 *
 * The sweep lives in the `MessageSent` projection and mirrors the one
 * `turn.cancelled` already does.
 */

const CLOCK = 1_700_000_000_000
const orgId = "org_1" as OrgId
const botId = ulid(CLOCK) as BotId
const threadId = ulid(CLOCK) as ThreadId
const sessionId = "sess_1" as SessionId

/** One mirrored `input.requested`, in eve's real shape. */
const requested = (requestId: string): StoredEvent =>
  ({
    id: ulid(CLOCK),
    orgId,
    threadId,
    botId,
    at: CLOCK,
    actorUserId: "user_1",
    data: {
      _tag: "EveMirrored",
      threadId,
      botId,
      sessionId,
      streamIndex: 1,
      eveType: "input.requested",
      payload: { requests: [{ requestId, prompt: "Which colour?", kind: "question" }] },
    },
  }) as unknown as StoredEvent

const answered = (requestId: string): StoredEvent =>
  ({
    id: ulid(CLOCK),
    orgId,
    threadId,
    botId: null,
    at: CLOCK + 1,
    actorUserId: "user_1",
    data: { _tag: "InputAnswered", threadId, requestId, optionId: "blue", scope: null },
  }) as unknown as StoredEvent

const messageSent = (text: string): StoredEvent =>
  ({
    id: ulid(CLOCK),
    orgId,
    threadId,
    botId: null,
    at: CLOCK + 2,
    actorUserId: "user_1",
    data: {
      _tag: "MessageSent",
      threadId,
      text,
      mentions: [],
      attachments: [],
      idempotencyKey: "k1",
    },
  }) as unknown as StoredEvent

const inputState = (model: ReadModel, requestId: string): string | undefined => {
  const timeline = model.timelines.get(threadId)
  const itemId = timeline?.inputByRequest.get(requestId)
  const item = itemId === undefined ? undefined : timeline?.items.get(itemId)?.item
  return item?.kind === "input" ? item.state : undefined
}

describe("a message while a question is pending", () => {
  it("cancels the pending request", () => {
    const model = emptyReadModel()
    apply(model, requested("req_1"))
    expect(inputState(model, "req_1")).toBe("pending")

    const changes = apply(model, messageSent("blue, please"))
    expect(inputState(model, "req_1")).toBe("cancelled")

    // The sweep is broadcast, not just folded: clients holding the pending
    // card need the replacement row.
    const swept = changes.filter(
      (change) => change.kind === "timeline" && change.row.item.kind === "input",
    )
    expect(swept).toHaveLength(1)
  })

  it("leaves answered requests as the record of their answer", () => {
    const model = emptyReadModel()
    apply(model, requested("req_1"))
    apply(model, answered("req_1"))

    apply(model, messageSent("and one more thing"))
    expect(inputState(model, "req_1")).toBe("answered")
  })
})
