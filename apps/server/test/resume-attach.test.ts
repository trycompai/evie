import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EvieEvent } from "@evie/contracts/events"
import type { BotId, OrgId, SessionId, ThreadId, TurnId, UserId } from "@evie/contracts/ids"
import { resolveHome } from "@evie/shared/home"
import { ulid } from "@evie/shared/ulid"
import { Effect, Layer, PubSub } from "effect"
import { afterAll, describe, expect, it } from "vitest"
import { EvieConfig } from "../src/config.ts"
import { Db } from "../src/db/Db.ts"
import { MigrationsLive } from "../src/db/migrations.ts"
import { EveAdapter } from "../src/provider/EveAdapter.ts"
import { TurnDispatchLive } from "../src/provider/bridges.ts"
import { TurnDispatch } from "../src/reactors/turn.ts"
import { EventStore } from "../src/store/EventStore.ts"

/**
 * A turn that outlived a restart is taken over when the thread is opened.
 *
 * eve sessions are durable: they keep running when Evie stops. Ingestion was
 * not -- `adapter.attach` had exactly one call site, inside `dispatchTurn` --
 * so restarting the server mid-turn left eve working away with nobody reading
 * its stream. The thread froze at whatever had already rendered and stayed
 * frozen until somebody sent another message, which is the "my agent stopped
 * working and never came back" report.
 *
 * Opening the thread is the trigger, so the fix costs nothing on the boots and
 * subscriptions where nothing is running -- which is nearly all of them. That
 * makes the negative cases below the load-bearing ones: attaching to a settled
 * turn would start a runtime, and a stream, every time anyone opened any old
 * conversation.
 *
 * Temp directory, never `~/.evie` -- see rule 2 in AGENTS.md.
 */

const root = mkdtempSync(join(tmpdir(), "evie-resume-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const ConfigTest = Layer.succeed(EvieConfig, {
  home: resolveHome({ EVIE_HOME: root } as NodeJS.ProcessEnv),
  bind: "127.0.0.1",
  port: 0,
  mode: "local",
  idleStopMinutes: 10,
  flags: { persistReasoning: false },
})

const StoreLayer = EventStore.layer.pipe(
  Layer.provideMerge(MigrationsLive),
  Layer.provideMerge(Db.layer),
  Layer.provide(ConfigTest),
)

const orgId = "org_1" as OrgId
const userId = "user_1" as UserId
const session = "wrun_live" as SessionId

/** Records what ingestion was asked to read. The stream itself is not under test. */
const recorder = Effect.gen(function* () {
  const attached: Array<{ threadId: ThreadId; botId: BotId; sessionId: SessionId }> = []
  const deltas = yield* PubSub.unbounded<never>()
  const layer = Layer.succeed(EveAdapter, {
    dispatch: () => Effect.succeed({ sessionId: session }),
    answerInput: () => Effect.void,
    cancel: () => Effect.void,
    compact: () => Effect.void,
    clear: () => Effect.void,
    attach: (input: { threadId: ThreadId; botId: BotId; sessionId: SessionId }) =>
      Effect.sync(() => {
        attached.push({
          threadId: input.threadId,
          botId: input.botId,
          sessionId: input.sessionId,
        })
      }).pipe(
        // A real attach reads the session's stream until the scope closes, so
        // its fiber is long-lived -- which is the whole reason `ensureAttached`
        // can use `onlyIfMissing` to mean "already ingesting". A fake that
        // returned immediately would free the slot and make re-attachment look
        // idempotent when it is not.
        Effect.andThen(Effect.never),
      ),
    deltas,
  } as unknown as typeof EveAdapter.Service)
  return { attached, layer }
})

const turnDispatched = (threadId: ThreadId, botId: BotId, turnId: string): EvieEvent =>
  ({
    _tag: "TurnDispatched",
    threadId,
    botId,
    turnId: turnId as TurnId,
    sessionId: session,
    actingAs: userId,
  }) as EvieEvent

const turnSettled = (threadId: ThreadId, botId: BotId, turnId: string): EvieEvent =>
  ({
    _tag: "TurnSettled",
    threadId,
    botId,
    turnId: turnId as TurnId,
    outcome: "completed",
  }) as EvieEvent

/** A thread with one bot mid-turn: a session handle and a dispatch nobody settled. */
const seedThread = (options: { readonly settled: boolean; readonly sessionId: string | null }) =>
  Effect.gen(function* () {
    const botId = ulid() as BotId
    const threadId = ulid() as ThreadId
    const turnId = ulid()
    const db = yield* Db
    const store = yield* EventStore
    yield* db.sql`
      insert into bot (id, org_id, slug, name, dir, model, sandbox, created_by, created_at)
      values (${botId}, ${orgId}, ${botId}, 'Bot', ${join(root, "bots", botId)},
              'anthropic/claude-opus-4.8', '{}', ${userId}, 0)`
    yield* db.sql`
      insert into thread (id, org_id, title, created_by, created_at, last_activity)
      values (${threadId}, ${orgId}, null, ${userId}, 0, 0)`
    yield* db.sql`
      insert into thread_participant (thread_id, bot_id, eve_session_id, stream_index, is_default)
      values (${threadId}, ${botId}, ${options.sessionId}, 0, 1)`
    yield* store.append([{ data: turnDispatched(threadId, botId, turnId), orgId, threadId, botId }], {
      aggregate: { kind: "thread", id: threadId },
    })
    if (options.settled) {
      yield* store.append([{ data: turnSettled(threadId, botId, turnId), orgId, threadId, botId }], {
        aggregate: { kind: "thread", id: threadId },
      })
    }
    return { botId, threadId }
  })

const withDispatch = <A, E>(
  body: (
    turns: typeof TurnDispatch.Service,
    attached: ReadonlyArray<{ threadId: ThreadId; botId: BotId; sessionId: SessionId }>,
  ) => Effect.Effect<A, E, Db | EventStore>,
) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const fake = yield* recorder
        return yield* Effect.provide(
          Effect.gen(function* () {
            const turns = yield* TurnDispatch
            return yield* body(turns, fake.attached)
          }),
          TurnDispatchLive.pipe(Layer.provide(fake.layer)),
        )
      }),
      StoreLayer,
    ) as Effect.Effect<A>,
  )

describe("opening a thread takes over a turn that outlived a restart", () => {
  it("attaches to the session of an unsettled turn", async () => {
    const attached = await withDispatch((turns, recorded) =>
      Effect.gen(function* () {
        const { botId, threadId } = yield* seedThread({ settled: false, sessionId: session })
        yield* turns.resumeThread(threadId)
        return recorded.map((row) => ({ ...row, matches: row.botId === botId }))
      }),
    )
    expect(attached).toEqual([
      { threadId: expect.any(String), botId: expect.any(String), sessionId: session, matches: true },
    ])
  })

  it("leaves a settled turn alone", async () => {
    const attached = await withDispatch((turns, recorded) =>
      Effect.gen(function* () {
        const { threadId } = yield* seedThread({ settled: true, sessionId: session })
        yield* turns.resumeThread(threadId)
        return [...recorded]
      }),
    )
    expect(attached).toEqual([])
  })

  it("has nothing to resume when the bot holds no session", async () => {
    const attached = await withDispatch((turns, recorded) =>
      Effect.gen(function* () {
        const { threadId } = yield* seedThread({ settled: false, sessionId: null })
        yield* turns.resumeThread(threadId)
        return [...recorded]
      }),
    )
    expect(attached).toEqual([])
  })

  it("is idempotent, so re-opening a thread does not re-attach", async () => {
    const attached = await withDispatch((turns, recorded) =>
      Effect.gen(function* () {
        const { threadId } = yield* seedThread({ settled: false, sessionId: session })
        yield* turns.resumeThread(threadId)
        yield* turns.resumeThread(threadId)
        return [...recorded]
      }),
    )
    expect(attached).toHaveLength(1)
  })
})
