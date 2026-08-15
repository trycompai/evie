import type { Bot } from "@evie/contracts/bot"
import { StorageUnavailable } from "@evie/contracts/errors"
import type { ThreadId } from "@evie/contracts/ids"
import type { Thread, ThreadStatus } from "@evie/contracts/thread"
import { TimelineItem, type TimelineFrame, type TimelineOp } from "@evie/contracts/timeline"
import type { FleetFrame } from "@evie/contracts/rpc"
import { truncatePayload } from "@evie/shared/truncate"
import { Context, Effect, Latch, Layer, Schema, Stream } from "effect"
import { Db } from "../db/Db.ts"

/**
 * The per-thread subscriber hub -- specs/03 "Frame budget", implemented exactly.
 *
 * **Demand-scheduled, not periodic.** A subscriber is a pull loop parked on a
 * latch: the first pending delta opens the latch, the loop then sleeps one
 * 50 ms window, drains the coalesced pending set into a single frame, and
 * closes the latch again. An idle thread has NO timer at all -- the obvious
 * `setInterval` per subscriber would wake the process 160 times a second for
 * eight idle threads and blow the "idle CPU ~0%" budget.
 *
 * The mailbox is the coalesced pending set itself, never a queue of frames:
 * inserts and replaces merge by item id, text deltas concatenate their
 * suffixes, reasoning keeps the latest count. Nothing that changes final state
 * is dropped, and nothing is ever queued twice -- which is what "bounded" means
 * here. When a window still overflows the byte/op budget three times in a row,
 * the subscriber is downgraded to summary mode (item state changes only, no
 * text deltas) and the frame says so, so the client can show a *catching up*
 * chip instead of a thread that looks frozen.
 *
 * The hub never writes. Publishing is a synchronous merge plus a latch open;
 * persistence happens on the publisher's own flush tick.
 */

const FLUSH_WINDOW = "50 millis"
/** Pending text bytes above which a window counts as overflowed. */
const MAX_PENDING_CHUNK_BYTES = 64 * 1024
/** Pending op count above which a window counts as overflowed. */
const MAX_PENDING_OPS = 512
/** Consecutive overflowed windows before the downgrade to summary mode. */
const OVERFLOW_STREAK_LIMIT = 3
/** Backfill page size: inserts per frame when resuming from `since`. */
const BACKFILL_OPS_PER_FRAME = 200
const BACKFILL_LIMIT = 2000

/** What the ingestion path (or a reactor) hands the hub for one thread. */
export interface ThreadPublish {
  readonly ops?: ReadonlyArray<TimelineOp>
  readonly status?: ThreadStatus
  /** Highest projection `seq` covered by this publish. The client's resume cursor. */
  readonly seq: number
}

/** Fleet-level deltas, already org-scoped by the publisher. */
export interface FleetPublish {
  readonly bots?: ReadonlyArray<Bot>
  readonly threads?: ReadonlyArray<Thread>
  readonly removedThreads?: ReadonlyArray<ThreadId>
}

export interface ThreadSubscribeOptions {
  /** Resume from this projection seq: the gap is replayed from the read model. */
  readonly since?: number
  /** Whether this connection opted into a specific reasoning block (`reasoning.watch`). */
  readonly watching: (itemId: string) => boolean
}

export interface HubShape {
  readonly publishThread: (threadId: ThreadId, publish: ThreadPublish) => Effect.Effect<void>
  readonly publishFleet: (orgId: string, publish: FleetPublish) => Effect.Effect<void>
  readonly subscribeThread: (
    threadId: ThreadId,
    options: ThreadSubscribeOptions,
  ) => Stream.Stream<TimelineFrame, StorageUnavailable>
  readonly subscribeFleet: (orgId: string) => Stream.Stream<FleetFrame>
  /** Last published status. In-memory only; `ready` for a thread nobody touched. */
  readonly statusOf: (threadId: string) => ThreadStatus
  /**
   * Threads with at least one live subscriber right now. This is what
   * `ClientPresence` reads to keep a watched bot's runtime warm.
   *
   * Subscription is the honest presence signal precisely because nobody has to
   * remember to end it: the set is maintained by `subscribeThread`'s own scope
   * finalizer, so a closed tab, a dropped socket and a killed client all
   * withdraw presence by the same path the stream already unwinds. A registry
   * fed by an explicit "I am leaving" call would leak a warm runtime every
   * time a client died without sending one -- which is every time a client
   * dies.
   */
  readonly watchedThreads: () => ReadonlySet<string>
}

/* --- pending state, one per subscriber ------------------------------------ */

interface PendingItem {
  kind: "insert" | "replace"
  item: TimelineItem
}

interface PendingText {
  readonly id: string
  readonly partIndex: number
  chunk: string
}

interface PendingReasoning {
  readonly id: string
  readonly partIndex: number
  tokens: number
  chunk: string | undefined
}

interface ThreadSubscriber {
  readonly threadId: ThreadId
  readonly latch: Latch.Latch
  readonly watching: (itemId: string) => boolean
  readonly items: Map<string, PendingItem>
  readonly texts: Map<string, PendingText>
  readonly reasonings: Map<string, PendingReasoning>
  status: ThreadStatus | undefined
  seq: number
  chunkBytes: number
  overflowed: boolean
  overflowStreak: number
  mode: "full" | "summary"
}

interface FleetSubscriber {
  readonly latch: Latch.Latch
  readonly bots: Map<string, Bot>
  readonly threads: Map<string, Thread>
  readonly removed: Set<ThreadId>
}

const partKey = (id: string, partIndex: number) => `${id}/${partIndex}`

/** Tool payloads over 8 KiB leave as head + tail; reasoning text leaves only for a watcher. */
const sanitizeItem = (item: TimelineItem, watching: (itemId: string) => boolean): TimelineItem => {
  if (item.kind === "tool") {
    const input = truncateJson(item.input)
    const output = truncateJson(item.output)
    if (!input.truncated && !output.truncated) return item
    return {
      ...item,
      ...(item.input === undefined ? {} : { input: input.value }),
      ...(item.output === undefined ? {} : { output: output.value }),
      truncated: true,
    }
  }
  if (item.kind === "assistant" || item.kind === "user") {
    if (!item.parts.some((part) => part.type === "reasoning" && part.text !== undefined)) return item
    if (watching(item.id)) return item
    return {
      ...item,
      parts: item.parts.map((part) =>
        part.type === "reasoning" && part.text !== undefined
          ? { type: "reasoning" as const, tokens: part.tokens }
          : part,
      ),
    }
  }
  return item
}

const truncateJson = (value: unknown): { readonly value: unknown; readonly truncated: boolean } => {
  if (value === undefined) return { value, truncated: false }
  const json = JSON.stringify(value)
  if (json === undefined) return { value, truncated: false }
  const result = truncatePayload(json)
  return result.truncated ? { value: result.value, truncated: true } : { value, truncated: false }
}

const mergeThread = (sub: ThreadSubscriber, publish: ThreadPublish): void => {
  if (publish.seq > sub.seq) sub.seq = publish.seq
  if (publish.status !== undefined) sub.status = publish.status
  for (const op of publish.ops ?? []) {
    switch (op.op) {
      case "insert":
      case "replace": {
        const item = sanitizeItem(op.item, sub.watching)
        // The full item subsumes any pending appends for it: its body already
        // carries everything appended before it was published.
        for (const key of sub.texts.keys()) {
          if (sub.texts.get(key)?.id === item.id) sub.texts.delete(key)
        }
        for (const key of sub.reasonings.keys()) {
          if (sub.reasonings.get(key)?.id === item.id) sub.reasonings.delete(key)
        }
        const existing = sub.items.get(item.id)
        // A pending insert stays an insert: this client has not seen the row yet.
        sub.items.set(item.id, { kind: existing?.kind ?? op.op, item })
        break
      }
      case "appendText": {
        sub.chunkBytes += op.chunk.length
        if (sub.mode === "summary") break
        const key = partKey(op.id, op.partIndex)
        const existing = sub.texts.get(key)
        if (existing === undefined) {
          sub.texts.set(key, { id: op.id, partIndex: op.partIndex, chunk: op.chunk })
        } else {
          existing.chunk += op.chunk
        }
        break
      }
      case "appendReasoning": {
        const chunk = sub.watching(op.id) ? op.chunk : undefined
        if (chunk !== undefined) sub.chunkBytes += chunk.length
        if (sub.mode === "summary") break
        const key = partKey(op.id, op.partIndex)
        const existing = sub.reasonings.get(key)
        if (existing === undefined) {
          sub.reasonings.set(key, { id: op.id, partIndex: op.partIndex, tokens: op.tokens, chunk })
        } else {
          existing.tokens = op.tokens
          if (chunk !== undefined) existing.chunk = (existing.chunk ?? "") + chunk
        }
        break
      }
    }
  }
  const opCount = sub.items.size + sub.texts.size + sub.reasonings.size
  if (sub.chunkBytes > MAX_PENDING_CHUNK_BYTES || opCount > MAX_PENDING_OPS) {
    sub.overflowed = true
  }
}

const drainThread = (sub: ThreadSubscriber): TimelineFrame => {
  const overflowedWindow = sub.overflowed
  sub.overflowed = false
  sub.overflowStreak = overflowedWindow ? sub.overflowStreak + 1 : 0
  if (sub.overflowStreak >= OVERFLOW_STREAK_LIMIT) {
    // Turn boundaries only from here: state changes still flow, text does not.
    // The dropped text comes back through each item's completing `replace`.
    sub.mode = "summary"
    sub.texts.clear()
    sub.reasonings.clear()
  } else if (!overflowedWindow) {
    sub.mode = "full"
  }

  const ops: Array<TimelineOp> = []
  // Inserts and replaces first, in seq order, so same-frame appends land on
  // rows the client already has.
  for (const pending of [...sub.items.values()].sort((a, b) => a.item.seq - b.item.seq)) {
    ops.push({ op: pending.kind, item: pending.item })
  }
  for (const text of sub.texts.values()) {
    ops.push({ op: "appendText", id: text.id, partIndex: text.partIndex, chunk: text.chunk })
  }
  for (const reasoning of sub.reasonings.values()) {
    ops.push({
      op: "appendReasoning",
      id: reasoning.id,
      partIndex: reasoning.partIndex,
      tokens: reasoning.tokens,
      ...(reasoning.chunk === undefined ? {} : { chunk: reasoning.chunk }),
    })
  }
  const frame: TimelineFrame = {
    threadId: sub.threadId,
    ops,
    ...(sub.status === undefined ? {} : { status: sub.status }),
    seq: sub.seq,
    mode: sub.mode,
  }
  sub.items.clear()
  sub.texts.clear()
  sub.reasonings.clear()
  sub.status = undefined
  sub.chunkBytes = 0
  sub.latch.closeUnsafe()
  return frame
}

const mergeFleet = (sub: FleetSubscriber, publish: FleetPublish): void => {
  for (const bot of publish.bots ?? []) sub.bots.set(bot.id, bot)
  for (const thread of publish.threads ?? []) {
    sub.threads.set(thread.id, thread)
    sub.removed.delete(thread.id)
  }
  for (const threadId of publish.removedThreads ?? []) {
    sub.threads.delete(threadId)
    sub.removed.add(threadId)
  }
}

const drainFleet = (sub: FleetSubscriber): FleetFrame => {
  const bots = [...sub.bots.values()]
  const threads = [...sub.threads.values()]
  const removed = [...sub.removed]
  sub.bots.clear()
  sub.threads.clear()
  sub.removed.clear()
  sub.latch.closeUnsafe()
  return {
    ...(bots.length === 0 ? {} : { bots }),
    ...(threads.length === 0 ? {} : { threads }),
    ...(removed.length === 0 ? {} : { removedThreads: removed }),
  }
}

/** Waits for demand, lets the 50 ms window fill, then drains one frame. */
const pull = <A>(latch: Latch.Latch, drain: () => A): Effect.Effect<A> =>
  latch.await.pipe(
    Effect.andThen(Effect.sleep(FLUSH_WINDOW)),
    Effect.andThen(Effect.sync(drain)),
  )

const decodeItem = Schema.decodeUnknownSync(TimelineItem)

/* --- the service ------------------------------------------------------------ */

const make = Effect.gen(function* () {
  const db = yield* Db
  const sql = db.sql

  const threadSubscribers = new Map<string, Set<ThreadSubscriber>>()
  const fleetSubscribers = new Map<string, Set<FleetSubscriber>>()
  const statuses = new Map<string, ThreadStatus>()

  const publishThread: HubShape["publishThread"] = (threadId, publish) =>
    Effect.sync(() => {
      if (publish.status !== undefined) statuses.set(threadId, publish.status)
      const subscribers = threadSubscribers.get(threadId)
      if (subscribers === undefined) return
      for (const sub of subscribers) {
        mergeThread(sub, publish)
        sub.latch.openUnsafe()
      }
    })

  const publishFleet: HubShape["publishFleet"] = (orgId, publish) =>
    Effect.sync(() => {
      const subscribers = fleetSubscribers.get(orgId)
      if (subscribers === undefined) return
      for (const sub of subscribers) {
        mergeFleet(sub, publish)
        sub.latch.openUnsafe()
      }
    })

  /**
   * The reconnect gap, replayed from the projection as insert ops. Frames
   * whose coalesced high-water `seq` predates the backfill are dropped by the
   * caller side implicitly: inserts are idempotent by item id, and the live
   * subscriber attached before the read, so nothing can fall in between.
   */
  const backfillFrames = Effect.fn("Hub.backfill")(function* (threadId: ThreadId, since: number) {
    const rows = yield* sql<{ body: string; seq: number | bigint }>`
      select body, seq from timeline_item
      where thread_id = ${threadId} and seq > ${since}
      order by seq asc limit ${BACKFILL_LIMIT}`
    const frames: Array<TimelineFrame> = []
    let ops: Array<TimelineOp> = []
    let maxSeq = since
    for (const row of rows) {
      maxSeq = Math.max(maxSeq, Number(row.seq))
      try {
        // The column is the position the `since` cursor is expressed in, so it
        // is the one the replayed item carries.
        ops.push({ op: "insert", item: decodeItem({ ...JSON.parse(row.body), seq: Number(row.seq) }) })
      } catch {
        // A row this build cannot decode is skipped, not fatal for the thread.
      }
      if (ops.length >= BACKFILL_OPS_PER_FRAME) {
        frames.push({ threadId, ops, seq: maxSeq, mode: "full" })
        ops = []
      }
    }
    if (ops.length > 0) frames.push({ threadId, ops, seq: maxSeq, mode: "full" })
    return frames
  })

  const subscribeThread: HubShape["subscribeThread"] = (threadId, options) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const sub: ThreadSubscriber = {
          threadId,
          latch: Latch.makeUnsafe(false),
          watching: options.watching,
          items: new Map(),
          texts: new Map(),
          reasonings: new Map(),
          status: undefined,
          seq: options.since ?? 0,
          chunkBytes: 0,
          overflowed: false,
          overflowStreak: 0,
          mode: "full",
        }
        // Attach before the backfill read so nothing published in between is
        // lost; the overlap is inserts, which are idempotent by id.
        let set = threadSubscribers.get(threadId)
        if (set === undefined) {
          set = new Set()
          threadSubscribers.set(threadId, set)
        }
        set.add(sub)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            const subscribers = threadSubscribers.get(threadId)
            subscribers?.delete(sub)
            if (subscribers?.size === 0) threadSubscribers.delete(threadId)
          }),
        )
        const backfill =
          options.since === undefined
            ? []
            : yield* backfillFrames(threadId, options.since).pipe(
                Effect.catchTag("SqlError", (error) =>
                  Effect.fail(new StorageUnavailable({ reason: error.message })),
                ),
              )
        const live = Stream.forever(Stream.fromEffect(pull(sub.latch, () => drainThread(sub))))
        return Stream.concat(Stream.fromIterable(backfill), live)
      }),
    ).pipe(Stream.scoped)

  const subscribeFleet: HubShape["subscribeFleet"] = (orgId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const sub: FleetSubscriber = {
          latch: Latch.makeUnsafe(false),
          bots: new Map(),
          threads: new Map(),
          removed: new Set(),
        }
        let set = fleetSubscribers.get(orgId)
        if (set === undefined) {
          set = new Set()
          fleetSubscribers.set(orgId, set)
        }
        set.add(sub)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            const subscribers = fleetSubscribers.get(orgId)
            subscribers?.delete(sub)
            if (subscribers?.size === 0) fleetSubscribers.delete(orgId)
          }),
        )
        return Stream.forever(Stream.fromEffect(pull(sub.latch, () => drainFleet(sub))))
      }),
    ).pipe(Stream.scoped)

  const statusOf: HubShape["statusOf"] = (threadId) =>
    statuses.get(threadId) ?? { kind: "ready" }

  // `threadSubscribers` deletes a thread's entry when its last subscriber
  // unwinds, so the key set is already exactly "watched right now".
  const watchedThreads: HubShape["watchedThreads"] = () => new Set(threadSubscribers.keys())

  return {
    publishThread,
    publishFleet,
    subscribeThread,
    subscribeFleet,
    statusOf,
    watchedThreads,
  } satisfies HubShape
})

export class Hub extends Context.Service<Hub, HubShape>()("Hub") {
  static readonly layer = Layer.effect(Hub, make)
}
