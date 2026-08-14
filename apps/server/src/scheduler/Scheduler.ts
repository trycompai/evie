import type { ConcurrencyConflict } from "@evie/contracts/errors"
import { RoutineBlocked, RoutineFired, ThreadOpened } from "@evie/contracts/events"
import type { BotId, RoutineId, ThreadId } from "@evie/contracts/ids"
import { Context, Cron, Duration, Effect, Latch, Layer, Result } from "effect"
import type { SqlError } from "effect/unstable/sql/SqlError"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { Db } from "../db/Db.ts"
import { deriveUlid, ReactorWake } from "../reactors/runtime.ts"
import { EventStore } from "../store/EventStore.ts"

/**
 * Cron rows -> `RoutineFired` events. The dispatch itself is RoutineReactor's
 * job: the fired event is durable, so a crash between the fire and the eve
 * call replays through the reactor loop instead of losing the run.
 *
 * `next_run_at` is a CACHE, always recomputed from `(cron, tz)` -- at boot,
 * after every fire, and on every `refresh` -- and never trusted across a
 * restart. `tz` lives on the routine, so a laptop crossing a timezone or a
 * DST transition cannot silently shift a schedule.
 *
 * The timer is demand-scheduled: one fiber sleeps until the earliest due
 * routine (capped at one hour so a multi-day sleep never leans on a single
 * setTimeout), and `refresh` wakes it early. No routines, no polling.
 */

export interface SchedulerShape {
  /**
   * Recompute one routine's `next_run_at` from `(cron, tz)` and re-arm the
   * timer. `ConcurrencyConflict` is in the channel only because blocking a
   * routine appends; the append carries no expectedVersion, so it never fires.
   */
  readonly refresh: (
    routineId: RoutineId,
  ) => Effect.Effect<void, SqlError | ConcurrencyConflict>
  /** Recompute every routine. Runs at layer boot; callable again after bulk changes. */
  readonly refreshAll: Effect.Effect<void, SqlError>
}

interface RoutineRow {
  readonly id: string
  readonly org_id: string
  readonly bot_id: string
  readonly thread_id: string | null
  readonly name: string
  readonly cron: string
  readonly tz: string
  readonly prompt: string
  readonly run_as: string | null
  readonly enabled: number
  readonly blocked_reason: string | null
  readonly next_run_at: number | bigint | null
}

/** Millis of the next occurrence, or null when `(cron, tz)` does not parse. */
const nextRunAt = (cron: string, tz: string, from: number): number | null => {
  const parsed = Cron.parse(cron, tz)
  if (Result.isFailure(parsed)) return null
  return Cron.next(parsed.success, new Date(from)).getTime()
}

/** The longest single sleep. Re-arming hourly costs nothing and dodges setTimeout's 32-bit cap. */
const MAX_SLEEP_MILLIS = 60 * 60 * 1000

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const db = yield* Db
  const store = yield* EventStore
  const wake = yield* ReactorWake
  const rearm = yield* Latch.make(false)

  /**
   * Marks a routine blocked, exactly once: the `blocked_reason is null` guard
   * makes a second call a no-op, which is what keeps admins at ONE
   * notification instead of one per tick.
   */
  const block = Effect.fn("Scheduler.block")(function* (routine: RoutineRow, reason: string) {
    yield* db.retryLocked(
      db.withTransaction(
        Effect.gen(function* () {
          const changed = yield* sql<{ id: string }>`
            update routine set blocked_reason = ${reason}, next_run_at = null
            where id = ${routine.id} and blocked_reason is null
            returning id`
          if (changed.length === 0) return
          yield* store.append(
            [
              {
                data: RoutineBlocked.make({
                  routineId: routine.id as RoutineId,
                  botId: routine.bot_id as BotId,
                  reason,
                }),
                orgId: routine.org_id,
                botId: routine.bot_id,
                threadId: routine.thread_id,
              },
            ],
            { aggregate: { kind: "bot", id: routine.bot_id } },
          )
        }),
      ),
    )
    yield* wake.notify
  })

  const fire = Effect.fn("Scheduler.fire")(function* (routine: RoutineRow) {
    const now = Date.now()
    const next = nextRunAt(routine.cron, routine.tz, now)
    // Backstop for a member removal that never produced a MemberRemoved event:
    // a pinned run_as who left the org blocks the routine, and is NEVER
    // silently substituted with somebody else.
    if (routine.run_as !== null) {
      const member = yield* sql<{ ok: number }>`
        select 1 as ok from member
        where "organizationId" = ${routine.org_id} and "userId" = ${routine.run_as}`
      if (member.length === 0) {
        return yield* block(routine, "run-as member left the organization")
      }
    }
    // Keyed by the scheduled instant: a crash-replay of the same occurrence
    // derives the same ids, so the appends and inserts below all dedupe.
    const occurrence = String(routine.next_run_at ?? now)
    const threadId = (routine.thread_id ??
      deriveUlid("routine-thread", routine.id, occurrence)) as ThreadId
    const opensThread = routine.thread_id === null
    yield* db.retryLocked(
      db.withTransaction(
        Effect.gen(function* () {
          if (opensThread) {
            // A system-minted thread. The projector derives the same rows from
            // ThreadOpened; writing them here keeps the dispatch that follows
            // (and the participant upsert it does) on solid ground.
            yield* sql`
              insert into thread (id, org_id, title, created_by, created_at, last_activity)
              values (${threadId}, ${routine.org_id}, ${routine.name}, ${routine.run_as ?? ""}, ${now}, ${now})
              on conflict (id) do nothing`
            yield* sql`
              insert into thread_participant (thread_id, bot_id, is_default)
              values (${threadId}, ${routine.bot_id}, 1)
              on conflict (thread_id, bot_id) do nothing`
          }
          yield* store.append(
            [
              ...(opensThread
                ? [
                    {
                      id: deriveUlid("routine-opened", routine.id, occurrence),
                      data: ThreadOpened.make({
                        threadId,
                        participants: [routine.bot_id as BotId],
                        title: routine.name,
                      }),
                      orgId: routine.org_id,
                      threadId,
                      botId: routine.bot_id,
                      actorUserId: routine.run_as,
                    },
                  ]
                : []),
              {
                id: deriveUlid("routine-fired", routine.id, occurrence),
                data: RoutineFired.make({
                  routineId: routine.id as RoutineId,
                  botId: routine.bot_id as BotId,
                  threadId,
                }),
                orgId: routine.org_id,
                threadId,
                botId: routine.bot_id,
                actorUserId: routine.run_as,
              },
            ],
            { aggregate: { kind: "thread", id: threadId } },
          )
          yield* sql`
            update routine set last_run_at = ${now}, next_run_at = ${next}, last_status = 'fired'
            where id = ${routine.id}`
        }),
      ),
    )
    yield* wake.notify
  })

  const refresh: SchedulerShape["refresh"] = Effect.fn("Scheduler.refresh")(function* (
    routineId: RoutineId,
  ) {
    const rows = yield* sql<RoutineRow>`select * from routine where id = ${routineId}`
    const routine = rows[0]
    if (routine !== undefined && routine.enabled === 1 && routine.blocked_reason === null) {
      const next = nextRunAt(routine.cron, routine.tz, Date.now())
      if (next === null) {
        // The decider only shape-checks cron; a value error surfaces here.
        yield* block(routine, "cron expression or timezone does not parse")
      } else {
        yield* sql`update routine set next_run_at = ${next} where id = ${routine.id}`
      }
    } else if (routine !== undefined) {
      yield* sql`update routine set next_run_at = null where id = ${routine.id}`
    }
    yield* rearm.open
  })

  const refreshAll: SchedulerShape["refreshAll"] = Effect.gen(function* () {
    const rows = yield* sql<RoutineRow>`select * from routine`
    const now = Date.now()
    for (const routine of rows) {
      const next =
        routine.enabled === 1 && routine.blocked_reason === null
          ? nextRunAt(routine.cron, routine.tz, now)
          : null
      yield* sql`update routine set next_run_at = ${next} where id = ${routine.id}`
    }
    yield* rearm.open
  }).pipe(Effect.asVoid)

  // next_run_at is never trusted across a restart.
  yield* refreshAll

  yield* Effect.forkScoped(
    Effect.gen(function* () {
      while (true) {
        yield* rearm.close
        const now = Date.now()
        const due = yield* sql<RoutineRow>`
          select * from routine
          where enabled = 1 and blocked_reason is null
            and next_run_at is not null and next_run_at <= ${now}`
        for (const routine of due) {
          yield* fire(routine).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Scheduler: routine fire failed", { routineId: routine.id }, cause),
            ),
          )
        }
        const upcoming = yield* sql<{ next: number | bigint | null }>`
          select min(next_run_at) as next from routine
          where enabled = 1 and blocked_reason is null and next_run_at is not null`
        const next = upcoming[0]?.next
        if (next === null || next === undefined) {
          yield* rearm.await
        } else {
          const waitMillis = Math.min(Math.max(Number(next) - Date.now(), 0), MAX_SLEEP_MILLIS)
          yield* Effect.raceFirst(rearm.await, Effect.sleep(Duration.millis(waitMillis)))
        }
      }
    }).pipe(
      Effect.catchCause((cause) => Effect.logError("Scheduler: timer loop stopped", cause)),
    ),
  )

  return { refresh, refreshAll } satisfies SchedulerShape
})

export class Scheduler extends Context.Service<Scheduler, SchedulerShape>()("Scheduler") {
  /** Needs `Db.layer`, `EventStore.layer`, and `ReactorWake.layer` under it. */
  static readonly layer = Layer.effect(Scheduler, make)
}
