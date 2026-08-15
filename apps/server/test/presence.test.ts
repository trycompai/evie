import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BotId, OrgId, ThreadId } from "@evie/contracts/ids"
import { resolveHome } from "@evie/shared/home"
import { ulid } from "@evie/shared/ulid"
import { Effect, Layer, Stream } from "effect"
import { afterAll, describe, expect, it } from "vitest"
import { EvieConfig } from "../src/config.ts"
import { Db } from "../src/db/Db.ts"
import { MigrationsLive } from "../src/db/migrations.ts"
import { Hub } from "../src/gateway/hub.ts"
import { ClientPresence } from "../src/reactors/supervisor.ts"

/**
 * A bot someone is watching is not idle.
 *
 * `ClientPresence` was wired to `layerNone` -- `isAttached` answered false
 * unconditionally -- so the supervisor's idle loop stopped a bot's runtime
 * `idleStopMinutes` after its last turn settled *even with the thread open on
 * screen*. The user's experience is the agent going quiet on its own after ten
 * minutes: the next message pays a cold start at best, and before
 * `Supervisor.acquire` stopped caching failed starts, was dropped entirely.
 *
 * These pin the two halves that have to hold together. Presence must be true
 * while a client is streaming the thread -- otherwise the timer fires under an
 * active conversation -- and it must go false again on its own when that
 * client goes away, or the opposite bug appears: every bot ever opened stays
 * warm for the life of the process.
 *
 * The second half is why this reads the hub's live subscriber set instead of a
 * presence table written by `presence.set`. A tab that closes, a socket that
 * drops and a client that is killed all withdraw by unwinding the stream's
 * scope; none of them gets to send a parting message.
 *
 * Temp directory, never `~/.evie` -- see rule 2 in AGENTS.md.
 */

const root = mkdtempSync(join(tmpdir(), "evie-presence-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const ConfigTest = Layer.succeed(EvieConfig, {
  home: resolveHome({ EVIE_HOME: root } as NodeJS.ProcessEnv),
  bind: "127.0.0.1",
  port: 0,
  mode: "local",
  idleStopMinutes: 10,
  flags: { persistReasoning: false },
})

const DbTest = Db.layer.pipe(Layer.provideMerge(ConfigTest))
const SchemaTest = MigrationsLive.pipe(Layer.provideMerge(DbTest))
const HubTest = Hub.layer.pipe(Layer.provideMerge(SchemaTest))
const PresenceTest = ClientPresence.layerHub.pipe(Layer.provideMerge(HubTest))

const orgId = "org_1" as OrgId
const watched = { botId: ulid() as BotId, threadId: ulid() as ThreadId }
const lonely = { botId: ulid() as BotId, threadId: ulid() as ThreadId }
const userId = "user_1"

const seed = Effect.gen(function* () {
  const db = yield* Db
  for (const [index, pair] of [watched, lonely].entries()) {
    yield* db.sql`
      insert into bot (id, org_id, slug, name, dir, model, sandbox, created_by, created_at)
      values (${pair.botId}, ${orgId}, ${`bot-${index}`}, ${`Bot ${index}`},
              ${join(root, "bots", pair.botId)}, 'anthropic/claude-opus-4.8', '{}', ${userId}, 0)`
    yield* db.sql`
      insert into thread (id, org_id, title, created_by, created_at, last_activity)
      values (${pair.threadId}, ${orgId}, null, ${userId}, 0, 0)`
    yield* db.sql`
      insert into thread_participant (thread_id, bot_id, eve_session_id, stream_index, is_default)
      values (${pair.threadId}, ${pair.botId}, null, 0, 1)`
    /*
     * One timeline row so a `since: 0` subscription has a backfill frame to
     * hand back. That is what makes `whileSubscribed` deterministic: the hub
     * registers the subscriber *before* it reads the backfill, so a pull that
     * returns proves registration already happened -- no sleep, no polling for
     * a race to settle.
     */
    yield* db.sql`
      insert into timeline_item (id, thread_id, seq, kind, body, at)
      values (${`item-${index}`}, ${pair.threadId}, 1, 'system',
              ${JSON.stringify({
                kind: "system",
                id: `item-${index}`,
                threadId: pair.threadId,
                seq: 1,
                at: 0,
                event: "checkpoint",
              })}, 0)`
  }
})

/**
 * Holds a real thread subscription open for the body, exactly as a connected
 * client does. `toPull` acquires the stream inside this scope, so the
 * subscriber is registered before the body runs and withdrawn when it ends --
 * no sleep, no polling for a race to settle.
 */
const whileSubscribed = <A, E, R>(threadId: ThreadId, body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const hub = yield* Hub
    const pull = yield* Stream.toPull(
      hub.subscribeThread(threadId, { since: 0, watching: () => false }),
    )
    // Registration happens before the backfill read, so a frame in hand means
    // this thread is in the hub's watched set.
    yield* pull
    return yield* body
  }).pipe(Effect.scoped)

describe("a bot is attached when a client is watching one of its threads", () => {
  it("is not attached when nobody is subscribed", async () => {
    const attached = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* seed
          const presence = yield* ClientPresence
          return yield* presence.isAttached(watched.botId)
        }),
        PresenceTest,
      ),
    )
    expect(attached).toBe(false)
  })

  it("is attached while a client streams its thread, and only that bot", async () => {
    const [subject, bystander] = await Effect.runPromise(
      Effect.provide(
        whileSubscribed(
          watched.threadId,
          Effect.gen(function* () {
            const presence = yield* ClientPresence
            return [
              yield* presence.isAttached(watched.botId),
              // A different bot in a thread nobody opened stays idle-eligible:
              // presence must not warm the whole fleet on one open tab.
              yield* presence.isAttached(lonely.botId),
            ] as const
          }),
        ),
        PresenceTest,
      ),
    )
    expect(subject).toBe(true)
    expect(bystander).toBe(false)
  })

  it("stops being attached once the client goes away", async () => {
    const after = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const presence = yield* ClientPresence
          const during = yield* whileSubscribed(
            watched.threadId,
            presence.isAttached(watched.botId),
          )
          // The subscription's scope has closed -- the only thing that happened.
          // If presence survived it, a runtime would never be reclaimed again.
          return { during, after: yield* presence.isAttached(watched.botId) }
        }),
        PresenceTest,
      ),
    )
    expect(after).toEqual({ during: true, after: false })
  })
})
