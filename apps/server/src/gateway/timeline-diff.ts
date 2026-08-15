import type { TimelineItem, TimelineOp } from "@evie/contracts/timeline"

/**
 * One row's delta, as wire ops.
 *
 * The adapter re-projects a streaming row on every eve delta and republishes
 * it whole, cumulative text and all. Forwarding that verbatim is the easiest
 * way to make Evie feel slow (03, "Frame budget"): a reply's every prefix goes
 * over the socket, which is quadratic in its length. So each version is
 * compared against the last one forwarded, and pure text growth becomes a
 * suffix.
 *
 * The comparison is everything-except-the-text, which puts a quiet requirement
 * on the projection: a row that is only growing must be *identical* apart from
 * its text. It was not -- eve stamps each delta with its own time and the row
 * carried the newest one -- so the diff never once matched and every delta
 * shipped as a full replace. See `putItem` in `domain/project.ts`.
 */

export interface TrackedItem {
  /** Per-part text, text parts only; null slots for non-text parts. */
  readonly texts: ReadonlyArray<string | null>
  /** Non-text parts and the rest of the item, encoded, to detect state changes. */
  readonly rest: string
}

export interface ItemDiff {
  readonly ops: ReadonlyArray<TimelineOp>
  /** What to remember for the next delta; null once the row can no longer grow. */
  readonly tracked: TrackedItem | null
}

/** The item minus what `texts` already tracks, for cheap change detection. */
export const restOf = (item: TimelineItem): string =>
  JSON.stringify(item, (key, value: unknown) => (key === "text" ? undefined : value))

export const textsOf = (item: TimelineItem): Array<string | null> =>
  "parts" in item ? item.parts.map((part) => (part.type === "text" ? part.text : null)) : []

/** A finished assistant row will never grow again, so it stops being tracked. */
const isAppendable = (item: TimelineItem): boolean =>
  item.kind === "assistant" && !("finishReason" in item && item.finishReason !== undefined)

export const diffItem = (
  previous: TrackedItem | undefined,
  item: TimelineItem,
): ItemDiff => {
  const texts = textsOf(item)
  const rest = restOf(item)
  const appendable = isAppendable(item)

  if (previous === undefined) {
    return { ops: [{ op: "insert", item }], tracked: appendable ? { texts, rest } : null }
  }

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
    return { ops, tracked: { texts, rest } }
  }

  return { ops: [{ op: "replace", item }], tracked: appendable ? { texts, rest } : null }
}
