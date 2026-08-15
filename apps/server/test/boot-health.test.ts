import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BotId, OrgId, UserId } from "@evie/contracts/ids"
import { resolveHome } from "@evie/shared/home"
import { ulid } from "@evie/shared/ulid"
import { Effect, Layer } from "effect"
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
 * After a restart, nothing is running -- and the app has to say so.
 *
 * Runtime health is projected from `RuntimeReady` / `RuntimeStopped`, and
 * runtimes do not outlive the process. A server stopped while a bot was warm
 * therefore left `ready` standing as the last word about it, so on the next
 * boot every bot that had ever been used claimed to be up with no runtime
 * behind any of them. Found by restarting a real server: three bots, all
 * `ready`, none running.
 *
 * It is the exact failure the status dot was added to prevent, which is what
 * makes it worth a test rather than a patch -- a green dot on a bot that is not
 * there is worse than no dot, because it is the one people would learn to
 * distrust.
 *
 * Temp directory, never `~/.evie` -- see rule 2 in AGENTS.md.
 */

const root = mkdtempSync(join(tmpdir(), "evie-boot-health-"))
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

const ScaffoldStub = Layer.succeed(Scaffold, {
  create: () => Effect.succeed({ dir: root }),
  regenerate: () => Effect.void,
  setModel: () => Effect.void,
} as unknown as typeof Scaffold.Service)

const Fakes = Layer.mergeAll(
  Layer.succeed(RuntimeControl, {
    acquire: () => Effect.succeed({ port: 41000, fresh: false }),
    stop: () => Effect.void,
  }),
  ClientPresence.layerNone,
)

const orgId = "org_1" as OrgId
const userId = "user_1" as UserId

const seedBot = (health: string) =>
  Effect.gen(function* () {
    const botId = ulid() as BotId
    const db = yield* Db
    yield* db.sql`
      insert into bot (id, org_id, slug, name, dir, model, sandbox, health, created_by, created_at)
      values (${botId}, ${orgId}, ${botId}, 'Bot', ${join(root, "bots", botId)},
              'anthropic/claude-opus-4.8', '{}', ${health}, ${userId}, 0)`
    return botId
  })

/** Boots the supervisor reactor once, as a restart would. */
const boot = Effect.provide(
  Effect.void,
  SupervisorReactorLive.pipe(
    Layer.provide([StoreLayer, ReactorWake.layer, ConfigTest, ScaffoldStub, Fakes]),
  ),
) as Effect.Effect<void, never, never>

const stoppedFor = (botId: BotId) =>
  Effect.gen(function* () {
    const db = yield* Db
    const rows = yield* db.sql<{ data: string }>`
      select data from event where type = 'RuntimeStopped' and bot_id = ${botId}`
    return rows.map((row) => (JSON.parse(row.data) as { reason: string }).reason)
  })

const withBoot = <A>(body: Effect.Effect<A, never, Db | EventStore>) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const result = yield* body
        return result
      }),
      StoreLayer,
    ) as Effect.Effect<A>,
  )

describe("runtime health left behind by a previous process", () => {
  it("is cleared for a bot the log still calls ready", async () => {
    const reasons = await withBoot(
      Effect.gen(function* () {
        const botId = yield* seedBot(JSON.stringify({ kind: "ready" }))
        yield* Effect.scoped(boot)
        return yield* stoppedFor(botId)
      }).pipe(Effect.orDie),
    )
    // `shutdown`, not `idle`: the runtime stopped because the process did.
    expect(reasons).toEqual(["shutdown"])
  })

  it("is cleared for every state that implies a live runtime", async () => {
    const outcome = await withBoot(
      Effect.gen(function* () {
        const ids = {
          busy: yield* seedBot(JSON.stringify({ kind: "busy", activeTurns: 1 })),
          starting: yield* seedBot(JSON.stringify({ kind: "starting" })),
          restarting: yield* seedBot(JSON.stringify({ kind: "restarting", attempt: 2 })),
        }
        yield* Effect.scoped(boot)
        return {
          busy: yield* stoppedFor(ids.busy),
          starting: yield* stoppedFor(ids.starting),
          restarting: yield* stoppedFor(ids.restarting),
        }
      }).pipe(Effect.orDie),
    )
    expect(outcome).toEqual({
      busy: ["shutdown"],
      starting: ["shutdown"],
      restarting: ["shutdown"],
    })
  })

  it("leaves a bot that was already idle alone", async () => {
    const reasons = await withBoot(
      Effect.gen(function* () {
        const botId = yield* seedBot(JSON.stringify({ kind: "idle" }))
        yield* Effect.scoped(boot)
        return yield* stoppedFor(botId)
      }).pipe(Effect.orDie),
    )
    // Writing one anyway would put a `RuntimeStopped` in the log on every boot
    // for every bot that has ever existed.
    expect(reasons).toEqual([])
  })

  it("leaves an unhealthy bot unhealthy", async () => {
    const reasons = await withBoot(
      Effect.gen(function* () {
        const botId = yield* seedBot(
          JSON.stringify({ kind: "unhealthy", reason: "npm install failed", stderr: [] }),
        )
        yield* Effect.scoped(boot)
        return yield* stoppedFor(botId)
      }).pipe(Effect.orDie),
    )
    // A project that never installed is still broken after a restart, and the
    // reason it carries is still the reason. Downgrading it to `idle` would
    // hide a real fault behind "asleep".
    expect(reasons).toEqual([])
  })

  it("tolerates the migration's bare default instead of JSON", async () => {
    const reasons = await withBoot(
      Effect.gen(function* () {
        const botId = yield* seedBot("idle")
        yield* Effect.scoped(boot)
        return yield* stoppedFor(botId)
      }).pipe(Effect.orDie),
    )
    expect(reasons).toEqual([])
  })
})
