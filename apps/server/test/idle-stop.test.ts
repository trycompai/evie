import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EvieEvent } from "@evie/contracts/events"
import type { BotId, OrgId, SessionId, ThreadId, TurnId, UserId } from "@evie/contracts/ids"
import { resolveHome } from "@evie/shared/home"
import { ulid } from "@evie/shared/ulid"
import { Deferred, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { afterAll, describe, expect, it } from "vitest"
import { EvieConfig } from "../src/config.ts"
import { Db } from "../src/db/Db.ts"
import { MigrationsLive } from "../src/db/migrations.ts"
import { Scaffold } from "../src/provider/scaffold.ts"
import { ReactorWake } from "../src/reactors/runtime.ts"
import {
  ClientPresence,
  RuntimeControl,
  SupervisorReactorLive,
} from "../src/reactors/supervisor.ts"
import { EventStore } from "../src/store/EventStore.ts"

/**
 * The idle timer, and the one thing that is allowed to stop it.
 *
 * A bot's runtime is stopped `idleStopMinutes` after its last turn settles.
 * That rule is correct and is not what broke: what broke is that the loop asked
 * `ClientPresence.isAttached` and the answer was hard-wired to `false`, so the
 * timer fired on conversations that were open on screen. The bug and its fix
 * both live in the interaction between the timer and presence, which is why
 * this drives the real reactor rather than the pieces.
 *
 * Both directions matter and they fail in opposite ways. Never stopping is a
 * process-wide leak -- every bot ever opened holding an eve runtime forever.
 * Always stopping is the reported bug. A test that only pinned one of them
 * would be satisfied by a constant.
 *
 * **On determinism.** No sleeps and no polling, per AGENTS.md. Two things buy
 * that. The seeded events carry a future `at`, so the reactor's catch-up --
 * which `runReactor` completes *before* its layer resolves -- gets past the
 * staleness guard and arms the timer before this test has control; there is no
 * window in which the clock could be advanced too early. And every assertion
 * waits on a `Deferred` the fakes open, never on elapsed time: `TestClock`
 * releases the sleep, and the latch is what proves the loop got where it was
 * going.
 *
 * Temp directory, never `~/.evie` -- see rule 2 in AGENTS.md.
 */

const root = mkdtempSync(join(tmpdir(), "evie-idle-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const IDLE_MINUTES = 10

const ConfigTest = Layer.succeed(EvieConfig, {
  home: resolveHome({ EVIE_HOME: root } as NodeJS.ProcessEnv),
  bind: "127.0.0.1",
  port: 0,
  mode: "local",
  idleStopMinutes: IDLE_MINUTES,
  flags: { persistReasoning: false },
})

const StoreLayer = EventStore.layer.pipe(
  Layer.provideMerge(MigrationsLive),
  Layer.provideMerge(Db.layer),
  Layer.provide(ConfigTest),
)

/** The reactor provisions on `BotCreated`; nothing here creates one. */
const ScaffoldStub = Layer.succeed(Scaffold, {
  create: () => Effect.succeed({ dir: root }),
  regenerate: () => Effect.void,
  setModel: () => Effect.void,
} as unknown as typeof Scaffold.Service)

const orgId = "org_1" as OrgId
const userId = "user_1" as UserId

const turnDispatched = (threadId: ThreadId, botId: BotId, turnId: string): EvieEvent =>
  ({
    _tag: "TurnDispatched",
    threadId,
    botId,
    turnId: turnId as TurnId,
    sessionId: "wrun_1" as SessionId,
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

/**
 * A bot that has just finished a turn: warmed, then settled, so the reactor
 * arms the idle timer as it catches up.
 *
 * `at` is pushed into the future on purpose. The reactor ignores activity older
 * than its own start ("stale activity is history, not demand"), and catch-up
 * runs after that timestamp is taken.
 */
const seedSettledTurn = Effect.gen(function* () {
  const botId = ulid() as BotId
  const threadId = ulid() as ThreadId
  const turnId = ulid()
  const db = yield* Db
  const store = yield* EventStore
  const at = Date.now() + 60_000
  yield* db.sql`
    insert into bot (id, org_id, slug, name, dir, model, sandbox, created_by, created_at)
    values (${botId}, ${orgId}, ${botId}, 'Bot', ${join(root, "bots", botId)},
            'anthropic/claude-opus-4.8', '{}', ${userId}, 0)`
  yield* db.sql`
    insert into thread (id, org_id, title, created_by, created_at, last_activity)
    values (${threadId}, ${orgId}, null, ${userId}, 0, 0)`
  yield* db.sql`
    insert into thread_participant (thread_id, bot_id, eve_session_id, stream_index, is_default)
    values (${threadId}, ${botId}, 'wrun_1', 0, 1)`
  yield* store.append(
    [
      { data: turnDispatched(threadId, botId, turnId), orgId, threadId, botId, at },
      { data: turnSettled(threadId, botId, turnId), orgId, threadId, botId, at },
    ],
    { aggregate: { kind: "thread", id: threadId } },
  )
  return { botId, threadId }
})

interface Harness {
  /** Opens the first time the idle loop reaches its presence check. */
  readonly consulted: Deferred.Deferred<void>
  /** Opens when the loop actually stops a runtime. */
  readonly stopped: Deferred.Deferred<void>
  readonly stops: ReadonlyArray<{ botId: BotId; reason: string }>
  readonly layer: Layer.Layer<RuntimeControl | ClientPresence>
}

const harness = (attached: boolean): Effect.Effect<Harness> =>
  Effect.gen(function* () {
    const consulted = yield* Deferred.make<void>()
    const stopped = yield* Deferred.make<void>()
    const stops: Array<{ botId: BotId; reason: string }> = []

    const control = Layer.succeed(RuntimeControl, {
      acquire: () => Effect.succeed({ port: 41000, fresh: true }),
      stop: (botId, reason) =>
        Effect.sync(() => {
          stops.push({ botId, reason })
        }).pipe(Effect.andThen(Deferred.succeed(stopped, undefined))),
    })

    const presence = Layer.succeed(ClientPresence, {
      isAttached: () =>
        Deferred.succeed(consulted, undefined).pipe(Effect.as(attached)),
    })

    return { consulted, stopped, stops, layer: Layer.mergeAll(control, presence) }
  })

/**
 * Builds the reactor (which catches up, and arms the timer, before it
 * resolves), then hands the body a live TestClock.
 */
const withReactor = <A>(
  attached: boolean,
  body: (
    harness: Harness,
    seeded: { readonly botId: BotId; readonly threadId: ThreadId },
  ) => Effect.Effect<A, never, never>,
) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        // Every case seeds its own bot into the shared file, so assertions
        // must be scoped to it rather than to "the log".
        const seeded = yield* seedSettledTurn
        const fake = yield* harness(attached)
        return yield* Effect.provide(
          body(fake, seeded),
          SupervisorReactorLive.pipe(
            Layer.provide([StoreLayer, ReactorWake.layer, ConfigTest, ScaffoldStub, fake.layer]),
          ),
        )
      }),
      Layer.mergeAll(StoreLayer, TestClock.layer()),
    ) as Effect.Effect<A>,
  )

describe("the idle timer", () => {
  it("stops a runtime nobody is watching", async () => {
    const stops = await withReactor(false, (fake) =>
      Effect.gen(function* () {
        yield* TestClock.adjust(`${IDLE_MINUTES} minutes`)
        // The clock released the sleep; this is what proves the loop ran all
        // the way through to stopping the runtime.
        yield* Deferred.await(fake.stopped)
        return [...fake.stops]
      }),
    )
    expect(stops).toEqual([{ botId: expect.any(String), reason: "idle" }])
  })

  it("records the stop in the log, so the bot reads as asleep rather than gone", async () => {
    const events = await withReactor(false, (fake, seeded) =>
      Effect.gen(function* () {
        yield* TestClock.adjust(`${IDLE_MINUTES} minutes`)
        yield* Deferred.await(fake.stopped)
        return yield* Effect.provide(
          Effect.gen(function* () {
            const db = yield* Db
            const rows = yield* db.sql<{ type: string; data: string }>`
              select type, data from event
              where type = 'RuntimeStopped' and bot_id = ${seeded.botId}`
            return rows.map((row) => ({
              type: row.type,
              reason: (JSON.parse(row.data) as { reason: string }).reason,
            }))
          }),
          StoreLayer,
        ).pipe(Effect.orDie)
      }),
    )
    expect(events).toEqual([{ type: "RuntimeStopped", reason: "idle" }])
  })

  it("keeps a watched runtime warm, and keeps checking", async () => {
    const outcome = await withReactor(true, (fake) =>
      Effect.gen(function* () {
        yield* TestClock.adjust(`${IDLE_MINUTES} minutes`)
        // Waiting on the presence check rather than on a stop is what keeps
        // this from passing vacuously: a timer that never armed would also
        // never stop anything.
        yield* Deferred.await(fake.consulted)

        // The window elapses again. `continue` has to mean "ask again next
        // window", not "give up and stop it".
        yield* TestClock.adjust(`${IDLE_MINUTES * 2} minutes`)
        return { stops: [...fake.stops], stillPending: yield* Deferred.isDone(fake.stopped) }
      }),
    )
    expect(outcome).toEqual({ stops: [], stillPending: false })
  })
})
