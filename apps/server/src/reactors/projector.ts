import { Bot } from "@evie/contracts/bot"
import type { StoredEvent } from "@evie/contracts/events"
import type { BotId, ThreadId } from "@evie/contracts/ids"
import { Thread } from "@evie/contracts/thread"
import { TimelineItem, type TimelineOp } from "@evie/contracts/timeline"
import { botDir } from "@evie/shared/home"
import { Effect, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { EvieConfig } from "../config.ts"
import {
  apply,
  emptyReadModel,
  type BotRow,
  type ParticipantRow,
  type RoutineRow,
  type RowChange,
  type ThreadRow,
  type TimelineRow,
} from "../domain/project.ts"
import { Hub } from "../gateway/hub.ts"
import { Scheduler } from "../scheduler/Scheduler.ts"
import { reactorLayer, type Commit, type ReactorDefinition } from "./runtime.ts"

/**
 * The product-event half of the projection. The eve adapter persists what the
 * mirror stream derives (timeline, participants, thread activity); this
 * reactor owns everything a user's command creates: bot, thread, routine, and
 * connection rows.
 *
 * It performs NO side effects. Provisioning a bot's project -- which runs
 * `git init` and `npm install` in the bot directory, and can take minutes on a
 * cold cache -- belongs to the supervisor reactor. It lived here once, inside
 * the transaction that advances this cursor, and the cost was exactly what you
 * would expect: the bot row did not exist until the install finished, so the
 * rail sat empty for a bot the user had just created, and every later event's
 * projection queued behind it.
 *
 * It folds `domain/project.apply` over its own in-memory model, hydrated from
 * the tables at boot (the tables ARE the fold up to the cursor) and per-thread
 * timelines lazily. Mirror events are skipped entirely: the adapter already
 * projected and persisted them on its flush tick, and applying them twice from
 * two models is how the two writers would fight.
 */

const decodeItem = Schema.decodeUnknownSync(TimelineItem)
const encodeItem = Schema.encodeSync(TimelineItem)
const decodeBot = Schema.decodeUnknownSync(Bot)
const decodeThread = Schema.decodeUnknownSync(Thread)

/** Events whose projection writes a timeline row, so the thread must be hydrated. */
const TOUCHES_TIMELINE: ReadonlySet<string> = new Set([
  "MessageSent",
  "InputAnswered",
  "CheckpointWritten",
  "CheckpointRestoreRequested",
])

/** Product timeline rows the client has never seen vs. state changes to known rows. */
const timelineOpOf = (tag: string, item: TimelineItem): TimelineOp =>
  tag === "InputAnswered" ? { op: "replace", item } : { op: "insert", item }


const jsonOr = (text: unknown, fallback: unknown): unknown => {
  if (typeof text !== "string") return fallback
  try {
    return text.startsWith("{") ? JSON.parse(text) : fallback
  } catch {
    return fallback
  }
}

const make: Effect.Effect<
  ReactorDefinition<unknown, never>,
  never,
  SqlClient.SqlClient | EvieConfig | Hub | Scheduler
> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const config = yield* EvieConfig
  const hub = yield* Hub
  const scheduler = yield* Scheduler

  const model = emptyReadModel()

  /* --- boot hydration: the tables are the fold up to the cursor -------------- */

  const bots = yield* sql<Record<string, unknown>>`select * from bot`.pipe(Effect.orDie)
  for (const row of bots) {
    model.bots.set(String(row.id), {
      id: row.id as BotId,
      orgId: String(row.org_id),
      teamId: row.team_id === null ? null : String(row.team_id),
      slug: String(row.slug),
      name: String(row.name),
      description: row.description === null ? null : String(row.description),
      avatar: row.avatar === null ? null : String(row.avatar),
      model: String(row.model),
      reasoning: row.reasoning === null ? null : String(row.reasoning),
      runtimeMode: row.runtime_mode === "built" ? "built" : "dev",
      sandbox: jsonOr(row.sandbox, {
        backend: "docker",
        network: { mode: "deny-all", allow: [], enforced: "coarse" },
      }) as BotRow["sandbox"],
      health: jsonOr(row.health, { kind: "idle" }) as BotRow["health"],
      createdBy: row.created_by === null ? null : String(row.created_by),
      createdAt: Number(row.created_at),
      archivedAt: row.archived_at === null ? null : Number(row.archived_at),
    })
  }

  const threads = yield* sql<Record<string, unknown>>`select * from thread`.pipe(Effect.orDie)
  for (const row of threads) {
    model.threads.set(String(row.id), {
      id: row.id as ThreadId,
      orgId: String(row.org_id),
      title: row.title === null ? null : String(row.title),
      createdBy: row.created_by === null ? null : String(row.created_by),
      createdAt: Number(row.created_at),
      lastActivity: Number(row.last_activity),
      snoozedUntil: row.snoozed_until === null ? null : Number(row.snoozed_until),
      archivedAt: row.archived_at === null ? null : Number(row.archived_at),
    })
  }

  const participants = yield* sql<Record<string, unknown>>`select * from thread_participant`.pipe(
    Effect.orDie,
  )
  for (const row of participants) {
    model.participants.set(`${String(row.thread_id)}/${String(row.bot_id)}`, {
      threadId: row.thread_id as ThreadId,
      botId: row.bot_id as BotId,
      eveSessionId: row.eve_session_id === null ? null : String(row.eve_session_id),
      streamIndex: Number(row.stream_index),
      isDefault: Number(row.is_default) === 1,
    })
  }

  const routines = yield* sql<Record<string, unknown>>`select * from routine`.pipe(Effect.orDie)
  for (const row of routines) {
    model.routines.set(String(row.id), {
      id: String(row.id),
      orgId: String(row.org_id),
      botId: row.bot_id as BotId,
      threadId: row.thread_id === null ? null : String(row.thread_id),
      name: String(row.name),
      cron: String(row.cron),
      tz: String(row.tz),
      prompt: String(row.prompt),
      runAs: row.run_as === null ? null : String(row.run_as),
      enabled: Number(row.enabled) === 1,
      blockedReason: row.blocked_reason === null ? null : String(row.blocked_reason),
      lastRunAt: row.last_run_at === null ? null : Number(row.last_run_at),
    })
  }

  const connections = yield* sql<Record<string, unknown>>`select * from connection`.pipe(
    Effect.orDie,
  )
  for (const row of connections) {
    model.connections.set(String(row.id), {
      id: String(row.id),
      orgId: String(row.org_id),
      botId: row.bot_id as BotId,
      name: String(row.name),
      kind: String(row.kind),
      scope: String(row.scope),
      config: jsonOr(row.config, {}),
      authKind: String(row.auth_kind),
    })
  }

  /* --- lazy timeline hydration ------------------------------------------------ */

  const hydratedTimelines = new Set<string>()
  const ensureTimeline = Effect.fn("projector.ensureTimeline")(function* (threadId: ThreadId) {
    if (hydratedTimelines.has(threadId)) return
    hydratedTimelines.add(threadId)
    const timeline = {
      nextSeq: 1,
      items: new Map<string, TimelineRow>(),
      toolByCall: new Map<string, string>(),
      inputByRequest: new Map<string, string>(),
      authByName: new Map<string, string>(),
      subagentBySession: new Map<string, string>(),
    }
    model.timelines.set(threadId, timeline)
    const rows = yield* sql<{ actor_user_id: string | null; body: string }>`
      select actor_user_id, body from timeline_item
      where thread_id = ${threadId} order by seq asc`.pipe(Effect.orDie)
    for (const row of rows) {
      let item: TimelineItem
      try {
        item = decodeItem(JSON.parse(row.body))
      } catch {
        continue
      }
      timeline.items.set(item.id, { threadId, item, actorUserId: row.actor_user_id })
      timeline.nextSeq = Math.max(timeline.nextSeq, item.seq + 1)
      if (item.kind === "input") timeline.inputByRequest.set(item.requestId, item.id)
    }
  })

  /* --- persistence -------------------------------------------------------------- */

  const persistBot = (row: BotRow) =>
    sql`
      insert into bot (id, org_id, team_id, slug, name, description, avatar, dir, model,
                       reasoning, runtime_mode, sandbox, health, created_by, created_at, archived_at)
      values (${row.id}, ${row.orgId}, ${row.teamId}, ${row.slug}, ${row.name},
              ${row.description}, ${row.avatar}, ${botDir(config.home, row.orgId, row.id)},
              ${row.model}, ${row.reasoning}, ${row.runtimeMode}, ${JSON.stringify(row.sandbox)},
              ${JSON.stringify(row.health)}, ${row.createdBy ?? ""}, ${row.createdAt},
              ${row.archivedAt})
      on conflict (id) do update set
        team_id = excluded.team_id,
        name = excluded.name,
        description = excluded.description,
        avatar = excluded.avatar,
        model = excluded.model,
        reasoning = excluded.reasoning,
        runtime_mode = excluded.runtime_mode,
        sandbox = excluded.sandbox,
        health = excluded.health,
        archived_at = excluded.archived_at`

  const persistThread = (row: ThreadRow) =>
    sql`
      insert into thread (id, org_id, title, created_by, created_at, last_activity,
                          snoozed_until, archived_at)
      values (${row.id}, ${row.orgId}, ${row.title}, ${row.createdBy ?? ""}, ${row.createdAt},
              ${row.lastActivity}, ${row.snoozedUntil}, ${row.archivedAt})
      on conflict (id) do update set
        title = excluded.title,
        last_activity = excluded.last_activity,
        snoozed_until = excluded.snoozed_until,
        archived_at = excluded.archived_at`

  // Insert-only for the cursor fields: `stream_index` and `eve_session_id`
  // belong to the adapter's flush and the turn reactor. The projector may only
  // create the row and flip `is_default`.
  const persistParticipant = (row: ParticipantRow) =>
    sql`
      insert into thread_participant (thread_id, bot_id, eve_session_id, stream_index, is_default)
      values (${row.threadId}, ${row.botId}, ${row.eveSessionId}, ${row.streamIndex},
              ${row.isDefault ? 1 : 0})
      on conflict (thread_id, bot_id) do update set is_default = excluded.is_default`

  // `next_run_at` and `last_status` stay untouched: the scheduler owns them.
  const persistRoutine = (row: RoutineRow) =>
    sql`
      insert into routine (id, org_id, bot_id, thread_id, name, cron, tz, prompt, run_as,
                           enabled, blocked_reason, last_run_at)
      values (${row.id}, ${row.orgId}, ${row.botId}, ${row.threadId}, ${row.name}, ${row.cron},
              ${row.tz}, ${row.prompt}, ${row.runAs}, ${row.enabled ? 1 : 0},
              ${row.blockedReason}, ${row.lastRunAt})
      on conflict (id) do update set
        name = excluded.name,
        cron = excluded.cron,
        tz = excluded.tz,
        prompt = excluded.prompt,
        run_as = excluded.run_as,
        enabled = excluded.enabled,
        blocked_reason = excluded.blocked_reason,
        last_run_at = excluded.last_run_at`

  const persistTimeline = (row: TimelineRow) => {
    const item = row.item
    const itemBotId = "botId" in item ? item.botId : null
    const turnId = "turnId" in item ? item.turnId : null
    return sql`
      insert into timeline_item (id, thread_id, seq, kind, bot_id, actor_user_id, turn_id, body, at)
      values (${item.id}, ${row.threadId},
              /*
               * The row's position is allocated here, not by the caller.
               *
               * Two independent projections write this table -- the reactor,
               * folding the whole event log, and the adapter, folding a live
               * eve stream inline for latency -- and each used to hand out
               * positions from its own in-memory counter. They agree only until
               * one of them projects an event the other never sees (a user
               * message, a checkpoint row), after which both eventually issue
               * the same number to different rows and the unique index rejects
               * the second. That took the projector loop down entirely.
               *
               * An existing row keeps the position it was given; a new one
               * takes the next free position in its thread. Both are read
               * inside this statement, under the single writer, so the answer
               * cannot be stale by the time it is used.
               */
              coalesce(
                (select seq from timeline_item where id = ${item.id}),
                (select coalesce(max(seq), 0) + 1 from timeline_item where thread_id = ${row.threadId})
              ),
              ${item.kind}, ${itemBotId},
              ${row.actorUserId}, ${turnId}, ${JSON.stringify(encodeItem(item))}, ${item.at})
      on conflict (id) do update set
        kind = excluded.kind,
        actor_user_id = excluded.actor_user_id,
        turn_id = excluded.turn_id,
        body = excluded.body,
        at = excluded.at`
  }

  const persistChange = (change: RowChange) => {
    switch (change.kind) {
      case "bot":
        return persistBot(change.row)
      case "thread":
        return persistThread(change.row)
      case "participant":
        return persistParticipant(change.row)
      case "participantRemoved":
        return sql`delete from thread_participant
                   where thread_id = ${change.threadId} and bot_id = ${change.botId}`
      case "routine":
        return persistRoutine(change.row)
      case "routineDeleted":
        return sql`delete from routine where id = ${change.id}`
      case "connection":
        return sql`
          insert into connection (id, org_id, bot_id, name, kind, scope, config, auth_kind)
          values (${change.row.id}, ${change.row.orgId}, ${change.row.botId}, ${change.row.name},
                  ${change.row.kind}, ${change.row.scope}, ${JSON.stringify(change.row.config)},
                  ${change.row.authKind})
          on conflict (id) do nothing`
      case "connectionDeleted":
        return sql`delete from connection where id = ${change.id}`
      case "timeline":
        return persistTimeline(change.row)
    }
  }

  /* --- live publishes ------------------------------------------------------------ */

  const publishChanges = (event: StoredEvent, changes: ReadonlyArray<RowChange>) =>
    Effect.gen(function* () {
      const fleetBots: Array<Bot> = []
      const fleetThreads: Array<Thread> = []
      for (const change of changes) {
        if (change.kind === "bot") {
          try {
            fleetBots.push(decodeBot({ ...change.row }))
          } catch {
            // A row this build cannot encode is a projection bug, not a reason
            // to wedge the reactor; the query path re-reads from the table.
          }
        }
        if (change.kind === "thread") {
          const row = change.row
          const threadParticipants = [...model.participants.values()]
            .filter((participant) => participant.threadId === row.id)
            .map((participant) => ({ ...participant }))
          try {
            fleetThreads.push(
              decodeThread({
                id: row.id,
                orgId: row.orgId,
                title: row.title,
                participants: threadParticipants,
                status: hub.statusOf(row.id),
                preview: null,
                createdBy: row.createdBy ?? "",
                createdAt: row.createdAt,
                lastActivity: row.lastActivity,
                snoozedUntil: row.snoozedUntil,
                archivedAt: row.archivedAt,
              }),
            )
          } catch {
            // Same policy as bots above.
          }
        }
        if (change.kind === "timeline") {
          yield* hub.publishThread(change.row.threadId, {
            ops: [timelineOpOf(event.data._tag, change.row.item)],
            seq: change.row.item.seq,
          })
        }
      }
      if (fleetBots.length > 0 || fleetThreads.length > 0) {
        yield* hub.publishFleet(event.orgId, {
          ...(fleetBots.length > 0 ? { bots: fleetBots } : {}),
          ...(fleetThreads.length > 0 ? { threads: fleetThreads } : {}),
        })
      }
    })

  /* --- the reactor ----------------------------------------------------------------- */

  const handle = (event: StoredEvent): Effect.Effect<Commit | void, unknown> =>
    Effect.gen(function* () {
      // Mirror events were projected and persisted by the adapter's flush.
      if (event.sessionId !== "") return

      const data = event.data
      if (TOUCHES_TIMELINE.has(data._tag) && event.threadId !== null) {
        yield* ensureTimeline(event.threadId)
      }

      const changes = apply(model, event)

      if (changes.length === 0) return

      yield* publishChanges(event, changes)

      const routineIds = changes.flatMap((change) =>
        change.kind === "routine" ? [change.row.id] : [],
      )

      const commit: Commit = Effect.gen(function* () {
        for (const change of changes) yield* persistChange(change)
        // Same transaction as the row: the scheduler's `next_run_at` must
        // never describe a routine row that was not committed.
        for (const id of routineIds) {
          yield* scheduler.refresh(id as Parameters<typeof scheduler.refresh>[0])
        }
      })
      return commit
    })

  return { name: "projector", handle } satisfies ReactorDefinition<unknown, never>
})

export const ProjectorReactorLive = reactorLayer(make)
