import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EvieEvent } from "@evie/contracts/events"
import type { BotId, OrgId, SessionId, ThreadId } from "@evie/contracts/ids"
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
 * A message sent before the bot finished installing still reaches it.
 *
 * Creating a bot and immediately greeting it is the first thing anyone does,
 * and `npm install` in the new bot's directory takes around fifteen seconds.
 * There is no runtime to dispatch into for that whole window, so the dispatch
 * fails with "eve is not installed in the bot directory", the reactor spends
 * its five quick retries, and then skips the event to avoid wedging every
 * other thread behind one unstartable bot.
 *
 * That last part is right, and the consequence was not: the user's first
 * message was gone. Real timings from the report --
 *
 *   15:38:02  BotCreated "Hi"
 *   15:38:04  MessageSent "Hello!"
 *   15:38:13  reactor gives up
 *   15:38:19  BotProvisioned        <- six seconds too late
 *
 * -- leaving a bot that worked perfectly and had never heard the only thing
 * said to it.
 *
 * Temp directory, never `~/.evie` -- see rule 2 in AGENTS.md.
 */

const root = mkdtempSync(join(tmpdir(), "evie-provisioning-"))
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
const botId = ulid() as BotId
const threadId = ulid() as ThreadId
const userId = "user_1"

interface Sent {
  readonly botId: BotId
  readonly threadId: ThreadId
  readonly message: string
}

/** Records what reached the provider. The runtime itself is not what is under test. */
const recorder = () => {
  const sent: Array<Sent> = []
  const layer = Layer.succeed(TurnDispatch, {
    dispatchTurn: (input) =>
      Effect.sync(() => {
        sent.push({ botId: input.botId, threadId: input.threadId, message: input.message })
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

const messageSent = (text: string): EvieEvent =>
  ({
    _tag: "MessageSent",
    threadId,
    text,
    mentions: [],
    attachments: [],
    idempotencyKey: text,
  }) as EvieEvent

const botProvisioned = (): EvieEvent => ({ _tag: "BotProvisioned", botId }) as EvieEvent

/**
 * The state the drop leaves behind: the message is in the log, the cursor is
 * past it, and no turn was ever dispatched for it.
 */
const seedDroppedMessage = Effect.gen(function* () {
  const db = yield* Db
  const store = yield* EventStore
  yield* db.sql`
    insert into bot (id, org_id, slug, name, dir, model, sandbox, created_by, created_at)
    values (${botId}, ${orgId}, 'hi', 'Hi', ${join(root, "bots", botId)},
            'anthropic/claude-opus-4.8', '{}', ${userId}, 0)`
  yield* db.sql`
    insert into thread (id, org_id, title, created_by, created_at, last_activity)
    values (${threadId}, ${orgId}, null, ${userId}, 0, 0)`
  yield* db.sql`
    insert into thread_participant (thread_id, bot_id, eve_session_id, stream_index, is_default)
    values (${threadId}, ${botId}, null, 0, 1)`
  const [message] = yield* store.append(
    [{ data: messageSent("Hello!"), orgId, threadId, actorUserId: userId }],
    { aggregate: { kind: "thread", id: threadId } },
  )
  // The reactor tried, failed, and skipped: the cursor moved on without a turn.
  yield* store.cursor.advance("turn", message!.seq)
  yield* store.append([{ data: botProvisioned(), orgId, botId }], {
    aggregate: { kind: "bot", id: botId },
  })
})

describe("a message that arrived while the bot was still installing", () => {
  it("is dispatched once the bot is provisioned", async () => {
    const fake = recorder()
    await Effect.runPromise(Effect.provide(seedDroppedMessage, StoreLayer))

    // Building the reactor replays from the cursor, which now starts at
    // `BotProvisioned`. Catch-up completes before the layer resolves.
    await Effect.runPromise(
      Effect.scoped(
        Effect.provide(Effect.void, TurnReactorLive.pipe(Layer.provide([StoreLayer, fake.layer, ReactorWake.layer]))),
      ) as Effect.Effect<void>,
    )

    expect(fake.sent).toEqual([{ botId, threadId, message: "Hello!" }])
  })

  it("does not dispatch it twice when provisioning is replayed", async () => {
    const fake = recorder()
    const build = () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.provide(Effect.void, TurnReactorLive.pipe(Layer.provide([StoreLayer, fake.layer, ReactorWake.layer]))),
        ) as Effect.Effect<void>,
      )

    // The first build dispatched and recorded a `TurnDispatched`; rewinding the
    // cursor is what a crash between the two would look like.
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const store = yield* EventStore
          const db = yield* Db
          const rows = yield* db.sql<{ seq: number }>`
            select seq from event where type = 'MessageSent' order by seq asc limit 1`
          yield* store.cursor.advance("turn", Number(rows[0]!.seq))
        }),
        StoreLayer,
      ),
    )
    await build()

    // Turn ids derive from the triggering event, so the second pass sees the
    // turn it already dispatched rather than sending the message again.
    expect(fake.sent).toEqual([])
  })
})
