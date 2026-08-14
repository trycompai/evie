import { NotificationDelivered, type StoredEvent } from "@evie/contracts/events"
import type { ThreadId, UserId } from "@evie/contracts/ids"
import { Context, Effect, Layer } from "effect"
import type { SqlError } from "effect/unstable/sql/SqlError"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { EventStore } from "../store/EventStore.ts"
import { deriveUlid, reactorLayer, type Commit } from "./runtime.ts"

/**
 * NotifyReactor: `TurnSettled` / mirrored `input.requested` -> out-of-app
 * notification fan-out, plus the single admin notification for a blocked
 * routine.
 *
 * This is the ONE reactor where replay is user-visible, so it will not
 * notify for an event older than its own start time: a stale desktop toast is
 * worse than a missed one. The cursor still advances over skipped events --
 * replay is silent, never re-delivered.
 */

export interface NotificationInput {
  readonly userId: UserId
  readonly threadId: ThreadId | null
  readonly title: string
  readonly body: string
}

/**
 * The delivery transport (Web Push / Electron IPC), owned by the Notifier
 * service in 02's table -- defined narrowly here until the gateway agent
 * lands it. Returns whether anything was actually delivered; a user with no
 * registered device gets no `NotificationDelivered` receipt.
 */
export interface NotifierShape {
  readonly deliver: (notification: NotificationInput) => Effect.Effect<boolean>
}

export class Notifier extends Context.Service<Notifier, NotifierShape>()("Notifier") {
  /** No transports registered. What tests and a headless boot run under. */
  static readonly layerNoop = Layer.succeed(Notifier, {
    deliver: () => Effect.succeed(false),
  })
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const store = yield* EventStore
  const notifier = yield* Notifier
  const startedAt = Date.now()

  interface ThreadInfo {
    readonly created_by: string
    readonly snoozed_until: number | bigint | null
  }

  const threadInfo = Effect.fn("NotifyReactor.threadInfo")(function* (threadId: ThreadId) {
    const rows = yield* sql<ThreadInfo>`
      select created_by, snoozed_until from thread where id = ${threadId}`
    return rows[0]
  })

  /** Snooze exists to quiet a thread; a snoozed thread notifies nobody. */
  const isSnoozed = (thread: ThreadInfo | undefined): boolean =>
    thread !== undefined &&
    thread.snoozed_until !== null &&
    Number(thread.snoozed_until) > Date.now()

  /** The member a turn acted as, from its own TurnDispatched receipt. */
  const turnActor = Effect.fn("NotifyReactor.turnActor")(function* (turnId: string) {
    const rows = yield* sql<{ acting_as: string | null }>`
      select json_extract(data, '$.actingAs') as acting_as from event
      where session_id = '' and type = 'TurnDispatched'
        and json_extract(data, '$.turnId') = ${turnId}
      limit 1`
    return (rows[0]?.acting_as ?? null) as UserId | null
  })

  /** The member behind the newest still-open turn of this (thread, bot). */
  const activeTurnActor = Effect.fn("NotifyReactor.activeTurnActor")(function* (
    threadId: string,
    botId: string,
  ) {
    const rows = yield* sql<{ acting_as: string | null }>`
      select json_extract(data, '$.actingAs') as acting_as from event
      where session_id = '' and type = 'TurnDispatched'
        and thread_id = ${threadId} and bot_id = ${botId}
        and json_extract(data, '$.turnId') not in (
          select json_extract(data, '$.turnId') from event
          where session_id = '' and type = 'TurnSettled'
            and thread_id = ${threadId} and bot_id = ${botId})
      order by seq desc limit 1`
    return (rows[0]?.acting_as ?? null) as UserId | null
  })

  const receipt = (
    event: StoredEvent,
    userId: UserId,
    threadId: ThreadId | null,
    reason: "turnCompleted" | "inputRequested" | "routineBlocked",
  ): Commit =>
    store.append(
      [
        {
          id: deriveUlid(event.id, userId, "notified"),
          data: NotificationDelivered.make({ threadId, userId, reason }),
          orgId: event.orgId,
          threadId,
          botId: event.botId,
        },
      ],
      { aggregate: threadId === null ? { kind: "org", id: event.orgId } : { kind: "thread", id: threadId } },
    )

  const handleSettled = (
    event: StoredEvent,
    data: Extract<StoredEvent["data"], { _tag: "TurnSettled" }>,
  ) =>
    Effect.gen(function* () {
      // The user cancelled it themselves; telling them about it is noise.
      if (data.outcome === "cancelled") return
      const thread = yield* threadInfo(data.threadId)
      if (isSnoozed(thread)) return
      const userId =
        (yield* turnActor(data.turnId)) ?? ((thread?.created_by ?? null) as UserId | null)
      if (userId === null) return
      const delivered = yield* notifier.deliver({
        userId,
        threadId: data.threadId,
        title: data.outcome === "failed" ? "A turn failed" : "Work finished",
        body:
          data.outcome === "failed"
            ? "A bot hit an error. Open the thread to see what happened."
            : "A bot finished working in one of your threads.",
      })
      if (!delivered) return
      return receipt(event, userId, data.threadId, "turnCompleted")
    })

  const handleInputRequested = (
    event: StoredEvent,
    data: Extract<StoredEvent["data"], { _tag: "EveMirrored" }>,
  ) =>
    Effect.gen(function* () {
      const thread = yield* threadInfo(data.threadId)
      if (isSnoozed(thread)) return
      const userId =
        (yield* activeTurnActor(data.threadId, data.botId)) ??
        ((thread?.created_by ?? null) as UserId | null)
      if (userId === null) return
      const delivered = yield* notifier.deliver({
        userId,
        threadId: data.threadId,
        title: "A bot needs you",
        body: "A bot is waiting on your answer to continue.",
      })
      if (!delivered) return
      return receipt(event, userId, data.threadId, "inputRequested")
    })

  const handleRoutineBlocked = (
    event: StoredEvent,
    data: Extract<StoredEvent["data"], { _tag: "RoutineBlocked" }>,
  ) =>
    Effect.gen(function* () {
      // One RoutineBlocked event exists per block (guarded at the writer), so
      // admins get exactly one notification, never one per tick.
      const admins = yield* sql<{ userId: string }>`
        select "userId" from member
        where "organizationId" = ${event.orgId} and role in ('owner', 'admin')`
      if (admins.length === 0) return
      const routines = yield* sql<{ name: string }>`
        select name from routine where id = ${data.routineId}`
      const name = routines[0]?.name ?? "A routine"
      const commits: Array<Commit> = []
      for (const admin of admins) {
        const userId = admin.userId as UserId
        const delivered = yield* notifier.deliver({
          userId,
          threadId: (event.threadId ?? null) as ThreadId | null,
          title: "Routine blocked",
          body: `"${name}" stopped running: ${data.reason}. Pick a new run-as member to resume it.`,
        })
        if (delivered) commits.push(receipt(event, userId, event.threadId, "routineBlocked"))
      }
      if (commits.length === 0) return
      const commit: Commit = Effect.all(commits)
      return commit
    })

  return {
    name: "notify" as const,
    handle: (event: StoredEvent): Effect.Effect<Commit | void, SqlError> => {
      // The replay rule. Older events advance the cursor and deliver nothing.
      if (event.at < startedAt) return Effect.void
      const data = event.data
      switch (data._tag) {
        case "TurnSettled":
          return handleSettled(event, data)
        case "EveMirrored":
          return data.eveType === "input.requested"
            ? handleInputRequested(event, data)
            : Effect.void
        case "RoutineBlocked":
          return handleRoutineBlocked(event, data)
        default:
          return Effect.void
      }
    },
  }
})

/** Provide `Notifier` (or `Notifier.layerNoop`) plus `Db.layer` / `EventStore.layer`. */
export const NotifyReactorLive = reactorLayer(make)
