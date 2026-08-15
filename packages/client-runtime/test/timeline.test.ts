import { describe, expect, it } from "vitest"
import type { TimelineFrame, TimelineItem } from "@evie/contracts/timeline"
import type { BotId, ThreadId, TurnId, UserId } from "@evie/contracts/ids"
import type { ThreadStatus } from "@evie/contracts/thread"
import { Timeline } from "../src/timeline.ts"

/**
 * These tests exist for one reason: the chat view's whole performance story is
 * "a frame changes the identity of exactly the items it touched, and nothing
 * else". That is invisible in a screenshot and invisible in a profile until a
 * thread is long, so it gets asserted directly.
 *
 * If someone rebuilds the item map on every frame, every test below still
 * passes on *content* and the identity ones fail. That is the point.
 */

const threadId = "01J000000000000000000THRD" as ThreadId
const botId = "01J0000000000000000000BOT" as BotId
const turnId = "01J000000000000000000TURN" as TurnId

const assistant = (id: string, seq: number, text: string): TimelineItem =>
  ({
    kind: "assistant",
    id,
    threadId,
    seq,
    at: seq,
    botId,
    turnId,
    parts: [{ type: "text", text }],
  }) as TimelineItem

/** A reply that has finished. `finishReason` is what makes it terminal. */
const finished = (id: string, seq: number, text: string): TimelineItem =>
  ({ ...assistant(id, seq, text), finishReason: "stop" }) as TimelineItem

const user = (id: string, seq: number, text: string): TimelineItem =>
  ({
    kind: "user",
    id,
    threadId,
    seq,
    at: seq,
    authorId: "01J00000000000000000USER" as UserId,
    parts: [{ type: "text", text }],
  }) as TimelineItem

const tool = (id: string, seq: number, name: string): TimelineItem =>
  ({
    kind: "tool",
    id,
    threadId,
    seq,
    at: seq,
    botId,
    turnId,
    callId: id,
    name,
    state: "running",
  }) as TimelineItem

const frame = (
  ops: TimelineFrame["ops"],
  seq: number,
  status?: ThreadStatus,
): TimelineFrame => ({
  threadId,
  ops,
  seq,
  mode: "full",
  ...(status ? { status } : {}),
})

const thinking: ThreadStatus = { kind: "thinking", turnId }
const ready: ThreadStatus = { kind: "ready" }

describe("Timeline", () => {
  it("appends a text delta as a suffix", () => {
    const timeline = new Timeline()
    timeline.apply(frame([{ op: "insert", item: assistant("a", 1, "Hello") }], 1))
    timeline.apply(frame([{ op: "appendText", id: "a", partIndex: 0, chunk: " world" }], 2))

    const item = timeline.get("a")
    expect(item?.kind).toBe("assistant")
    expect(item && "parts" in item && item.parts[0]).toEqual({ type: "text", text: "Hello world" })
  })

  it("leaves untouched rows referentially identical", () => {
    const timeline = new Timeline()
    timeline.apply(
      frame(
        [
          { op: "insert", item: assistant("a", 1, "first") },
          { op: "insert", item: assistant("b", 2, "second") },
          { op: "insert", item: assistant("c", 3, "third") },
        ],
        3,
      ),
    )
    const before = { a: timeline.get("a"), b: timeline.get("b"), c: timeline.get("c") }

    timeline.apply(frame([{ op: "appendText", id: "c", partIndex: 0, chunk: "!" }], 4))

    // The two rows above the streaming one must be the SAME OBJECT, or
    // TimelineRow's memo misses and React reconciles the whole list.
    expect(timeline.get("a")).toBe(before.a)
    expect(timeline.get("b")).toBe(before.b)
    expect(timeline.get("c")).not.toBe(before.c)
  })

  it("keeps the order array stable when only content changes", () => {
    const timeline = new Timeline()
    timeline.apply(frame([{ op: "insert", item: assistant("a", 1, "x") }], 1))
    const order = timeline.snapshot().order

    timeline.apply(frame([{ op: "appendText", id: "a", partIndex: 0, chunk: "y" }], 2))

    // A new order array re-renders the list container on every delta, which is
    // exactly the 2,000-memo-comparisons-per-frame problem.
    expect(timeline.snapshot().order).toBe(order)
  })

  it("returns a referentially stable snapshot until something thread-level changes", () => {
    const timeline = new Timeline()
    timeline.apply(frame([{ op: "insert", item: assistant("a", 1, "x") }], 1))

    // useSyncExternalStore compares by reference and loops forever if a getter
    // allocates. This is the assertion that catches that.
    expect(timeline.snapshot()).toBe(timeline.snapshot())

    timeline.apply(frame([{ op: "insert", item: assistant("b", 2, "y") }], 2))
    expect(timeline.snapshot().order).toEqual(["a", "b"])
  })

  it("treats a replayed insert as an update, not a duplicate", () => {
    const timeline = new Timeline()
    timeline.apply(frame([{ op: "insert", item: assistant("a", 1, "x") }], 1))
    // A resumed stream re-sends frames the client already applied. Overlap is
    // harmless by design; a second row for the same id is not.
    timeline.apply(frame([{ op: "insert", item: assistant("a", 1, "x") }], 1))

    expect(timeline.snapshot().order).toEqual(["a"])
  })

  it("orders by seq no matter what order the ops arrived in", () => {
    const timeline = new Timeline()
    timeline.apply(
      frame(
        [
          { op: "insert", item: assistant("later", 9, "b") },
          { op: "insert", item: assistant("earlier", 2, "a") },
        ],
        9,
      ),
    )
    expect(timeline.snapshot().order).toEqual(["earlier", "later"])
  })

  it("advances the reasoning count with or without the text", () => {
    const timeline = new Timeline()
    const item = {
      kind: "assistant",
      id: "r",
      threadId,
      seq: 1,
      at: 1,
      botId,
      turnId,
      parts: [{ type: "reasoning", tokens: 0 }],
    } as TimelineItem
    timeline.apply(frame([{ op: "insert", item }], 1))

    // A client that has not opted into this block still learns the count --
    // that is the whole contract: the count persists, the words do not.
    timeline.apply(frame([{ op: "appendReasoning", id: "r", partIndex: 0, tokens: 1200 }], 2))
    const withoutText = timeline.get("r")
    expect(withoutText && "parts" in withoutText && withoutText.parts[0]).toEqual({
      type: "reasoning",
      tokens: 1200,
    })

    timeline.apply(
      frame([{ op: "appendReasoning", id: "r", partIndex: 0, tokens: 1400, chunk: "hmm" }], 3),
    )
    const withText = timeline.get("r")
    expect(withText && "parts" in withText && withText.parts[0]).toEqual({
      type: "reasoning",
      tokens: 1400,
      text: "hmm",
    })
  })

  it("merges a hydrated page that overlaps what is already applied", () => {
    const timeline = new Timeline()
    timeline.apply(frame([{ op: "insert", item: assistant("b", 2, "two") }], 2))

    // A page fetched while a frame was in flight legitimately overlaps it.
    // Appending blindly puts "b" in `order` twice, which renders as the
    // conversation appearing duplicated.
    timeline.hydrate([assistant("a", 1, "one"), assistant("b", 2, "two")])

    expect(timeline.snapshot().order).toEqual(["a", "b"])
    expect(timeline.snapshot().order).toHaveLength(2)
  })

  it("prepends scroll-back history without disturbing what is on screen", () => {
    const timeline = new Timeline()
    timeline.hydrate([assistant("c", 3, "three"), assistant("d", 4, "four")])
    timeline.hydrate([assistant("a", 1, "one"), assistant("b", 2, "two")])
    expect(timeline.snapshot().order).toEqual(["a", "b", "c", "d"])
  })

  it("records the frame mode so the UI can say it is catching up", () => {
    const timeline = new Timeline()
    timeline.apply({ threadId, ops: [], seq: 5, mode: "summary" })
    expect(timeline.snapshot().mode).toBe("summary")
  })

  it("tracks the highest seq applied, for resume after a reconnect", () => {
    const timeline = new Timeline()
    timeline.apply(frame([], 7))
    // seq is monotonic but NOT contiguous -- a duplicate that lost to
    // `on conflict do nothing` consumes one and leaves a gap.
    timeline.apply(frame([], 11))
    expect(timeline.snapshot().lastSeq).toBe(11)
  })

  /*
   * The field the chat view draws its caret from. It is wrong in an invisible
   * way if it is inferred from the tail of `order` instead of read from the
   * ops, so it gets asserted against the case that breaks the guess: a tool row
   * arriving last.
   */
  describe("streamingId", () => {
    it("names the row the deltas are extending, not the last row", () => {
      const timeline = new Timeline()
      timeline.apply(frame([{ op: "insert", item: assistant("a", 1, "") }], 1, thinking))
      timeline.apply(frame([{ op: "appendText", id: "a", partIndex: 0, chunk: "hi" }], 2))
      expect(timeline.snapshot().streamingId).toBe("a")

      // A tool row lands after the reply it was called from. The reply is still
      // the thing streaming; the tool row is not, and never was.
      timeline.apply(frame([{ op: "insert", item: tool("t", 3, "bash") }], 3))
      expect(timeline.snapshot().streamingId).toBe("a")
    })

    it("clears when the reply finishes, on a frame that inserted nothing", () => {
      const timeline = new Timeline()
      timeline.apply(frame([{ op: "insert", item: assistant("a", 1, "hi") }], 1, thinking))
      timeline.apply(frame([{ op: "appendText", id: "a", partIndex: 0, chunk: "!" }], 2))

      // `replace` of a known id does not change the id set, so this frame is
      // the exact case where a snapshot that only invalidates on insert leaves
      // a caret blinking under a finished reply forever.
      const result = timeline.apply(frame([{ op: "replace", item: finished("a", 1, "hi!") }], 3))
      expect(timeline.snapshot().streamingId).toBeNull()
      expect(result.threadChanged).toBe(true)
    })

    it("clears when the turn leaves an in-flight state", () => {
      const timeline = new Timeline()
      timeline.apply(frame([{ op: "insert", item: assistant("a", 1, "") }], 1, thinking))
      timeline.apply(frame([{ op: "appendText", id: "a", partIndex: 0, chunk: "hi" }], 2))

      // Cancel, error, and a provider that dies mid-sentence all land here:
      // the row never gets a `finishReason` and only the status says so.
      timeline.apply(frame([], 3, ready))
      expect(timeline.snapshot().streamingId).toBeNull()
    })

    it("finds the unfinished reply on a client that opened mid-turn", () => {
      const timeline = new Timeline()
      // Hydrate, then a status-only frame: this client has the rows but saw
      // none of the chunks that built them.
      timeline.hydrate([user("u", 1, "go"), assistant("a", 2, "partial")])
      timeline.apply(frame([], 3, thinking))
      expect(timeline.snapshot().streamingId).toBe("a")
    })

    it("does not reach back into a finished turn for one", () => {
      const timeline = new Timeline()
      // The previous turn's reply is unfinished-looking only if you ignore that
      // a newer user message started a turn after it.
      timeline.hydrate([assistant("old", 1, "no finishReason"), user("u", 2, "again")])
      timeline.apply(frame([], 3, thinking))
      expect(timeline.snapshot().streamingId).toBeNull()
    })
  })
})
