import { InvalidCommand, NotFound, RuntimeUnavailable } from "@evie/contracts/errors"
import { EveMirrored, type StoredEvent } from "@evie/contracts/events"
import type { BotId, EventId, OrgId, SessionId, ThreadId, TurnId, UserId } from "@evie/contracts/ids"
import type { ThreadStatus } from "@evie/contracts/thread"
import { TimelineItem } from "@evie/contracts/timeline"
import { ulid } from "@evie/shared/ulid"
import {
  Cause,
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  PubSub,
  Queue,
  Schema,
  type Scope,
  Stream,
} from "effect"
import * as Ndjson from "effect/unstable/encoding/Ndjson"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { EvieConfig } from "../config.ts"
import { Db } from "../db/Db.ts"
import { ReactorWake } from "../reactors/runtime.ts"
import {
  apply,
  emptyReadModel,
  type ParticipantRow,
  type ReadModel,
  type RowChange,
  type TimelineRow,
} from "../domain/project.ts"
import type { Actor } from "../domain/state.ts"
import { type AppendInput, EventStore } from "../store/EventStore.ts"
import { Supervisor } from "./Supervisor.ts"

/**
 * The ONLY eve-aware module (02, "The eve provider adapter"). Everything above
 * this file is pure orchestration; everything below it is eve's business. A
 * second provider is a second adapter, not a refactor.
 *
 * Ingestion follows 02's three-step contract per stream event:
 *
 *   1. fold into the in-memory read model and publish to the hub -- coalesced
 *      (the full projected item, cumulative text and all), never eve's raw line;
 *   2. that fold IS the thread's read-model update, in memory;
 *   3. on the 50 ms flush tick, write the accumulated mirror events, the
 *      projected rows, and the advanced `stream_index` in ONE transaction.
 *
 * No write happens per delta: clients see a delta as it arrives, disk sees a
 * batch. Resume reads the last PERSISTED `stream_index`, so an unflushed batch
 * is re-read rather than lost; overlap is harmless because the mirror is
 * idempotent on `(session_id, meta.id)`. That is why the cursor advances WITH
 * the batch and never ahead of it.
 *
 * Reasoning text is streamed to the hub and discarded -- never mirrored, never
 * stored. A token count persists (03, "Retention"). The `persistReasoning`
 * flag is the one named branch.
 */

/* --- hub messages ------------------------------------------------------------ */

export type ThreadDelta =
  | {
      /** Projected rows that changed. Full items, cumulative text -- the gateway diffs. */
      readonly _tag: "rows"
      readonly threadId: ThreadId
      readonly botId: BotId
      readonly changes: ReadonlyArray<RowChange>
    }
  | {
      /** Live-only. Whoever is not subscribed right now never sees this text again. */
      readonly _tag: "reasoning"
      readonly threadId: ThreadId
      readonly botId: BotId
      readonly turnId: string | null
      readonly text: string
    }
  | {
      readonly _tag: "status"
      readonly threadId: ThreadId
      readonly botId: BotId
      readonly status: ThreadStatus
    }

/* --- inputs ------------------------------------------------------------------ */

export interface DispatchInput {
  readonly threadId: ThreadId
  readonly botId: BotId
  /** The existing `(thread, bot)` session, or null to start one. */
  readonly sessionId: SessionId | null
  readonly message: string
  /** The member this turn acts as. The per-turn JWT carries exactly this. */
  readonly actor: Actor
  /** `"steer"` for user messages, `"queue"` for routine dispatches (02). */
  readonly turnPolicy: "steer" | "queue"
  /** Other participants' recent turns. eve keeps it out of durable history. */
  readonly clientContext?: string | ReadonlyArray<string>
  /** Create-once idempotency for new sessions. Derive from the triggering event id. */
  readonly operationId?: string
}

export interface InputResponse {
  readonly requestId: string
  readonly optionId?: string
  readonly text?: string
}

export interface SessionOpInput {
  readonly botId: BotId
  readonly sessionId: SessionId
  readonly actor: Actor
}

export interface AttachInput {
  readonly threadId: ThreadId
  readonly botId: BotId
  readonly sessionId: SessionId
}

export interface EveAdapterShape {
  /** Sends one turn. Returns the session it landed on (fresh when `sessionId` was null). */
  readonly dispatch: (
    input: DispatchInput,
  ) => Effect.Effect<{ sessionId: SessionId }, RuntimeUnavailable | InvalidCommand>
  readonly answerInput: (
    input: SessionOpInput & { readonly responses: ReadonlyArray<InputResponse> },
  ) => Effect.Effect<void, RuntimeUnavailable | InvalidCommand>
  readonly cancel: (
    input: SessionOpInput & { readonly turnId?: string },
  ) => Effect.Effect<void, RuntimeUnavailable | InvalidCommand>
  readonly compact: (input: SessionOpInput) => Effect.Effect<void, RuntimeUnavailable | InvalidCommand>
  readonly clear: (input: SessionOpInput) => Effect.Effect<void, RuntimeUnavailable | InvalidCommand>
  /**
   * Ingests one session's stream until the scope closes or the session ends
   * terminally. Reconnects through transport errors with capped backoff; gives
   * up only when the runtime itself is unavailable.
   */
  readonly attach: (
    input: AttachInput,
  ) => Effect.Effect<void, NotFound | RuntimeUnavailable | SqlError, Scope.Scope>
  /** The in-process hub. The gateway subscribes and applies its own per-client budget. */
  readonly deltas: PubSub.PubSub<ThreadDelta>
}

/* --- tolerant readers -------------------------------------------------------- */
/* eve owns the NDJSON shape. We read the handful of fields the adapter needs
 * and treat anything missing as absent rather than failing the stream. */

const rec = (u: unknown): Record<string, unknown> =>
  typeof u === "object" && u !== null ? (u as Record<string, unknown>) : {}
const str = (u: unknown): string | undefined => (typeof u === "string" ? u : undefined)
const num = (u: unknown): number | undefined => (typeof u === "number" ? u : undefined)
const arr = (u: unknown): ReadonlyArray<unknown> => (Array.isArray(u) ? u : [])

const millisOf = (u: unknown): number => {
  const parsed = typeof u === "string" ? Date.parse(u) : Number.NaN
  return Number.isNaN(parsed) ? Date.now() : parsed
}

/** Cumulative and delta text fields, dropped from a mirrored `reasoning.completed`. */
const REASONING_TEXT_KEYS = new Set(["text", "delta", "content", "cumulative", "cumulativeText"])
const stripReasoningText = (payload: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(payload).filter(([key]) => !REASONING_TEXT_KEYS.has(key)))

/** `ThreadTimeline` is internal to the projector; recover it structurally. */
type ThreadTimeline = NonNullable<ReturnType<ReadModel["timelines"]["get"]>>

/** A stream connection was made but refused; retried like any transport error. */
class StreamRefused extends Data.TaggedError("StreamRefused")<{ readonly status: number }> {}

interface PendingEvent {
  readonly append: AppendInput
  readonly changes: ReadonlyArray<RowChange>
  readonly streamIndex: number
}

interface SessionCtx {
  readonly threadId: ThreadId
  readonly botId: BotId
  readonly sessionId: SessionId
  readonly orgId: OrgId
}

/** Maps eve lifecycle events to the status chip. eve vocabulary stays in this file. */
const statusOf = (
  eveType: string,
  payload: Record<string, unknown>,
  actorUserId: UserId | null,
  turnId: TurnId | null,
): ThreadStatus | undefined => {
  switch (eveType) {
    case "session.started":
    case "session.waiting":
    case "turn.completed":
    case "turn.cancelled":
    case "context.cleared":
    case "compaction.completed":
      return { kind: "ready" }
    case "turn.started":
    case "action.result":
    case "subagent.completed":
      return { kind: "thinking", turnId }
    case "actions.requested": {
      const first = rec(arr(payload["actions"] ?? payload["calls"] ?? payload["toolCalls"])[0])
      return {
        kind: "running",
        tool: str(first["toolName"]) ?? str(first["name"]) ?? "tool",
        turnId,
      }
    }
    case "input.requested":
      return { kind: "waitingOnYou" }
    case "authorization.required":
      return actorUserId === null
        ? undefined
        : {
            kind: "waitingOnSignIn",
            service: str(payload["name"]) ?? "service",
            forUserId: actorUserId,
          }
    case "subagent.called":
      return { kind: "waitingOnSubagent", name: str(payload["name"]) ?? "subagent" }
    case "compaction.requested":
      return { kind: "compacting" }
    default:
      return undefined
  }
}

const decodeItem = Schema.decodeUnknownSync(TimelineItem)
const encodeItem = Schema.encodeSync(TimelineItem)

/** For `message.appended` coalescing: eve keys a text block by this triple. */
const blockKeyOf = (input: AppendInput): { key: string; isAppend: boolean } | null => {
  const data = input.data
  if (data._tag !== "EveMirrored") return null
  if (data.eveType !== "message.appended" && data.eveType !== "message.completed") return null
  const payload = rec(data.payload)
  const turnId = str(payload["turnId"])
  if (turnId === undefined) return null
  return {
    key: `${turnId}/${num(payload["stepIndex"]) ?? 0}/${num(payload["sequence"]) ?? 0}`,
    isAppend: data.eveType === "message.appended",
  }
}

/**
 * Within one flush window, a later delta for the same text block carries the
 * whole cumulative text, so earlier `message.appended` rows are pure disk
 * noise: drop them. Completed events are always kept -- eve retries steps
 * under fresh ids and the mirror legitimately holds both attempts.
 */
const coalesceAppends = (batch: ReadonlyArray<PendingEvent>): Array<AppendInput> => {
  const seen = new Set<string>()
  const kept: Array<AppendInput> = []
  for (let i = batch.length - 1; i >= 0; i--) {
    const input = batch[i]!.append
    const block = blockKeyOf(input)
    if (block !== null) {
      if (block.isAppend && seen.has(block.key)) continue
      seen.add(block.key)
    }
    kept.push(input)
  }
  return kept.reverse()
}

/** Last write per row wins inside one flush; the projector already folded them in order. */
const coalesceRows = (changes: ReadonlyArray<RowChange>): Array<RowChange> => {
  const byKey = new Map<string, RowChange>()
  for (const change of changes) {
    const key =
      change.kind === "timeline"
        ? `t:${change.row.item.id}`
        : change.kind === "participant"
          ? `p:${change.row.threadId}/${change.row.botId}`
          : change.kind === "thread"
            ? `h:${change.row.id}`
            : `x:${byKey.size}`
    byKey.set(key, change)
  }
  return [...byKey.values()]
}

/* --- the service --------------------------------------------------------------- */

const make = Effect.gen(function* () {
  const config = yield* EvieConfig
  const db = yield* Db
  const sql = yield* SqlClient.SqlClient
  const store = yield* EventStore
  const supervisor = yield* Supervisor
  const httpClient = yield* HttpClient.HttpClient
  const wake = yield* ReactorWake

  const deltas = yield* PubSub.unbounded<ThreadDelta>()

  /** One shared read model; threads are loaded into it lazily and never evicted. */
  const model = emptyReadModel()
  const loadWaiters = new Map<string, Deferred.Deferred<void, SqlError>>()

  /* --- turn attribution -------------------------------------------------------
   * eve does not echo the caller on stream events, so the adapter remembers who
   * it dispatched for (FIFO per session) and pins that member to the turn id it
   * sees on the next `turn.started`. An approximation under steering, and the
   * honest one available. */
  const pendingActors = new Map<string, Array<UserId>>()
  const turnActors = new Map<string, Map<string, UserId>>()

  const pushPendingActor = (sessionId: SessionId, userId: UserId) => {
    const pending = pendingActors.get(sessionId) ?? []
    pending.push(userId)
    if (pending.length > 32) pending.shift()
    pendingActors.set(sessionId, pending)
  }
  const assignActor = (sessionId: SessionId, turnId: string) => {
    const userId = pendingActors.get(sessionId)?.shift()
    if (userId === undefined) return
    const byTurn = turnActors.get(sessionId) ?? new Map<string, UserId>()
    byTurn.set(turnId, userId)
    if (byTurn.size > 128) {
      const oldest = byTurn.keys().next().value
      if (oldest !== undefined) byTurn.delete(oldest)
    }
    turnActors.set(sessionId, byTurn)
  }
  const actorFor = (sessionId: SessionId, turnId: string | null): UserId | null =>
    turnId === null ? null : (turnActors.get(sessionId)?.get(turnId) ?? null)

  /**
   * The identity on machine-to-machine reads (the NDJSON stream). eve verifies
   * the signature and audience; the principal never sends a turn, so it never
   * resolves a member-scoped credential.
   */
  const serverActor = (orgId: OrgId): Actor => ({
    userId: "evie" as UserId,
    orgId,
    role: "owner",
  })

  /* --- HTTP ------------------------------------------------------------------ */

  const postSession = Effect.fn("EveAdapter.post")(function* (
    botId: BotId,
    actor: Actor,
    path: string,
    body: Record<string, unknown>,
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* supervisor.acquire(botId)
        const conn = yield* runtime.connection
        const request = yield* HttpClientRequest.post(`${conn.baseUrl}/eve/v1${path}`).pipe(
          HttpClientRequest.bearerToken(conn.mintToken(actor)),
          HttpClientRequest.bodyJson(body),
          Effect.mapError(
            (error) => new RuntimeUnavailable({ botId, reason: `request encoding failed: ${String(error)}` }),
          ),
        )
        const response = yield* httpClient
          .execute(request)
          .pipe(
            Effect.mapError(
              (error) => new RuntimeUnavailable({ botId, reason: `eve did not answer: ${String(error)}` }),
            ),
          )
        const json = yield* response.json.pipe(Effect.orElseSucceed(() => ({}) as unknown))
        if (response.status === 409) {
          // eve's "session_not_active" and friends: the command no longer makes
          // sense, which is the caller's problem, not the runtime's.
          return yield* new InvalidCommand({
            reason: str(rec(json)["code"]) ?? "session_not_active",
          })
        }
        if (response.status >= 400) {
          return yield* new RuntimeUnavailable({
            botId,
            reason: `eve rejected the request with status ${response.status}`,
          })
        }
        return json
      }),
    )
  })

  const dispatch: EveAdapterShape["dispatch"] = Effect.fn("EveAdapter.dispatch")(function* (
    input,
  ) {
    const body: Record<string, unknown> = {
      message: input.message,
      turnPolicy: input.turnPolicy,
      ...(input.clientContext === undefined ? {} : { clientContext: input.clientContext }),
      ...(input.sessionId === null && input.operationId !== undefined
        ? { operationId: input.operationId }
        : {}),
    }
    const path = input.sessionId === null ? "/session" : `/session/${input.sessionId}`
    const json = rec(yield* postSession(input.botId, input.actor, path, body))
    const returned = str(json["sessionId"])
    const sessionId = input.sessionId ?? (returned as SessionId | undefined)
    if (sessionId === undefined) {
      return yield* new RuntimeUnavailable({
        botId: input.botId,
        reason: "eve accepted the turn but returned no session id",
      })
    }
    pushPendingActor(sessionId, input.actor.userId)
    return { sessionId }
  })

  const answerInput: EveAdapterShape["answerInput"] = (input) =>
    postSession(input.botId, input.actor, `/session/${input.sessionId}`, {
      inputResponses: input.responses,
    }).pipe(Effect.asVoid)

  const cancel: EveAdapterShape["cancel"] = (input) =>
    postSession(
      input.botId,
      input.actor,
      `/session/${input.sessionId}/cancel`,
      input.turnId === undefined ? {} : { turnId: input.turnId },
    ).pipe(Effect.asVoid)

  const compact: EveAdapterShape["compact"] = (input) =>
    postSession(input.botId, input.actor, `/session/${input.sessionId}/compact`, {}).pipe(
      Effect.asVoid,
    )

  const clear: EveAdapterShape["clear"] = (input) =>
    postSession(input.botId, input.actor, `/session/${input.sessionId}/clear`, {}).pipe(
      Effect.asVoid,
    )

  /* --- read-model loading ------------------------------------------------------ */

  const loadThread = Effect.fn("EveAdapter.loadThread")(function* (threadId: ThreadId) {
    const threads = yield* sql<{
      org_id: string
      title: string | null
      created_by: string | null
      created_at: number | bigint
      last_activity: number | bigint
      snoozed_until: number | bigint | null
      archived_at: number | bigint | null
    }>`select * from thread where id = ${threadId}`
    const thread = threads[0]
    if (thread === undefined) return
    if (!model.threads.has(threadId)) {
      model.threads.set(threadId, {
        id: threadId,
        orgId: thread.org_id,
        title: thread.title,
        createdBy: thread.created_by,
        createdAt: Number(thread.created_at),
        lastActivity: Number(thread.last_activity),
        snoozedUntil: thread.snoozed_until === null ? null : Number(thread.snoozed_until),
        archivedAt: thread.archived_at === null ? null : Number(thread.archived_at),
      })
    }

    const participants = yield* sql<{
      bot_id: string
      eve_session_id: string | null
      stream_index: number | bigint
      is_default: number | bigint
    }>`select * from thread_participant where thread_id = ${threadId}`
    for (const row of participants) {
      const key = `${threadId}/${row.bot_id}`
      if (!model.participants.has(key)) {
        model.participants.set(key, {
          threadId,
          botId: row.bot_id as BotId,
          eveSessionId: row.eve_session_id,
          streamIndex: Number(row.stream_index),
          isDefault: Number(row.is_default) === 1,
        })
      }
    }

    if (!model.timelines.has(threadId)) {
      const timeline: ThreadTimeline = {
        nextSeq: 1,
        items: new Map(),
        toolByCall: new Map(),
        inputByRequest: new Map(),
        authByName: new Map(),
        subagentBySession: new Map(),
      }
      model.timelines.set(threadId, timeline)
      const items = yield* sql<{
        actor_user_id: string | null
        body: string
      }>`select actor_user_id, body from timeline_item where thread_id = ${threadId} order by seq asc`
      for (const row of items) {
        // One undecodable row (an old contract version, say) must not take the
        // whole thread down; the projection is rebuildable from the mirror.
        let item: TimelineItem
        try {
          item = decodeItem(JSON.parse(row.body))
        } catch {
          continue
        }
        timeline.items.set(item.id, { threadId, item, actorUserId: row.actor_user_id })
        timeline.nextSeq = Math.max(timeline.nextSeq, item.seq + 1)
        switch (item.kind) {
          case "tool":
            timeline.toolByCall.set(item.callId, item.id)
            break
          case "input":
            timeline.inputByRequest.set(item.requestId, item.id)
            break
          case "auth":
            timeline.authByName.set(`${item.botId}/${item.displayName}`, item.id)
            break
          case "subagent":
            timeline.subagentBySession.set(item.childSessionId, item.id)
            break
          default:
            break
        }
      }
    }
  })

  const ensureThreadLoaded = (threadId: ThreadId): Effect.Effect<void, SqlError> =>
    Effect.suspend(() => {
      const existing = loadWaiters.get(threadId)
      if (existing !== undefined) return Deferred.await(existing)
      const waiter = Deferred.makeUnsafe<void, SqlError>()
      loadWaiters.set(threadId, waiter)
      return loadThread(threadId).pipe(
        Effect.onExit((exit) =>
          Effect.suspend(() => {
            // A failed load must not poison every later attach.
            if (Exit.isFailure(exit)) loadWaiters.delete(threadId)
            return Deferred.done(waiter, exit)
          }),
        ),
      )
    })

  /* --- persistence (the flush tick) --------------------------------------------- */

  const persistTimeline = (row: TimelineRow) => {
    const item = row.item
    const botId = "botId" in item ? item.botId : null
    const turnId = "turnId" in item ? item.turnId : null
    return sql`
      insert into timeline_item (id, thread_id, seq, kind, bot_id, actor_user_id, turn_id, body, at)
      values (${item.id}, ${row.threadId}, ${item.seq}, ${item.kind}, ${botId},
              ${row.actorUserId}, ${turnId}, ${JSON.stringify(encodeItem(item))}, ${item.at})
      on conflict (id) do update set
        kind = excluded.kind,
        actor_user_id = excluded.actor_user_id,
        turn_id = excluded.turn_id,
        body = excluded.body,
        at = excluded.at`
  }

  const persistParticipant = (row: ParticipantRow) =>
    sql`
      insert into thread_participant (thread_id, bot_id, eve_session_id, stream_index, is_default)
      values (${row.threadId}, ${row.botId}, ${row.eveSessionId}, ${row.streamIndex},
              ${row.isDefault ? 1 : 0})
      on conflict (thread_id, bot_id) do update set
        eve_session_id = excluded.eve_session_id,
        stream_index = excluded.stream_index`

  const persistChange = (change: RowChange) => {
    switch (change.kind) {
      case "timeline":
        return persistTimeline(change.row)
      case "participant":
        return persistParticipant(change.row)
      case "thread":
        return sql`update thread set last_activity = ${change.row.lastActivity} where id = ${change.row.id}`
      default:
        // Mirror ingestion only ever yields the three kinds above; product-event
        // projection (bots, routines, connections) is the Projector's job.
        return Effect.void
    }
  }

  /**
   * The participant row IS the resume cursor. It advances to one past the last
   * event of THIS batch -- inside the same transaction as the batch, so a crash
   * between flushes re-reads instead of losing (or skipping) events.
   */
  const persistCursor = (ctx: SessionCtx, nextIndex: number) =>
    Effect.suspend(() => {
      const key = `${ctx.threadId}/${ctx.botId}`
      let participant = model.participants.get(key)
      if (participant === undefined) {
        participant = {
          threadId: ctx.threadId,
          botId: ctx.botId,
          eveSessionId: ctx.sessionId,
          streamIndex: 0,
          isDefault: false,
        }
        model.participants.set(key, participant)
      }
      if (participant.streamIndex < nextIndex) participant.streamIndex = nextIndex
      if (participant.eveSessionId !== ctx.sessionId) participant.eveSessionId = ctx.sessionId
      return persistParticipant(participant)
    })

  const flush = Effect.fn("EveAdapter.flush")(function* (
    ctx: SessionCtx,
    batch: ReadonlyArray<PendingEvent>,
  ) {
    if (batch.length === 0) return
    const events = coalesceAppends(batch)
    const rows = coalesceRows(batch.flatMap((pending) => pending.changes))
    const lastIndex = batch[batch.length - 1]!.streamIndex
    yield* db.retryLocked(
      db.withTransaction(
        Effect.gen(function* () {
          // Mirror rows are ingestion, not decisions: no expectedVersion.
          yield* store.append(events, { aggregate: { kind: "thread", id: ctx.threadId } })
          for (const change of rows) yield* persistChange(change)
          yield* persistCursor(ctx, lastIndex + 1)
        }),
      ),
    )
    // Reactors settle turns on mirrored events; wake them now, not on the sweep.
    yield* wake.notify
  })

  /**
   * Demand-scheduled, not periodic: the first pending event arms a 50 ms wait,
   * the flush drains everything that accumulated, and an idle stream holds no
   * timer at all -- `take` just parks (03, "Frame budget", same cadence).
   */
  const flushLoop = (ctx: SessionCtx, queue: Queue.Queue<PendingEvent, Cause.Done>) =>
    Effect.gen(function* () {
      while (true) {
        const first = yield* Effect.exit(Queue.take(queue))
        if (Exit.isFailure(first)) return // Done: the stream ended and the tail was taken
        yield* Effect.sleep("50 millis")
        const rest = yield* Queue.clear(queue)
        yield* flush(ctx, [first.value, ...rest])
      }
    })

  /* --- ingestion ----------------------------------------------------------------- */

  interface IngestState {
    nextIndex: number
    terminal: boolean
    lastStatus: string | undefined
  }

  const handleLine = (
    ctx: SessionCtx,
    state: IngestState,
    queue: Queue.Queue<PendingEvent, Cause.Done>,
    line: unknown,
  ): Effect.Effect<void> =>
    Effect.suspend(() => {
      const record = rec(line)
      const eveType = str(record["type"])
      const index = state.nextIndex++
      if (eveType === undefined) return Effect.void
      const payload = rec(record["data"])
      const meta = rec(record["meta"])

      if (eveType === "turn.started") {
        const startedTurn = str(payload["turnId"])
        if (startedTurn !== undefined) assignActor(ctx.sessionId, startedTurn)
      }
      if (eveType === "session.completed" || eveType === "session.failed") {
        state.terminal = true
      }

      const turnId = str(payload["turnId"]) ?? null
      const actorUserId = actorFor(ctx.sessionId, turnId)

      // Reasoning deltas: to the hub and gone. Never mirrored, never queued --
      // the resume cursor simply moves past them with the next persisted event.
      if (eveType === "reasoning.appended" && !config.flags.persistReasoning) {
        const text = str(payload["delta"]) ?? str(payload["text"]) ?? ""
        return PubSub.publish(deltas, {
          _tag: "reasoning",
          threadId: ctx.threadId,
          botId: ctx.botId,
          turnId,
          text,
        }).pipe(Effect.asVoid)
      }
      const payloadForMirror =
        eveType === "reasoning.completed" && !config.flags.persistReasoning
          ? stripReasoningText(payload)
          : payload

      const id = (str(meta["id"]) ?? ulid()) as EventId
      const at = millisOf(meta["at"])
      const mirrored = EveMirrored.make({
        threadId: ctx.threadId,
        botId: ctx.botId,
        sessionId: ctx.sessionId,
        streamIndex: index,
        eveType,
        payload: payloadForMirror,
      })
      const stored: StoredEvent = {
        id,
        sessionId: ctx.sessionId,
        seq: 0, // assigned for real on the flush append; the projector never reads it
        orgId: ctx.orgId,
        threadId: ctx.threadId,
        botId: ctx.botId,
        actorUserId,
        streamIndex: index,
        data: mirrored,
        at,
      }

      const changes = apply(model, stored)
      const effects: Array<Effect.Effect<unknown>> = []
      if (changes.length > 0) {
        effects.push(
          PubSub.publish(deltas, {
            _tag: "rows",
            threadId: ctx.threadId,
            botId: ctx.botId,
            changes,
          }),
        )
      }
      // eve names the turn on the events that mean one is running, which is
      // exactly when the composer needs an id to cancel with.
      const status = statusOf(
        eveType,
        payload,
        actorUserId,
        (str(payload["turnId"]) ?? null) as TurnId | null,
      )
      if (status !== undefined) {
        const key = JSON.stringify(status)
        if (key !== state.lastStatus) {
          state.lastStatus = key
          effects.push(
            PubSub.publish(deltas, {
              _tag: "status",
              threadId: ctx.threadId,
              botId: ctx.botId,
              status,
            }),
          )
        }
      }
      effects.push(
        Queue.offer(queue, {
          append: {
            data: mirrored,
            orgId: ctx.orgId,
            threadId: ctx.threadId,
            botId: ctx.botId,
            actorUserId,
            id,
            sessionId: ctx.sessionId,
            streamIndex: index,
            at,
          },
          changes,
          streamIndex: index,
        }),
      )
      return Effect.all(effects, { discard: true })
    })

  /** The last PERSISTED index -- deliberately read from disk, not from memory. */
  const persistedCursor = (threadId: ThreadId, botId: BotId) =>
    sql<{ stream_index: number | bigint }>`
      select stream_index from thread_participant
      where thread_id = ${threadId} and bot_id = ${botId}`.pipe(
      Effect.map((rows) => Number(rows[0]?.stream_index ?? 0)),
    )

  /** One connection's lifetime: connect, consume, drain the flush queue. */
  const ingestOnce = (ctx: SessionCtx) =>
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* supervisor.acquire(ctx.botId)
        const conn = yield* runtime.connection
        const cursor = yield* persistedCursor(ctx.threadId, ctx.botId)
        const response = yield* httpClient.execute(
          HttpClientRequest.get(`${conn.baseUrl}/eve/v1/session/${ctx.sessionId}/stream`).pipe(
            HttpClientRequest.setUrlParam("startIndex", String(cursor)),
            HttpClientRequest.bearerToken(conn.mintToken(serverActor(ctx.orgId))),
          ),
        )
        if (response.status !== 200) {
          return yield* new StreamRefused({ status: response.status })
        }

        const state: IngestState = { nextIndex: cursor, terminal: false, lastStatus: undefined }
        const queue = yield* Queue.unbounded<PendingEvent, Cause.Done>()
        const flusher = yield* Effect.forkScoped(flushLoop(ctx, queue))

        const consumed = yield* Effect.exit(
          response.stream.pipe(
            Stream.pipeThroughChannel(Ndjson.decode({ ignoreEmptyLines: true })),
            Stream.runForEach((line) => handleLine(ctx, state, queue, line)),
          ),
        )
        // End-then-join drains and flushes the tail before this scope closes
        // the runtime lease, whatever the stream's fate was.
        yield* Queue.end(queue)
        yield* Fiber.join(flusher)
        if (Exit.isFailure(consumed)) return yield* Effect.failCause(consumed.cause)
        return state.terminal
      }),
    )

  const attach: EveAdapterShape["attach"] = Effect.fn("EveAdapter.attach")(function* (input) {
    yield* ensureThreadLoaded(input.threadId)
    const thread = model.threads.get(input.threadId)
    if (thread === undefined) {
      return yield* new NotFound({ resource: "thread", id: input.threadId })
    }
    const ctx: SessionCtx = {
      threadId: input.threadId,
      botId: input.botId,
      sessionId: input.sessionId,
      orgId: thread.orgId as OrgId,
    }

    let backoffMs = 1000
    while (true) {
      const outcome = yield* Effect.exit(ingestOnce(ctx))
      if (Exit.isSuccess(outcome)) {
        if (outcome.value) return // terminal session; nothing left to ingest
        backoffMs = 1000 // graceful end without a terminal event: runtime stopped, reattach
      } else {
        const error = Option.getOrUndefined(Cause.findErrorOption(outcome.cause))
        // An unhealthy runtime is not coming back on a retry loop; surface it.
        if (error instanceof RuntimeUnavailable) return yield* Effect.fail(error)
      }
      yield* Effect.sleep(Duration.millis(backoffMs / 2 + Math.random() * backoffMs))
      backoffMs = Math.min(backoffMs * 2, 15_000)
    }
  })

  return {
    dispatch,
    answerInput,
    cancel,
    compact,
    clear,
    attach,
    deltas,
  } satisfies EveAdapterShape
})

export class EveAdapter extends Context.Service<EveAdapter, EveAdapterShape>()("EveAdapter") {
  /** Needs `EvieConfig`, `Db`, `EventStore`, `Supervisor`, and an `HttpClient`. */
  static readonly layer = Layer.effect(EveAdapter, make)
}
