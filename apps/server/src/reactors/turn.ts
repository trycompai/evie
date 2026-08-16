import { RuntimeUnavailable } from "@evie/contracts/errors"
import { InputAnswered, TurnDispatched, TurnSettled, type StoredEvent } from "@evie/contracts/events"
import type { BotId, SessionId, ThreadId, TurnId, UserId } from "@evie/contracts/ids"
import { Context, Effect } from "effect"
import type { SqlError } from "effect/unstable/sql/SqlError"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { EventStore, type EventStoreShape } from "../store/EventStore.ts"
import { deriveUlid, reactorLayer, type Commit } from "./runtime.ts"

/**
 * TurnReactor: `MessageSent` / `InputAnswered` -> a dispatched eve turn, and
 * the mirrored settle events -> `TurnSettled`.
 *
 * Every dispatch runs under a turn id derived deterministically from the
 * triggering event's id, so a replayed dispatch after a crash is a no-op
 * against eve rather than a duplicate turn. The receipt append carries a
 * deterministic id for the same reason.
 */

/**
 * The narrow slice of `EveAdapter` this reactor needs, defined here because
 * the adapter is being written concurrently. The adapter's agent provides the
 * layer for this tag; the contract it must honor is in each method's comment.
 */
export interface TurnDispatchShape {
  /**
   * Send a message as a turn. `sessionId: null` means create the session with
   * this message (POST /eve/v1/session). MUST be idempotent under `turnId`:
   * a second call with the same turn id -- a crash replay -- must not start a
   * second eve turn (session creation uses it as eve's `operationId`).
   */
  readonly dispatchTurn: (input: {
    readonly botId: BotId
    readonly threadId: ThreadId
    readonly sessionId: SessionId | null
    readonly turnId: TurnId
    readonly actingAs: UserId
    readonly message: string
    readonly turnPolicy: "steer" | "queue"
  }) => Effect.Effect<{ readonly sessionId: SessionId }, RuntimeUnavailable>
  /** Forward an input answer to its pending request. Answers never steer. */
  readonly respondInput: (input: {
    readonly botId: BotId
    readonly sessionId: SessionId
    readonly actingAs: UserId
    readonly requestId: string
    readonly optionId: string | null
    readonly scope: string | null
  }) => Effect.Effect<void, RuntimeUnavailable>
  /** Cancel the active turn. `turnId` is Evie's id; the adapter owns the mapping to eve's. */
  readonly cancelTurn: (input: {
    readonly botId: BotId
    readonly sessionId: SessionId
    readonly turnId: TurnId
  }) => Effect.Effect<void, RuntimeUnavailable>
  readonly compactSession: (input: {
    readonly botId: BotId
    readonly sessionId: SessionId
  }) => Effect.Effect<void, RuntimeUnavailable>
  readonly clearSession: (input: {
    readonly botId: BotId
    readonly sessionId: SessionId
  }) => Effect.Effect<void, RuntimeUnavailable>
  /**
   * Re-attach ingestion for a thread whose turn is still running.
   *
   * Attaching to an eve session had exactly one trigger -- dispatching a turn
   * -- and eve sessions outlive Evie. Restart the server while a bot is
   * working and the turn keeps running inside eve with nobody reading it: the
   * thread freezes at whatever it had rendered, with a spinner that is telling
   * the truth about eve and a lie about Evie, and it stays that way until
   * somebody sends another message. `specs/01` promises the opposite -- that
   * any client attaches and takes over. The resume cursor was already durable;
   * only this trigger was missing.
   *
   * Idempotent, and cheap when there is nothing to do: an already-attached
   * (thread, bot) keeps its existing fiber and its cursor.
   */
  readonly resumeThread: (threadId: ThreadId) => Effect.Effect<void>
}

export class TurnDispatch extends Context.Service<TurnDispatch, TurnDispatchShape>()(
  "provider/TurnDispatch",
) {}

/** eve settle events and the outcome each one means for the active turn. */
const SETTLE_OUTCOMES: Record<string, "completed" | "cancelled" | "failed"> = {
  "turn.completed": "completed",
  "turn.cancelled": "cancelled",
  "turn.failed": "failed",
  // A session-level failure settles whatever turn was in flight.
  "session.failed": "failed",
}

interface ParticipantRow {
  readonly bot_id: string
  readonly eve_session_id: string | null
}

/**
 * The commit both dispatch paths (this reactor and RoutineReactor) share:
 * pin the participant row's session and append the `TurnDispatched` receipt.
 * The projector derives the same participant update from the receipt; writing
 * it here too keeps the row correct before the projection pipeline lands, and
 * the upsert is idempotent either way.
 */
export const dispatchCommit = (
  sql: SqlClient.SqlClient,
  store: EventStoreShape,
  input: {
    readonly triggerEventId: string
    readonly orgId: string
    readonly threadId: ThreadId
    readonly botId: BotId
    readonly turnId: TurnId
    readonly sessionId: SessionId
    readonly actingAs: UserId
  },
): Commit =>
  Effect.gen(function* () {
    yield* sql`
      insert into thread_participant (thread_id, bot_id, eve_session_id)
      values (${input.threadId}, ${input.botId}, ${input.sessionId})
      on conflict (thread_id, bot_id) do update set eve_session_id = excluded.eve_session_id`
    yield* store.append(
      [
        {
          id: deriveUlid(input.triggerEventId, input.botId, "dispatched"),
          data: TurnDispatched.make({
            threadId: input.threadId,
            botId: input.botId,
            turnId: input.turnId,
            sessionId: input.sessionId,
            actingAs: input.actingAs,
          }),
          orgId: input.orgId,
          threadId: input.threadId,
          botId: input.botId,
          actorUserId: input.actingAs,
        },
      ],
      { aggregate: { kind: "thread", id: input.threadId } },
    )
  })

/**
 * eve stream events after which a session cannot be used again.
 *
 * A turn failing is ordinary and the session survives it; the *session* failing
 * or ending is not, and the handle has to be dropped or the thread never speaks
 * again.
 */
const TERMINAL_SESSION = new Set(["session.failed", "session.ended", "session.aborted"])

/**
 * Evie's turn id for one message to one bot.
 *
 * Derived rather than minted, so a replay dispatches the same turn and
 * "was this already dispatched?" is a lookup instead of a heuristic.
 */
const turnIdFor = (triggerEventId: string, botId: BotId): TurnId =>
  deriveUlid(triggerEventId, botId, "turn") as TurnId

/**
 * What a freshly provisioned bot is asked so its first words are its own.
 * The prompt is invisible in Evie's timeline -- only `MessageSent` events
 * render as user bubbles -- so the user sees the introduction alone.
 */
const GREETING_PROMPT =
  "You were just created and this is your first conversation. Greet the user in one or two " +
  "short sentences: say who you are and what you can help with, going by your name and " +
  "instructions. Do not use tools, ask nothing, and do not mention this message."

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const store = yield* EventStore
  const dispatch = yield* TurnDispatch

  const participants = (threadId: ThreadId) =>
    sql<ParticipantRow>`
      select bot_id, eve_session_id from thread_participant
      where thread_id = ${threadId}
      order by is_default desc, bot_id asc`

  const sessionOf = Effect.fn("TurnReactor.sessionOf")(function* (
    threadId: ThreadId,
    botId: BotId,
  ) {
    const rows = yield* sql<{ eve_session_id: string | null }>`
      select eve_session_id from thread_participant
      where thread_id = ${threadId} and bot_id = ${botId}`
    return (rows[0]?.eve_session_id ?? null) as SessionId | null
  })

  const handleMessage = (event: StoredEvent, data: Extract<StoredEvent["data"], { _tag: "MessageSent" }>) =>
    Effect.gen(function* () {
      const actingAs = event.actorUserId
      if (actingAs === null) {
        return yield* Effect.logWarning("TurnReactor: MessageSent without an actor; not dispatched", {
          eventId: event.id,
        })
      }
      const rows = yield* participants(data.threadId)
      // Explicit @mentions, else the thread's default participant.
      const recipients =
        data.mentions.length > 0 ? data.mentions : rows.slice(0, 1).map((row) => row.bot_id as BotId)
      if (recipients.length === 0) {
        return yield* Effect.logWarning("TurnReactor: thread has no participant to dispatch to", {
          threadId: data.threadId,
        })
      }
      const commits: Array<Commit> = []
      for (const botId of recipients) {
        const known = (rows.find((row) => row.bot_id === botId)?.eve_session_id ??
          null) as SessionId | null
        commits.push(yield* dispatchMessage(event, data, botId, actingAs, known))
      }
      const commit: Commit = Effect.all(commits)
      return commit
    })

  /** One message to one bot. Shared by the live path and the provisioning catch-up. */
  const dispatchMessage = Effect.fn("TurnReactor.dispatchMessage")(function* (
    event: StoredEvent,
    data: Extract<StoredEvent["data"], { _tag: "MessageSent" }>,
    botId: BotId,
    actingAs: UserId,
    known: SessionId | null,
  ) {
    // Deterministic per (trigger, recipient): a replay dispatches the same turn.
    const turnId = turnIdFor(event.id, botId)
    const send = (sessionId: SessionId | null) =>
      dispatch.dispatchTurn({
        botId,
        threadId: data.threadId,
        sessionId,
        turnId,
        actingAs,
        message: data.text,
        // A new message replaces the in-flight turn, which is what a chat UI implies.
        turnPolicy: "steer",
      })

    /*
     * A session eve will not accept is retried once as a fresh one.
     *
     * `handleSessionEnded` drops the handle when eve tells us a session
     * ended, but that only covers sessions we watched die: a runtime that
     * was restarted, or a row written before that rule existed, leaves a
     * handle eve has never heard of. Without this the thread is mute
     * forever and silently -- the refusal is a reactor-channel error the
     * user never sees. Retrying with a new session is what their message
     * plainly meant, and a fresh session is exactly what they would get by
     * starting a new thread.
     */
    const { sessionId } = yield* (known === null
      ? send(null)
      : send(known).pipe(
          Effect.catch((error) =>
            Effect.logWarning("TurnReactor: session refused; opening a fresh one", {
              threadId: data.threadId,
              botId,
              reason: error.reason,
            }).pipe(Effect.andThen(send(null))),
          ),
        ))
    return dispatchCommit(sql, store, {
      triggerEventId: event.id,
      orgId: event.orgId,
      threadId: data.threadId,
      botId,
      turnId,
      sessionId,
      actingAs,
    })
  })

  /**
   * The bot speaks first.
   *
   * `BotProvisioned` now lands only after the runtime answered its health
   * route, so this turn is the last unproven link: dispatch, model call,
   * stream, timeline. Running it before the user types anything means the
   * creation screen hands over to a bot that is visibly talking -- and a
   * missing credential surfaces here, at creation, instead of eating the
   * user's first real message.
   *
   * Attributed to the bot's creator, the same rule `RoutineReactor` uses for a
   * routine with no pinned member. Skipped, not queued, when the bot has no
   * thread yet: only the create flow opens one immediately, and a bot created
   * headless (the API, a fork's script) greeting an empty room helps nobody.
   */
  const greet = Effect.fn("TurnReactor.greet")(function* (
    event: StoredEvent,
    botId: BotId,
    already: ReadonlySet<string>,
  ) {
    const turnId = deriveUlid(event.id, botId, "greeting") as TurnId
    if (already.has(turnId)) return
    const threads = yield* sql<{ thread_id: string }>`
      select tp.thread_id from thread_participant tp
      join thread t on t.id = tp.thread_id
      where tp.bot_id = ${botId} and t.archived_at is null
      order by t.created_at asc limit 1`
    const threadId = threads[0]?.thread_id as ThreadId | undefined
    if (threadId === undefined) {
      return yield* Effect.logInfo("TurnReactor: provisioned bot has no thread; skipping greeting", {
        botId,
      })
    }
    /** BotCreated always came from a command, so its stored event has the actor. */
    const creators = yield* sql<{ actor_user_id: string | null }>`
      select actor_user_id from event
      where session_id = '' and type = 'BotCreated' and bot_id = ${botId}
      limit 1`
    const actingAs = (creators[0]?.actor_user_id ?? null) as UserId | null
    if (actingAs === null) {
      return yield* Effect.logWarning("TurnReactor: no creator to attribute the greeting to", {
        botId,
      })
    }
    const { sessionId } = yield* dispatch.dispatchTurn({
      botId,
      threadId,
      // Provisioning just finished, so there is no session yet.
      sessionId: null,
      turnId,
      actingAs,
      message: GREETING_PROMPT,
      // Nothing to steer; and if a message races in, the human goes first.
      turnPolicy: "queue",
    })
    return dispatchCommit(sql, store, {
      triggerEventId: event.id,
      orgId: event.orgId,
      threadId,
      botId,
      turnId,
      sessionId,
      actingAs,
    })
  })

  /**
   * Sends what arrived while the bot was still being installed.
   *
   * Creating a bot and immediately saying hello is the first thing anyone
   * does, and for the ~15 seconds `npm install` takes there is no runtime to
   * dispatch into. The reactor gives that message five quick retries and then
   * skips it -- correctly, because wedging every thread behind one unstartable
   * bot is worse -- so the greeting was simply gone. No error, no retry, no
   * trace of it outside a server log, on a bot that was working perfectly by
   * the time the user looked at it.
   *
   * `BotProvisioned` is the moment the reason for the failure stops being
   * true, so it is the moment to try again. Turn ids derive from the
   * triggering event, which is what makes "already dispatched" a set
   * membership test rather than a guess -- and what makes running this twice
   * harmless.
   */
  const handleProvisioned = (
    event: StoredEvent,
    data: Extract<StoredEvent["data"], { _tag: "BotProvisioned" }>,
  ) =>
    Effect.gen(function* () {
      const botId = data.botId
      const pending = yield* sql<{
        id: string
        thread_id: string
        actor_user_id: string | null
        org_id: string
        data: string
      }>`
        select e.id, e.thread_id, e.actor_user_id, e.org_id, e.data from event e
        where e.session_id = '' and e.type = 'MessageSent'
          and e.thread_id in (select thread_id from thread_participant where bot_id = ${botId})
        order by e.seq asc`
      const dispatched = yield* sql<{ turn_id: string }>`
        select json_extract(data, '$.turnId') as turn_id from event
        where session_id = '' and type = 'TurnDispatched' and bot_id = ${botId}`
      const already = new Set(dispatched.map((row) => row.turn_id))
      // Nothing waiting: the bot speaks first instead. Answering a waiting
      // message is a better proof of life than a scripted hello, so the two
      // paths are exclusive.
      if (pending.length === 0) return yield* greet(event, botId, already)

      const commits: Array<Commit> = []
      for (const row of pending) {
        if (already.has(turnIdFor(row.id, botId))) continue
        const actingAs = row.actor_user_id
        if (actingAs === null) continue
        let message: Extract<StoredEvent["data"], { _tag: "MessageSent" }>
        try {
          message = JSON.parse(row.data) as typeof message
        } catch {
          continue
        }
        // Only what this bot was actually addressed by, same rule as the live path.
        const addressed =
          message.mentions.length > 0
            ? message.mentions.includes(botId)
            : ((yield* participants(row.thread_id as ThreadId))[0]?.bot_id ?? null) === botId
        if (!addressed) continue
        yield* Effect.logInfo("TurnReactor: dispatching a message that arrived before the bot was installed", {
          botId,
          threadId: row.thread_id,
          eventId: row.id,
        })
        commits.push(
          yield* dispatchMessage(
            { ...event, id: row.id, orgId: row.org_id } as StoredEvent,
            message,
            botId,
            actingAs as UserId,
            // Provisioning has just finished, so there is no session yet.
            null,
          ),
        )
      }
      if (commits.length === 0) return
      const commit: Commit = Effect.all(commits)
      return commit
    })

  const handleAnswer = (event: StoredEvent, data: Extract<StoredEvent["data"], { _tag: "InputAnswered" }>) =>
    Effect.gen(function* () {
      const actingAs = event.actorUserId
      if (actingAs === null) return
      // The request's owner is in the mirrored `input.requested` row. The
      // instr() probe narrows candidates cheaply; the eveType check keeps it honest.
      const probe = `"requestId":"${data.requestId}"`
      const rows = yield* sql<{ bot_id: string; session_id: string }>`
        select bot_id, session_id from event
        where thread_id = ${data.threadId}
          and type = 'EveMirrored'
          and json_extract(data, '$.eveType') = 'input.requested'
          and instr(data, ${probe}) > 0
        order by seq desc limit 1`
      const row = rows[0]
      if (row === undefined) {
        return yield* Effect.logWarning("TurnReactor: no pending request found for answer", {
          requestId: data.requestId,
        })
      }
      /*
       * "Always allow for this session" is Evie's to keep.
       *
       * eve's input-response schema is strict and carries exactly requestId,
       * optionId and text -- there is nowhere to put a scope, and an unknown
       * key would be rejected rather than ignored. So the grant is recorded
       * here and applied by `handleInputRequested` on the next matching
       * request. The answer itself still goes to eve unchanged.
       */
      if (data.scope === "always" && data.optionId !== null) {
        const tool = yield* toolNameFor(data.threadId, data.requestId)
        if (tool !== undefined) {
          yield* sql`
            insert into input_grant (session_id, tool_name, option_id, granted_by, granted_at)
            values (${row.session_id}, ${tool}, ${data.optionId}, ${actingAs}, ${event.at})
            on conflict (session_id, tool_name) do update set
              option_id = excluded.option_id,
              granted_by = excluded.granted_by,
              granted_at = excluded.granted_at`
        }
      }

      yield* dispatch.respondInput({
        botId: row.bot_id as BotId,
        sessionId: row.session_id as SessionId,
        actingAs,
        requestId: data.requestId,
        optionId: data.optionId,
        scope: data.scope,
      })
    })

  /** The tool a mirrored request was gating, read back out of its payload. */
  const toolNameFor = Effect.fn("TurnReactor.toolNameFor")(function* (
    threadId: ThreadId,
    requestId: string,
  ) {
    const probe = `"requestId":"${requestId}"`
    const rows = yield* sql<{ data: string }>`
      select data from event
      where thread_id = ${threadId}
        and type = 'EveMirrored'
        and json_extract(data, '$.eveType') = 'input.requested'
        and instr(data, ${probe}) > 0
      order by seq desc limit 1`
    const raw = rows[0]?.data
    if (raw === undefined) return undefined
    try {
      const payload = JSON.parse(raw) as { payload?: { requests?: ReadonlyArray<Record<string, unknown>> } }
      for (const request of payload.payload?.requests ?? []) {
        if (request["requestId"] !== requestId) continue
        const action = request["action"]
        const nested =
          typeof action === "object" && action !== null
            ? (action as Record<string, unknown>)["toolName"]
            : undefined
        const name = nested ?? request["toolName"]
        return typeof name === "string" ? name : undefined
      }
    } catch {
      // A payload we cannot read is a request we cannot grant. Not an error.
    }
    return undefined
  })

  /**
   * Applies a standing grant, if the user gave one.
   *
   * Emits an ordinary `InputAnswered` rather than calling the adapter directly,
   * so the answer travels the one path every other answer takes: the projection
   * marks the card resolved, and `handleAnswer` forwards it. Scoped `once`, or
   * it would re-grant itself on every request forever.
   */
  const handleInputRequested = (
    event: StoredEvent,
    data: Extract<StoredEvent["data"], { _tag: "EveMirrored" }>,
  ) =>
    Effect.gen(function* () {
      const payload = data.payload as { requests?: ReadonlyArray<Record<string, unknown>> } | null
      const requests = payload?.requests ?? []
      if (requests.length === 0) return

      const answers: Array<{ requestId: string; optionId: string; grantedBy: string }> = []
      for (const request of requests) {
        const requestId = request["requestId"]
        if (typeof requestId !== "string") continue
        const action = request["action"]
        const nested =
          typeof action === "object" && action !== null
            ? (action as Record<string, unknown>)["toolName"]
            : undefined
        const tool = nested ?? request["toolName"]
        if (typeof tool !== "string") continue
        const grants = yield* sql<{ option_id: string; granted_by: string }>`
          select option_id, granted_by from input_grant
          where session_id = ${data.sessionId} and tool_name = ${tool} limit 1`
        const grant = grants[0]
        if (grant === undefined) continue
        answers.push({ requestId, optionId: grant.option_id, grantedBy: grant.granted_by })
      }
      if (answers.length === 0) return

      return store.append(
        answers.map((answer, index) => ({
          id: deriveUlid(event.id, `granted-${index}`),
          data: InputAnswered.make({
            threadId: data.threadId,
            requestId: answer.requestId,
            optionId: answer.optionId,
            scope: "once" as const,
          }),
          orgId: event.orgId,
          threadId: data.threadId,
          botId: data.botId,
          // Attributed to whoever granted it. The grant was their decision.
          actorUserId: answer.grantedBy as UserId,
        })),
        { aggregate: { kind: "thread", id: data.threadId } },
      )
    })

  const handleCancel = (data: Extract<StoredEvent["data"], { _tag: "TurnCancelRequested" }>) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ bot_id: string; session_id: string }>`
        select bot_id, json_extract(data, '$.sessionId') as session_id from event
        where session_id = '' and type = 'TurnDispatched'
          and thread_id = ${data.threadId}
          and json_extract(data, '$.turnId') = ${data.turnId}
        limit 1`
      const row = rows[0]
      // Cancelling a turn that never dispatched is a race, not a defect.
      if (row === undefined) return
      yield* dispatch.cancelTurn({
        botId: row.bot_id as BotId,
        sessionId: row.session_id as SessionId,
        turnId: data.turnId,
      })
    })

  const handleSession = (
    threadId: ThreadId,
    botId: BotId,
    call: (input: { botId: BotId; sessionId: SessionId }) => Effect.Effect<void, RuntimeUnavailable>,
  ) =>
    Effect.gen(function* () {
      const sessionId = yield* sessionOf(threadId, botId)
      // No session yet means no context to compact or clear.
      if (sessionId === null) return
      yield* call({ botId, sessionId })
    })

  const handleSettle = (event: StoredEvent, data: Extract<StoredEvent["data"], { _tag: "EveMirrored" }>) =>
    Effect.gen(function* () {
      const outcome = SETTLE_OUTCOMES[data.eveType]
      if (outcome === undefined) return
      // Turns on one session settle in dispatch order, so the settle belongs
      // to the oldest still-open turn of this (thread, bot). eve's own turn id
      // in the payload is not ours to compare against; the adapter minted no
      // mapping we can rely on across a restart, and the log has the order.
      const rows = yield* sql<{ turn_id: string }>`
        select json_extract(data, '$.turnId') as turn_id from event
        where session_id = '' and type = 'TurnDispatched'
          and thread_id = ${data.threadId} and bot_id = ${data.botId}
          and json_extract(data, '$.turnId') not in (
            select json_extract(data, '$.turnId') from event
            where session_id = '' and type = 'TurnSettled'
              and thread_id = ${data.threadId} and bot_id = ${data.botId})
        order by seq asc limit 1`
      const row = rows[0]
      // Nothing open: a turn we did not dispatch, or a replay that already settled.
      if (row === undefined) return
      const commit: Commit = store.append(
        [
          {
            id: deriveUlid(event.id, "settled"),
            data: TurnSettled.make({
              threadId: data.threadId,
              botId: data.botId,
              turnId: row.turn_id as TurnId,
              outcome,
            }),
            orgId: event.orgId,
            threadId: data.threadId,
            botId: data.botId,
            actorUserId: event.actorUserId,
          },
        ],
        { aggregate: { kind: "thread", id: data.threadId } },
      )
      return commit
    })

  /**
   * Forgets a session eve has ended for good.
   *
   * `thread_participant.eve_session_id` is the thread's handle on a live eve
   * session, and nothing used to clear it. So the first terminal failure --
   * a model call with no credentials, say -- left the row pointing at a dead
   * session forever: every later message dispatched into it, eve refused, the
   * refusal was swallowed by the reactor channel, and the thread went silently
   * mute. No error, no reply, nothing to see. Clearing it means the next
   * message opens a fresh session, which is what the user's next message
   * plainly means.
   */
  const handleSessionEnded = (data: Extract<StoredEvent["data"], { _tag: "EveMirrored" }>) =>
    Effect.gen(function* () {
      yield* sql`
        update thread_participant set eve_session_id = null
        where thread_id = ${data.threadId}
          and bot_id = ${data.botId}
          and eve_session_id = ${data.sessionId}`
      yield* Effect.logInfo("TurnReactor: session ended; thread will open a fresh one", {
        threadId: data.threadId,
        eveType: data.eveType,
      })
    })

  return {
    name: "turn" as const,
    handle: (
      event: StoredEvent,
    ): Effect.Effect<Commit | void, SqlError | RuntimeUnavailable> => {
      const data = event.data
      switch (data._tag) {
        case "MessageSent":
          return handleMessage(event, data)
        case "BotProvisioned":
          return handleProvisioned(event, data)
        case "InputAnswered":
          return handleAnswer(event, data)
        case "TurnCancelRequested":
          return handleCancel(data)
        case "SessionCompactRequested":
          return handleSession(data.threadId, data.botId, dispatch.compactSession)
        case "SessionClearRequested":
          return handleSession(data.threadId, data.botId, dispatch.clearSession)
        case "EveMirrored":
          if (data.eveType === "input.requested") return handleInputRequested(event, data)
          if (TERMINAL_SESSION.has(data.eveType)) return handleSessionEnded(data)
          return handleSettle(event, data)
        default:
          return Effect.void
      }
    },
  }
})

/** Provide `TurnDispatch` (the adapter's slice) plus `Db.layer` and `EventStore.layer`. */
export const TurnReactorLive = reactorLayer(make)
