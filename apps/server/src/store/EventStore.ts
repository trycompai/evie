import { ConcurrencyConflict } from "@evie/contracts/errors"
import { EvieEvent, type ReactorName, StoredEvent } from "@evie/contracts/events"
import { ulid } from "@evie/shared/ulid"
import { Context, Effect, Layer, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"

/**
 * The append-only event log.
 *
 * Two kinds of rows share the table: product events Evie mints
 * (`session_id = ''`) and mirror rows of eve's stream (`session_id` = the eve
 * session). Idempotency is `(session_id, id)` with `on conflict do nothing`; a
 * duplicate that loses still consumed a `seq`, so `seq` is monotonic but NOT
 * contiguous and readers must never wait for a specific next value.
 *
 * The optimistic-concurrency **version of an aggregate is its count of product
 * events**. Mirror rows are ingestion, not decisions: they append without an
 * `expectedVersion` and never move the version a decider folded at.
 */

/**
 * Which aggregate a batch belongs to. Unlike the contracts' `AggregateRef`,
 * `org` carries its id here -- the store cannot read it from a session.
 */
export interface AggregateKey {
  readonly kind: "bot" | "thread" | "org"
  readonly id: string
}

export interface AppendInput {
  readonly data: EvieEvent
  readonly orgId: string
  readonly threadId?: string | null
  readonly botId?: string | null
  readonly actorUserId?: string | null
  /** eve's `meta.id` for mirror rows. Minted with `ulid()` when absent. */
  readonly id?: string
  /** The eve session for mirror rows. `''` (a product event) when absent. */
  readonly sessionId?: string
  readonly streamIndex?: number | null
  readonly at?: number
}

export interface AppendOptions {
  readonly aggregate: AggregateKey
  /**
   * The version the decider folded at. Omit only on the mirror-ingestion path,
   * which has no decision to guard.
   */
  readonly expectedVersion?: number
}

export interface EventStoreShape {
  readonly append: (
    events: ReadonlyArray<AppendInput>,
    options: AppendOptions,
  ) => Effect.Effect<ReadonlyArray<StoredEvent>, ConcurrencyConflict | SqlError>
  /** Product events of one aggregate, in order, with the version they fold to. */
  readonly readAggregate: (
    aggregate: AggregateKey,
  ) => Effect.Effect<{ events: ReadonlyArray<StoredEvent>; version: number }, SqlError>
  /** The reactor read path. `seq` gaps are normal; read strictly forward. */
  readonly readForward: (
    fromSeq: number,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<StoredEvent>, SqlError>
  readonly cursor: {
    readonly get: (reactor: ReactorName) => Effect.Effect<number, SqlError>
    /**
     * Joins the ambient transaction when called inside `withTransaction` --
     * the client keys transactions on context, so the cursor advances
     * atomically with whatever the reactor's handler wrote.
     */
    readonly advance: (reactor: ReactorName, seq: number) => Effect.Effect<void, SqlError>
  }
}

const encodeEvent = Schema.encodeSync(EvieEvent)
const decodeStored = Schema.decodeUnknownSync(StoredEvent)

interface EventRow {
  readonly id: string
  readonly session_id: string
  readonly seq: number | bigint
  readonly org_id: string
  readonly thread_id: string | null
  readonly bot_id: string | null
  readonly actor_user_id: string | null
  readonly stream_index: number | bigint | null
  readonly type: string
  readonly data: string
  readonly at: number | bigint
}

const rowToStored = (row: EventRow): StoredEvent =>
  decodeStored({
    id: row.id,
    sessionId: row.session_id,
    seq: Number(row.seq),
    orgId: row.org_id,
    threadId: row.thread_id,
    botId: row.bot_id,
    actorUserId: row.actor_user_id,
    streamIndex: row.stream_index === null ? null : Number(row.stream_index),
    data: JSON.parse(row.data),
    at: Number(row.at),
  })

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // One writer per process, so a plain counter is the whole seq allocator.
  // Seeded from the table; a lost `on conflict` insert leaves the gap the
  // schema documents.
  const seeded = yield* sql<{ max_seq: number | bigint | null }>`
    select max(seq) as max_seq from event`
  let nextSeq = Number(seeded[0]?.max_seq ?? 0) + 1

  const aggregateFilter = (aggregate: AggregateKey) =>
    aggregate.kind === "bot"
      ? sql`bot_id = ${aggregate.id}`
      : aggregate.kind === "thread"
        ? sql`thread_id = ${aggregate.id}`
        : sql`org_id = ${aggregate.id}`

  const currentVersion = Effect.fn("EventStore.currentVersion")(function* (
    aggregate: AggregateKey,
  ) {
    const rows = yield* sql<{ n: number | bigint }>`
      select count(*) as n from event
      where session_id = '' and ${aggregateFilter(aggregate)}`
    return Number(rows[0]?.n ?? 0)
  })

  const append: EventStoreShape["append"] = Effect.fn("EventStore.append")(function* (
    events,
    options,
  ) {
    if (events.length === 0) return []
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        if (options.expectedVersion !== undefined) {
          const actual = yield* currentVersion(options.aggregate)
          if (actual !== options.expectedVersion) {
            return yield* new ConcurrencyConflict({
              aggregate: `${options.aggregate.kind}:${options.aggregate.id}`,
              expected: options.expectedVersion,
              actual,
            })
          }
        }
        const now = Date.now()
        /*
         * An event defaults to belonging to the aggregate it was guarded
         * against. Without this, `append([{ data }], { aggregate: bot })`
         * writes a row with a null `bot_id`, and `readAggregate` -- which
         * filters on the column, not on the guard -- reports the aggregate as
         * empty forever. Every later command then folds from nothing and
         * conflicts at version 0. An explicit `input.botId` still wins, which
         * is what the mirror path needs.
         */
        const aggregateBotId = options.aggregate.kind === "bot" ? options.aggregate.id : null
        const aggregateThreadId = options.aggregate.kind === "thread" ? options.aggregate.id : null
        const stored: Array<StoredEvent> = []
        for (const input of events) {
          const row = {
            id: input.id ?? ulid(),
            session_id: input.sessionId ?? "",
            seq: nextSeq++,
            org_id: input.orgId,
            thread_id: input.threadId ?? aggregateThreadId,
            bot_id: input.botId ?? aggregateBotId,
            actor_user_id: input.actorUserId ?? null,
            stream_index: input.streamIndex ?? null,
            type: input.data._tag,
            data: JSON.stringify(encodeEvent(input.data)),
            at: input.at ?? now,
          }
          yield* sql`insert into event ${sql.insert(row)} on conflict (session_id, id) do nothing`
          stored.push(
            decodeStored({
              id: row.id,
              sessionId: row.session_id,
              seq: row.seq,
              orgId: row.org_id,
              threadId: row.thread_id,
              botId: row.bot_id,
              actorUserId: row.actor_user_id,
              streamIndex: row.stream_index,
              data: encodeEvent(input.data),
              at: row.at,
            }),
          )
        }
        return stored
      }),
    )
  })

  const readAggregate: EventStoreShape["readAggregate"] = Effect.fn("EventStore.readAggregate")(
    function* (aggregate: AggregateKey) {
      const rows = yield* sql<EventRow>`
        select * from event
        where session_id = '' and ${aggregateFilter(aggregate)}
        order by seq asc`
      return { events: rows.map(rowToStored), version: rows.length }
    },
  )

  const readForward: EventStoreShape["readForward"] = Effect.fn("EventStore.readForward")(
    function* (fromSeq: number, limit: number) {
      const rows = yield* sql<EventRow>`
        select * from event where seq > ${fromSeq} order by seq asc limit ${limit}`
      return rows.map(rowToStored)
    },
  )

  const cursor: EventStoreShape["cursor"] = {
    get: Effect.fn("EventStore.cursor.get")(function* (reactor: ReactorName) {
      const rows = yield* sql<{ last_seq: number | bigint }>`
        select last_seq from reactor_cursor where reactor = ${reactor}`
      return Number(rows[0]?.last_seq ?? 0)
    }),
    advance: Effect.fn("EventStore.cursor.advance")(function* (
      reactor: ReactorName,
      seq: number,
    ) {
      yield* sql`
        insert into reactor_cursor (reactor, last_seq, updated_at)
        values (${reactor}, ${seq}, ${Date.now()})
        on conflict (reactor) do update set
          last_seq = excluded.last_seq,
          updated_at = excluded.updated_at`
    }),
  }

  return { append, readAggregate, readForward, cursor } satisfies EventStoreShape
})

export class EventStore extends Context.Service<EventStore, EventStoreShape>()("EventStore") {
  /** Needs the migrated database: provide `Db.layer` and `MigrationsLive` under it. */
  static readonly layer = Layer.effect(EventStore, make)
}
