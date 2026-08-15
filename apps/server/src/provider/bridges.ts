import { existsSync } from "node:fs"
import { RuntimeUnavailable } from "@evie/contracts/errors"
import type { BotId, SessionId, ThreadId, UserId } from "@evie/contracts/ids"
import { MemberRole } from "@evie/contracts/org"
import { Effect, Exit, FiberMap, Layer, Schema, Scope } from "effect"
import { Db } from "../db/Db.ts"
import type { Actor } from "../domain/state.ts"
import { CheckpointSources } from "../reactors/checkpoint.ts"
import { RuntimeControl } from "../reactors/supervisor.ts"
import { TurnDispatch, type TurnDispatchShape } from "../reactors/turn.ts"
import { EveAdapter } from "./EveAdapter.ts"
import { Supervisor } from "./Supervisor.ts"

/**
 * The reactors were written against narrow tags (`TurnDispatch`,
 * `RuntimeControl`, `CheckpointSources`) while the provider services were
 * built in parallel. These layers are where the two sides meet: each one is a
 * translation, never new behavior.
 */

const decodeRole = Schema.decodeUnknownSync(MemberRole)

/* --- TurnDispatch: reactors -> EveAdapter ---------------------------------- */

const makeTurnDispatch = Effect.gen(function* () {
  const adapter = yield* EveAdapter
  const db = yield* Db
  const sql = db.sql
  // Attach fibers keyed per (thread, bot): dispatching a turn also ensures the
  // session's stream is being ingested. `onlyIfMissing` keeps an in-flight
  // attach (and its resume cursor) instead of re-connecting per turn.
  const attachments = yield* FiberMap.make<string>()

  /**
   * The adapter wants a full `Actor` (its JWT carries org and role); the
   * reactors only know the acting user. Org comes from the bot row, role from
   * the membership -- a user who has since left the org dispatches as a plain
   * member, which only ever narrows what the runtime may do.
   */
  const actorFor = Effect.fn("bridges.actorFor")(function* (botId: BotId, userId?: UserId) {
    const bots = yield* sql<{ org_id: string }>`select org_id from bot where id = ${botId}`.pipe(
      Effect.mapError(
        (error) => new RuntimeUnavailable({ botId, reason: `bot lookup failed: ${error.message}` }),
      ),
    )
    const orgId = bots[0]?.org_id
    if (orgId === undefined) {
      return yield* new RuntimeUnavailable({ botId, reason: "no such bot" })
    }
    const rows = yield* sql<{ user_id: string; role: string }>`
      select "userId" as user_id, "role" as role from "member"
      where "organizationId" = ${orgId}
        and ${userId === undefined ? sql`"role" = 'owner'` : sql`"userId" = ${userId}`}
      limit 1`.pipe(
      Effect.mapError(
        (error) =>
          new RuntimeUnavailable({ botId, reason: `member lookup failed: ${error.message}` }),
      ),
    )
    const row = rows[0]
    return {
      userId: (userId ?? row?.user_id ?? "") as UserId,
      orgId: orgId as Actor["orgId"],
      role: row === undefined ? "member" : decodeRole(row.role),
    } satisfies Actor
  })

  /** eve's typed refusal (a 409, say) keeps the reactor channel's one error type. */
  const asUnavailable =
    (botId: BotId) =>
    <A, R>(
      effect: Effect.Effect<A, RuntimeUnavailable | { readonly reason: string }, R>,
    ): Effect.Effect<A, RuntimeUnavailable, R> =>
      Effect.catch(effect, (error) =>
        error instanceof RuntimeUnavailable
          ? Effect.fail(error)
          : Effect.fail(new RuntimeUnavailable({ botId, reason: `eve refused: ${error.reason}` })),
      )

  /**
   * Which session each (thread, bot) attachment is reading.
   *
   * `onlyIfMissing` keeps one ingest fiber per thread and bot, which is the
   * right invariant -- but on its own it cannot tell "already attached" from
   * "attached to a session that is gone". When a turn opens a fresh session
   * (see `TurnReactor`'s retry), the slot was still occupied by the previous
   * session's fiber, so the new stream was never read: eve ran the turn, and
   * Evie sat on `step.started` forever with no error and no reply. This map is
   * what makes the difference observable.
   */
  const attachedTo = new Map<string, SessionId>()

  const ensureAttached = (threadId: ThreadId, botId: BotId, sessionId: SessionId) =>
    Effect.gen(function* () {
      const key = `${threadId}/${botId}`
      if (attachedTo.get(key) !== sessionId) {
        // Interrupts the fiber reading the old session before claiming the slot.
        yield* FiberMap.remove(attachments, key)
        attachedTo.set(key, sessionId)
      }
      yield* FiberMap.run(
        attachments,
        key,
        Effect.scoped(adapter.attach({ threadId, botId, sessionId })).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("bridges: attach ended", { threadId, botId }, cause),
          ),
          // Leaving a stale entry would make the next dispatch think it is
          // still attached to a session that has finished.
          Effect.ensuring(
            Effect.sync(() => {
              if (attachedTo.get(key) === sessionId) attachedTo.delete(key)
            }),
          ),
        ),
        { onlyIfMissing: true },
      )
    })

  return {
    dispatchTurn: Effect.fn("bridges.dispatchTurn")(function* (input) {
      const actor = yield* actorFor(input.botId, input.actingAs)
      const { sessionId } = yield* asUnavailable(input.botId)(
        adapter.dispatch({
          threadId: input.threadId,
          botId: input.botId,
          sessionId: input.sessionId,
          message: input.message,
          actor,
          turnPolicy: input.turnPolicy,
          // Both from Evie's turn id, for two different jobs: eve dedupes
          // session creation on `operationId`, and the adapter pins `turnId`
          // to eve's own turn reference so the status chip can carry an id
          // `CancelTurn` will match.
          turnId: input.turnId,
          operationId: input.turnId,
        }),
      )
      yield* ensureAttached(input.threadId, input.botId, sessionId)
      return { sessionId }
    }),
    respondInput: Effect.fn("bridges.respondInput")(function* (input) {
      const actor = yield* actorFor(input.botId, input.actingAs)
      yield* asUnavailable(input.botId)(
        adapter.answerInput({
          botId: input.botId,
          sessionId: input.sessionId,
          actor,
          responses: [
            {
              requestId: input.requestId,
              ...(input.optionId === null ? {} : { optionId: input.optionId }),
            },
          ],
        }),
      )
    }),
    cancelTurn: Effect.fn("bridges.cancelTurn")(function* (input) {
      const actor = yield* actorFor(input.botId)
      yield* asUnavailable(input.botId)(
        adapter.cancel({
          botId: input.botId,
          sessionId: input.sessionId,
          actor,
          turnId: input.turnId,
        }),
      )
    }),
    compactSession: Effect.fn("bridges.compactSession")(function* (input) {
      const actor = yield* actorFor(input.botId)
      yield* asUnavailable(input.botId)(
        adapter.compact({ botId: input.botId, sessionId: input.sessionId, actor }),
      )
    }),
    clearSession: Effect.fn("bridges.clearSession")(function* (input) {
      const actor = yield* actorFor(input.botId)
      yield* asUnavailable(input.botId)(
        adapter.clear({ botId: input.botId, sessionId: input.sessionId, actor }),
      )
    }),
    resumeThread: Effect.fn("bridges.resumeThread")(function* (threadId) {
      /*
       * Every participant of this thread that holds a session handle and has a
       * turn nobody has settled. `TurnSettled` is matched on the turn id rather
       * than on recency because a settled turn is settled whenever it happened,
       * and an unsettled one is the whole reason to be here.
       */
      const rows = yield* sql<{ bot_id: string; eve_session_id: string }>`
        select tp.bot_id, tp.eve_session_id from thread_participant tp
        where tp.thread_id = ${threadId} and tp.eve_session_id is not null
          and exists (
            select 1 from event d
            where d.session_id = '' and d.type = 'TurnDispatched'
              and d.thread_id = ${threadId} and d.bot_id = tp.bot_id
              and json_extract(d.data, '$.turnId') not in (
                select json_extract(s.data, '$.turnId') from event s
                where s.session_id = '' and s.type = 'TurnSettled' and s.bot_id = tp.bot_id))`
      for (const row of rows) {
        // "Ensuring", not "resuming": `ensureAttached` is a no-op when this
        // (thread, bot) is already being ingested, which is the common case.
        yield* Effect.logInfo("bridges: ensuring ingestion for an unsettled turn", {
          threadId,
          botId: row.bot_id,
        })
        yield* ensureAttached(threadId, row.bot_id as BotId, row.eve_session_id as SessionId)
      }
    }, Effect.catchCause((cause) =>
      // Best-effort: a thread that cannot be resumed still has to open.
      Effect.logWarning("bridges: resume failed", cause),
    )),
  } satisfies TurnDispatchShape
})

export const TurnDispatchLive = Layer.effect(TurnDispatch, makeTurnDispatch)

/* --- RuntimeControl: reactors -> Supervisor --------------------------------- */

const makeRuntimeControl = Effect.gen(function* () {
  const supervisor = yield* Supervisor

  // One held lease per bot. The supervisor's RcMap frees a runtime when its
  // last holder lets go; this map is the reactor-side holder, released by
  // `stop` (idle or shutdown) and by this layer's own teardown.
  const held = new Map<string, { readonly scope: Scope.Closeable; readonly port: number }>()

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      for (const lease of held.values()) yield* Scope.close(lease.scope, Exit.void)
      held.clear()
    }),
  )

  return RuntimeControl.of({
    acquire: Effect.fn("bridges.runtimeAcquire")(function* (botId) {
      const existing = held.get(botId)
      if (existing !== undefined) return { port: existing.port, fresh: false }
      const scope = yield* Scope.make()
      const outcome = yield* Effect.exit(
        Effect.gen(function* () {
          const runtime = yield* Scope.provide(supervisor.acquire(botId), scope)
          return yield* runtime.connection
        }),
      )
      if (Exit.isFailure(outcome)) {
        yield* Scope.close(scope, Exit.void)
        return yield* Effect.failCause(outcome.cause)
      }
      const port = Number(new URL(outcome.value.baseUrl).port)
      held.set(botId, { scope, port })
      return { port, fresh: true }
    }),
    stop: (botId) =>
      Effect.gen(function* () {
        const lease = held.get(botId)
        held.delete(botId)
        if (lease !== undefined) yield* Scope.close(lease.scope, Exit.void)
        // Invalidate kills the runtime now; the RcMap TTL alone would keep it
        // warm for the whole idle window after the lease drops.
        yield* supervisor.invalidate(botId)
      }),
  })
})

export const RuntimeControlLive = Layer.effect(RuntimeControl, makeRuntimeControl)

/* --- CheckpointSources: reactors -> the bot workspace ----------------------- */

/**
 * In `dev` runtime mode the workspace IS the bot project directory on the
 * host (the `bot.dir` column). A missing row or directory skips the
 * checkpoint rather than failing it.
 */
const makeCheckpointSources = Effect.gen(function* () {
  const db = yield* Db
  const sql = db.sql
  return CheckpointSources.of({
    workspacePath: (botId) =>
      sql<{ dir: string }>`select dir from bot where id = ${botId}`.pipe(
        Effect.map((rows) => {
          const dir = rows[0]?.dir
          return dir !== undefined && existsSync(dir) ? dir : null
        }),
        Effect.mapError(
          (error) =>
            new RuntimeUnavailable({ botId, reason: `bot lookup failed: ${error.message}` }),
        ),
      ),
  })
})

export const CheckpointSourcesLive = Layer.effect(CheckpointSources, makeCheckpointSources)
