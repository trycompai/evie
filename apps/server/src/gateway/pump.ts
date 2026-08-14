import type { ThreadId } from "@evie/contracts/ids"
import type { TimelineItem, TimelineOp } from "@evie/contracts/timeline"
import { Effect, Layer, PubSub } from "effect"
import { EveAdapter, type ThreadDelta } from "../provider/EveAdapter.ts"
import { Hub } from "./hub.ts"

/**
 * The one subscriber of the adapter's delta hub, translating full projected
 * items into wire ops for the gateway's `Hub`. The adapter re-publishes an
 * item with its cumulative text on every eve delta; forwarding that verbatim
 * is the easiest way to make Evie feel slow (03, "Frame budget"), so this pump
 * diffs each item against the last version it forwarded and sends suffixes.
 */

interface TrackedItem {
  /** Per-part text, text parts only; null slots for non-text parts. */
  readonly texts: Array<string | null>
  /** Non-text parts and the rest of the item, encoded, to detect state changes. */
  readonly rest: string
}

/** The item minus what `texts` already tracks, for cheap change detection. */
const restOf = (item: TimelineItem): string =>
  JSON.stringify(item, (key, value: unknown) => (key === "text" ? undefined : value))

const textsOf = (item: TimelineItem): Array<string | null> =>
  "parts" in item ? item.parts.map((part) => (part.type === "text" ? part.text : null)) : []

const make = Effect.gen(function* () {
  const adapter = yield* EveAdapter
  const hub = yield* Hub
  const subscription = yield* PubSub.subscribe(adapter.deltas)

  // Live items still worth diffing. Entries are dropped as soon as an item
  // stops being appendable, so the map tracks in-flight turns, not history.
  const tracked = new Map<string, TrackedItem>()
  // Highest item seq forwarded per thread: the resume cursor status frames use.
  const threadSeq = new Map<string, number>()
  // Where a live reasoning chunk should land: the newest reasoning part seen
  // per (thread, turn), plus a running character count standing in for tokens
  // until the mirrored `reasoning.completed` row corrects it.
  const reasoningTarget = new Map<
    string,
    { itemId: string; partIndex: number; chars: number }
  >()

  const opsFor = (threadId: ThreadId, item: TimelineItem, turnId: string | null): Array<TimelineOp> => {
    const previous = tracked.get(item.id)
    const texts = textsOf(item)
    const rest = restOf(item)

    if ("parts" in item) {
      const lastReasoning = item.parts.reduce<number>(
        (found, part, index) => (part.type === "reasoning" ? index : found),
        -1,
      )
      if (lastReasoning >= 0 && turnId !== null) {
        const existing = reasoningTarget.get(`${threadId}/${turnId}`)
        reasoningTarget.set(`${threadId}/${turnId}`, {
          itemId: item.id,
          partIndex: lastReasoning,
          chars: existing?.itemId === item.id ? existing.chars : 0,
        })
      }
    }

    const appendable = item.kind === "assistant" && !("finishReason" in item && item.finishReason !== undefined)
    if (previous === undefined) {
      if (appendable) tracked.set(item.id, { texts, rest })
      return [{ op: "insert", item }]
    }

    // Pure text growth becomes suffix ops; anything else replaces the row.
    const grewOnly =
      previous.rest === rest &&
      texts.length === previous.texts.length &&
      texts.every((text, index) => {
        const before = previous.texts[index]
        if (text === null || before === null || before === undefined) return text === before
        return text.startsWith(before)
      })

    if (grewOnly) {
      const ops: Array<TimelineOp> = []
      texts.forEach((text, index) => {
        const before = previous.texts[index]
        if (text !== null && before !== null && before !== undefined && text.length > before.length) {
          ops.push({ op: "appendText", id: item.id, partIndex: index, chunk: text.slice(before.length) })
        }
      })
      tracked.set(item.id, { texts, rest })
      return ops
    }

    if (appendable) {
      tracked.set(item.id, { texts, rest })
    } else {
      tracked.delete(item.id)
    }
    return [{ op: "replace", item }]
  }

  const forward = (delta: ThreadDelta): Effect.Effect<void> => {
    switch (delta._tag) {
      case "rows": {
        return Effect.suspend(() => {
          const ops: Array<TimelineOp> = []
          let seq = threadSeq.get(delta.threadId) ?? 0
          for (const change of delta.changes) {
            if (change.kind !== "timeline") continue
            const item = change.row.item
            const turnId = "turnId" in item ? item.turnId : null
            ops.push(...opsFor(delta.threadId, item, turnId))
            if (item.seq > seq) seq = item.seq
          }
          if (ops.length === 0) return Effect.void
          threadSeq.set(delta.threadId, seq)
          return hub.publishThread(delta.threadId, { ops, seq })
        })
      }
      case "reasoning": {
        return Effect.suspend(() => {
          const target =
            delta.turnId === null ? undefined : reasoningTarget.get(`${delta.threadId}/${delta.turnId}`)
          if (target === undefined) return Effect.void
          target.chars += delta.text.length
          return hub.publishThread(delta.threadId, {
            ops: [
              {
                op: "appendReasoning",
                id: target.itemId,
                partIndex: target.partIndex,
                // ~4 chars/token until the persisted count lands with the row.
                tokens: Math.ceil(target.chars / 4),
                chunk: delta.text,
              },
            ],
            seq: threadSeq.get(delta.threadId) ?? 0,
          })
        })
      }
      case "status":
        return hub.publishThread(delta.threadId, {
          status: delta.status,
          seq: threadSeq.get(delta.threadId) ?? 0,
        })
    }
  }

  yield* Effect.forkScoped(
    Effect.gen(function* () {
      while (true) {
        const delta = yield* PubSub.take(subscription)
        yield* forward(delta)
      }
    }),
  )
})

/** Runs for the process lifetime; builds after `EveAdapter` and `Hub`. */
export const DeltaPumpLive = Layer.effectDiscard(make)
