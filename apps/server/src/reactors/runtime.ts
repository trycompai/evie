import { createHash } from "node:crypto"
import type { ConcurrencyConflict } from "@evie/contracts/errors"
import type { ReactorName, StoredEvent } from "@evie/contracts/events"
import { Context, Effect, Latch, Layer, Schedule } from "effect"
import type { Scope } from "effect"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { Db } from "../db/Db.ts"
import { EventStore } from "../store/EventStore.ts"

/**
 * The durable-subscription loop every reactor runs (02, "Reactors resume; they
 * do not forget").
 *
 * A reactor reads forward from its `reactor_cursor.last_seq`, handles one
 * event, and advances the cursor **in the same transaction as anything the
 * handler wrote**. The in-memory wake signal below is a latency optimization on
 * top of that loop, never the system of record: a process that missed every
 * wake still catches up from its cursor, at boot and on the safety sweep.
 *
 * `seq` is monotonic but NOT contiguous -- a duplicate that lost to
 * `on conflict do nothing` consumed a seq and left a gap -- so the loop reads
 * `where seq > last_seq order by seq` and never waits for a specific value.
 */

/**
 * DB writes a handler wants committed atomically with its cursor advance.
 * Runs inside the loop's transaction; must contain no side effect that cannot
 * sit inside a short `BEGIN IMMEDIATE`. HTTP belongs in the handler itself.
 */
export type Commit = Effect.Effect<unknown, SqlError | ConcurrencyConflict>

export interface ReactorDefinition<E, R> {
  readonly name: ReactorName
  /**
   * Phase 1, outside any transaction: idempotent side effects (an eve
   * dispatch, a git commit). Returns phase 2 -- the writes to commit
   * atomically with the cursor -- or nothing when only the cursor moves.
   *
   * Idempotency is not optional: a crash between the side effect and the
   * cursor write replays this event. Receipts appended from a `Commit` must
   * carry a deterministic id (see `deriveUlid`) so the replayed append loses
   * to `on conflict do nothing` instead of duplicating.
   */
  readonly handle: (event: StoredEvent) => Effect.Effect<Commit | void, E, R>
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

/**
 * A deterministic ULID-shaped id from stable parts -- usually the triggering
 * event's id plus a role tag. This is what makes a replayed handler a no-op:
 * the same trigger always derives the same id, and the event table's
 * `(session_id, id)` key swallows the duplicate.
 *
 * Unlike a real ULID it is NOT time-ordered; its only job is identity. Never
 * use it where a projection leans on id order.
 */
export const deriveUlid = (...parts: ReadonlyArray<string>): string => {
  const digest = createHash("sha256").update(parts.join("\u0000")).digest()
  // ULID shape: first char 0-7 (3 bits), then 25 chars of 5 bits each.
  let out = CROCKFORD[digest[0]! & 0x07]!
  let bitBuffer = 0
  let bitCount = 0
  let index = 1
  while (out.length < 26) {
    bitBuffer = (bitBuffer << 8) | digest[index++]!
    bitCount += 8
    while (bitCount >= 5 && out.length < 26) {
      bitCount -= 5
      out += CROCKFORD[(bitBuffer >>> bitCount) & 31]!
      bitBuffer &= (1 << bitCount) - 1
    }
  }
  return out
}

export interface ReactorWakeShape {
  /**
   * Call after committing new event rows. Every appender must: the command
   * pipeline, mirror ingestion, the scheduler, and the loop itself after a
   * commit that appended receipts. Missing a call costs latency (the safety
   * sweep catches it), never correctness.
   */
  readonly notify: Effect.Effect<void>
  /** One latch per reactor loop. Closed by the loop before it reads, opened by `notify`. */
  readonly subscribe: Effect.Effect<Latch.Latch, never, Scope.Scope>
}

export class ReactorWake extends Context.Service<ReactorWake, ReactorWakeShape>()("ReactorWake") {
  static readonly layer = Layer.sync(ReactorWake, () => {
    const latches = new Set<Latch.Latch>()
    return {
      notify: Effect.sync(() => {
        for (const latch of latches) latch.openUnsafe()
      }),
      subscribe: Effect.gen(function* () {
        const latch = Latch.makeUnsafe(false)
        latches.add(latch)
        yield* Effect.addFinalizer(() => Effect.sync(() => latches.delete(latch)))
        return latch
      }),
    }
  })
}

const BATCH_SIZE = 100

/**
 * Backoff for a failing handler. After the schedule is exhausted the event is
 * skipped with a loud log rather than wedging every later event behind one
 * poison message -- the failure is already user-visible through the handler's
 * own surface (an unhealthy bot chip, a blocked routine), and a wedged reactor
 * would silently stop all of them.
 */
const handlerRetryPolicy = Schedule.exponential("250 millis").pipe(
  Schedule.jittered,
  Schedule.upTo({ times: 5 }),
)

/**
 * Catches the reactor up from its cursor, then forks the live loop into the
 * ambient scope. Returns only after catch-up, so a layer built from this
 * completes replay BEFORE anything layered on top (the gateway) starts -- a
 * server that was off for an hour catches up rather than starting clean.
 */
export const runReactor = <E, R>(
  definition: ReactorDefinition<E, R>,
): Effect.Effect<
  void,
  SqlError | ConcurrencyConflict,
  R | EventStore | Db | ReactorWake | Scope.Scope
> =>
  Effect.gen(function* () {
    const store = yield* EventStore
    const db = yield* Db
    const wake = yield* ReactorWake
    const latch = yield* wake.subscribe

    let lastSeq = yield* store.cursor.get(definition.name)

    const step = (event: StoredEvent) =>
      Effect.gen(function* () {
        const commit = yield* definition.handle(event).pipe(
          Effect.retry({ schedule: handlerRetryPolicy }),
          Effect.catchCause((cause) =>
            Effect.logError(
              `reactor ${definition.name}: giving up on event after retries`,
              { seq: event.seq, type: event.data._tag },
              cause,
            ).pipe(Effect.as(undefined)),
          ),
        )
        yield* db.retryLocked(
          db.withTransaction(
            Effect.gen(function* () {
              if (commit !== undefined) yield* commit
              yield* store.cursor.advance(definition.name, event.seq)
            }),
          ),
        )
        lastSeq = event.seq
        // The commit may have appended receipts other reactors are waiting on.
        if (commit !== undefined) yield* wake.notify
      })

    const drain = Effect.gen(function* () {
      while (true) {
        const batch = yield* store.readForward(lastSeq, BATCH_SIZE)
        if (batch.length === 0) return
        for (const event of batch) yield* step(event)
      }
    })

    // Replay everything owed before this effect resolves.
    yield* drain

    yield* Effect.forkScoped(
      Effect.gen(function* () {
        while (true) {
          // Close before reading: a notify that lands mid-drain reopens the
          // latch, so the await below falls through instead of losing the wake.
          yield* latch.close
          yield* drain
          // The sleep is a safety sweep for an appender that forgot to notify.
          yield* Effect.raceFirst(latch.await, Effect.sleep("30 seconds"))
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError(`reactor ${definition.name}: loop stopped`, cause),
        ),
      ),
    )
  })

/** A reactor as a layer: builds after catch-up, runs for the layer's lifetime. */
export const reactorLayer = <E, R, R2>(
  definition: Effect.Effect<ReactorDefinition<E, R>, never, R2>,
): Layer.Layer<
  never,
  SqlError | ConcurrencyConflict,
  Exclude<R | R2 | EventStore | Db | ReactorWake, Scope.Scope>
> => Layer.effectDiscard(Effect.flatMap(definition, runReactor))
