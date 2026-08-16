import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EvieEvent } from "@evie/contracts/events"
import type { BotId, OrgId, SessionId, ThreadId, UserId } from "@evie/contracts/ids"
import { resolveHome } from "@evie/shared/home"
import { ulid } from "@evie/shared/ulid"
import { Effect, Layer } from "effect"
import { afterAll, describe, expect, it } from "vitest"
import { EvieConfig } from "../src/config.ts"
import { Db } from "../src/db/Db.ts"
import { MigrationsLive } from "../src/db/migrations.ts"
import { ReactorWake } from "../src/reactors/runtime.ts"
import { TurnDispatch, TurnReactorLive } from "../src/reactors/turn.ts"
import { EventStore } from "../src/store/EventStore.ts"

/**
 * A freshly provisioned bot greets first.
 *
 * Before this, creation ended at a working bot and a dead silence: the user
 * watched the install finish and then had to speak first, into a pipeline
 * nothing had proven end to end. The greeting turn is that proof -- dispatch,
 * model call, stream -- and it is skipped exactly when a better proof exists:
 * a message that arrived during the install and is about to be answered
 * (see provisioning-race.test.ts for that path).
 *
 * Temp directory, never `~/.evie` -- see rule 2 in AGENTS.md.
 */

const root = mkdtempSync(join(tmpdir(), "evie-greeting-"))
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
const creator = "user_creator" as UserId

interface Sent {
  readonly botId: BotId
  readonly threadId: ThreadId
  readonly message: string
  readonly actingAs: UserId
}

/** Records what reached the provider. The runtime itself is not what is under test. */
const recorder = () => {
  const sent: Array<Sent> = []
  const layer = Layer.succeed(TurnDispatch, {
    dispatchTurn: (input) =>
      Effect.sync(() => {
        sent.push({
          botId: input.botId,
          threadId: input.threadId,
          message: input.message,
          actingAs: input.actingAs,
        })
        return { sessionId: `wrun_${sent.length}` as SessionId }
      }),
    respondInput: () => Effect.void,
    cancelTurn: () => Effect.void,
    compactSession: () => Effect.void,
    clearSession: () => Effect.void,
    resumeThread: () => Effect.void,
  })
  return { sent, layer }
}

const botCreated = (botId: BotId): EvieEvent =>
  ({
    _tag: "BotCreated",
    botId,
    slug: botId.toLowerCase(),
    name: "Nova",
    teamId: null,
    model: "anthropic/claude-opus-4.8",
    avatar: null,
    reasoning: null,
  }) as EvieEvent

const botProvisioned = (botId: BotId): EvieEvent => ({ _tag: "BotProvisioned", botId }) as EvieEvent

/** A provisioned bot with (optionally) its first thread already open. */
const seed = (options: { readonly withThread: boolean }) =>
  Effect.gen(function* () {
    const db = yield* Db
    const store = yield* EventStore
    const botId = ulid() as BotId
    const threadId = ulid() as ThreadId
    yield* db.sql`
      insert into bot (id, org_id, slug, name, dir, model, sandbox, created_by, created_at)
      values (${botId}, ${orgId}, ${botId}, 'Nova', ${join(root, "bots", botId)},
              'anthropic/claude-opus-4.8', '{}', ${creator}, 0)`
    if (options.withThread) {
      yield* db.sql`
        insert into thread (id, org_id, title, created_by, created_at, last_activity)
        values (${threadId}, ${orgId}, null, ${creator}, 0, 0)`
      yield* db.sql`
        insert into thread_participant (thread_id, bot_id, eve_session_id, stream_index, is_default)
        values (${threadId}, ${botId}, null, 0, 1)`
    }
    yield* store.append([{ data: botCreated(botId), orgId, botId, actorUserId: creator }], {
      aggregate: { kind: "bot", id: botId },
    })
    yield* store.append([{ data: botProvisioned(botId), orgId, botId }], {
      aggregate: { kind: "bot", id: botId },
    })
    return { botId, threadId }
  })

/** Building the reactor replays from the cursor; catch-up completes before the layer resolves. */
const boot = (fake: ReturnType<typeof recorder>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        Effect.void,
        TurnReactorLive.pipe(Layer.provide([StoreLayer, fake.layer, ReactorWake.layer])),
      ),
    ) as Effect.Effect<void>,
  )

describe("a bot with nothing waiting for it", () => {
  it("introduces itself in its first thread, as its creator", async () => {
    const fake = recorder()
    const { botId, threadId } = await Effect.runPromise(
      Effect.provide(seed({ withThread: true }), StoreLayer),
    )
    await boot(fake)

    const greeting = fake.sent.filter((turn) => turn.botId === botId)
    expect(greeting).toHaveLength(1)
    expect(greeting[0]!.threadId).toBe(threadId)
    expect(greeting[0]!.actingAs).toBe(creator)
    expect(greeting[0]!.message).toContain("just created")
  })

  it("does not greet twice when provisioning is replayed", async () => {
    const fake = recorder()
    const { botId } = await Effect.runPromise(
      Effect.provide(seed({ withThread: true }), StoreLayer),
    )
    await boot(fake)

    // A crash between the dispatch and the cursor advance replays the event.
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const store = yield* EventStore
          yield* store.cursor.advance("turn", 0)
        }),
        StoreLayer,
      ),
    )
    const again = recorder()
    await boot(again)

    expect(fake.sent.filter((turn) => turn.botId === botId)).toHaveLength(1)
    expect(again.sent.filter((turn) => turn.botId === botId)).toEqual([])
  })

  it("stays quiet when no thread was ever opened", async () => {
    const fake = recorder()
    const { botId } = await Effect.runPromise(
      Effect.provide(seed({ withThread: false }), StoreLayer),
    )
    await boot(fake)

    // A bot created headless has no room to greet in; the first message still
    // works the way it always has.
    expect(fake.sent.filter((turn) => turn.botId === botId)).toEqual([])
  })
})
