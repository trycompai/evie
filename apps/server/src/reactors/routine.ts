import type { ConcurrencyConflict, RuntimeUnavailable } from "@evie/contracts/errors"
import { RoutineBlocked, type StoredEvent } from "@evie/contracts/events"
import type { BotId, RoutineId, SessionId, TurnId, UserId } from "@evie/contracts/ids"
import { Effect } from "effect"
import type { SqlError } from "effect/unstable/sql/SqlError"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { Scheduler } from "../scheduler/Scheduler.ts"
import { EventStore } from "../store/EventStore.ts"
import { deriveUlid, reactorLayer, type Commit } from "./runtime.ts"
import { dispatchCommit, TurnDispatch } from "./turn.ts"

/**
 * RoutineReactor: keeps the Scheduler's timer honest as routine events land,
 * blocks routines whose pinned member left, and turns the durable
 * `RoutineFired` events the Scheduler appends into dispatched eve turns.
 *
 * The fire -> dispatch split is deliberate: the Scheduler's append commits the
 * occurrence, and this reactor's cursor guarantees the dispatch happens even
 * if the process dies in between. The turn id derives from the RoutineFired
 * event id, so a replayed dispatch is a no-op against eve.
 */

interface RoutineRow {
  readonly id: string
  readonly org_id: string
  readonly bot_id: string
  readonly thread_id: string | null
  readonly prompt: string
  readonly run_as: string | null
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const store = yield* EventStore
  const scheduler = yield* Scheduler
  const dispatch = yield* TurnDispatch

  /** RoutineCreated always came from a command, so its stored event has the actor. */
  const routineCreator = Effect.fn("RoutineReactor.routineCreator")(function* (
    routineId: string,
  ) {
    const rows = yield* sql<{ actor_user_id: string | null }>`
      select actor_user_id from event
      where session_id = '' and type = 'RoutineCreated'
        and json_extract(data, '$.routineId') = ${routineId}
      limit 1`
    return (rows[0]?.actor_user_id ?? null) as UserId | null
  })

  const handleMemberRemoved = (
    event: StoredEvent,
    data: Extract<StoredEvent["data"], { _tag: "MemberRemoved" }>,
  ) =>
    Effect.gen(function* () {
      const affected = yield* sql<RoutineRow>`
        select id, org_id, bot_id, thread_id, prompt, run_as from routine
        where org_id = ${event.orgId} and run_as = ${data.userId} and blocked_reason is null`
      if (affected.length === 0) return
      const reason = "run-as member left the organization"
      const commit: Commit = Effect.gen(function* () {
        for (const routine of affected) {
          // The `blocked_reason is null` guard plus the deterministic receipt
          // id keep this at one RoutineBlocked per routine, not one per replay.
          yield* sql`
            update routine set blocked_reason = ${reason}, next_run_at = null
            where id = ${routine.id} and blocked_reason is null`
          yield* store.append(
            [
              {
                id: deriveUlid(event.id, routine.id, "blocked"),
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
        }
      })
      return commit
    })

  const handleFired = (
    event: StoredEvent,
    data: Extract<StoredEvent["data"], { _tag: "RoutineFired" }>,
  ) =>
    Effect.gen(function* () {
      const rows = yield* sql<RoutineRow>`
        select id, org_id, bot_id, thread_id, prompt, run_as from routine
        where id = ${data.routineId}`
      const routine = rows[0]
      // Deleted between fire and dispatch: the run is moot, not an error.
      if (routine === undefined) return
      const actingAs = ((routine.run_as as UserId | null) ??
        (yield* routineCreator(routine.id)))
      if (actingAs === null) {
        return yield* Effect.logWarning(
          "RoutineReactor: no member to attribute the run to; not dispatched",
          { routineId: routine.id },
        )
      }
      const sessions = yield* sql<{ eve_session_id: string | null }>`
        select eve_session_id from thread_participant
        where thread_id = ${data.threadId} and bot_id = ${data.botId}`
      const sessionId = (sessions[0]?.eve_session_id ?? null) as SessionId | null
      const turnId = deriveUlid(event.id, "turn") as TurnId
      const dispatched = yield* dispatch.dispatchTurn({
        botId: data.botId,
        threadId: data.threadId,
        sessionId,
        turnId,
        actingAs,
        message: routine.prompt,
        // Routine runs wait their turn; only humans steer.
        turnPolicy: "queue",
      })
      return dispatchCommit(sql, store, {
        triggerEventId: event.id,
        orgId: event.orgId,
        threadId: data.threadId,
        botId: data.botId,
        turnId,
        sessionId: dispatched.sessionId,
        actingAs,
      })
    })

  return {
    name: "routine" as const,
    handle: (
      event: StoredEvent,
    ): Effect.Effect<Commit | void, SqlError | ConcurrencyConflict | RuntimeUnavailable> => {
      const data = event.data
      switch (data._tag) {
        case "RoutineCreated":
        case "RoutineEnabled":
        case "RoutineDeleted":
          return scheduler.refresh(data.routineId)
        case "RoutineRunAsChanged":
          return Effect.gen(function* () {
            if (data.runAs !== null) {
              // Pinning a (new) member is the way out of a blocked routine.
              // Idempotent, and the same clear the projector derives.
              yield* sql`update routine set blocked_reason = null where id = ${data.routineId}`
            }
            yield* scheduler.refresh(data.routineId)
          })
        case "MemberRemoved":
          return handleMemberRemoved(event, data)
        case "RoutineFired":
          return handleFired(event, data)
        default:
          return Effect.void
      }
    },
  }
})

/** Provide `Scheduler.layer` and `TurnDispatch` plus `Db.layer` / `EventStore.layer`. */
export const RoutineReactorLive = reactorLayer(make)
