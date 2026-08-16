import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RuntimeUnavailable } from "@evie/contracts/errors"
import type { EvieEvent } from "@evie/contracts/events"
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
 * `BotProvisioned` means the runtime answered, not merely "files on disk".
 *
 * The chip's `starting` is the creation screen's gate. When provisioning
 * settled at the install, the gate dropped and the user's first message still
 * paid a 30-plus second cold boot -- a composer that said ready and was not.
 * So provisioning now boots the runtime and waits for its health route; the
 * receipt is written only once the bot can actually take a message.
 *
 * The receipt also guards the replay: `BotCreated` is deliberately handled on
 * every replay (a bot created moments before a crash still needs its project),
 * and without the guard every server boot would start every bot's runtime.
 *
 * Temp directory, never `~/.evie` -- see rule 2 in AGENTS.md.
 */

const root = mkdtempSync(join(tmpdir(), "evie-provision-runtime-"))
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

const orgId = "org_1" as OrgId
const creator = "user_1" as UserId

/** Counts acquires; succeeds or refuses depending on the scenario. */
const runtimeStub = (behavior: "up" | "down") => {
  const acquired: Array<BotId> = []
  const layer = Layer.succeed(RuntimeControl, {
    acquire: (botId: BotId) =>
      Effect.suspend(() => {
        acquired.push(botId)
        return behavior === "up"
          ? Effect.succeed({ port: 41000, fresh: true })
          : Effect.fail(
              new RuntimeUnavailable({
                botId,
                reason: "eve never became healthy",
                stderr: ["boom"],
              }),
            )
      }),
    stop: () => Effect.void,
  })
  return { acquired, layer }
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

const seedCreated = Effect.gen(function* () {
  const db = yield* Db
  const store = yield* EventStore
  const botId = ulid() as BotId
  // Health `idle` on the row so the boot-time cleanup stays out of the way.
  yield* db.sql`
    insert into bot (id, org_id, slug, name, dir, model, sandbox, health, created_by, created_at)
    values (${botId}, ${orgId}, ${botId}, 'Nova', ${join(root, "bots", botId)},
            'anthropic/claude-opus-4.8', '{}', ${JSON.stringify({ kind: "idle" })}, ${creator}, 0)`
  yield* store.append([{ data: botCreated(botId), orgId, botId, actorUserId: creator }], {
    aggregate: { kind: "bot", id: botId },
  })
  return botId
})

const boot = (runtime: ReturnType<typeof runtimeStub>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        Effect.void,
        SupervisorReactorLive.pipe(
          Layer.provide([
            StoreLayer,
            ReactorWake.layer,
            ConfigTest,
            ScaffoldStub,
            runtime.layer,
            ClientPresence.layerNone,
          ]),
        ),
      ),
    ) as Effect.Effect<void>,
  )

const eventsFor = (botId: BotId, type: string) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const db = yield* Db
        const rows = yield* db.sql<{ data: string }>`
          select data from event where type = ${type} and bot_id = ${botId}`
        return rows.map((row) => JSON.parse(row.data) as Record<string, unknown>)
      }),
      StoreLayer,
    ) as Effect.Effect<Array<Record<string, unknown>>>,
  )

const rewindCursor = Effect.runPromise(
  Effect.provide(
    Effect.gen(function* () {
      const store = yield* EventStore
      yield* store.cursor.advance("supervisor", 0)
    }),
    StoreLayer,
  ) as Effect.Effect<void>,
)

describe("provisioning proves the runtime", () => {
  it("boots it and writes BotProvisioned with RuntimeReady", async () => {
    const runtime = runtimeStub("up")
    const botId = await Effect.runPromise(
      Effect.provide(seedCreated, StoreLayer) as Effect.Effect<BotId>,
    )
    await boot(runtime)

    expect(runtime.acquired).toContain(botId)
    expect(await eventsFor(botId, "BotProvisioned")).toHaveLength(1)
    expect(await eventsFor(botId, "RuntimeReady")).toHaveLength(1)
  })

  it("does not boot it again when BotCreated replays", async () => {
    const runtime = runtimeStub("up")
    const botId = await Effect.runPromise(
      Effect.provide(seedCreated, StoreLayer) as Effect.Effect<BotId>,
    )
    await boot(runtime)
    expect(runtime.acquired).toContain(botId)

    // Every server boot replays BotCreated (provisioning is checked before the
    // staleness guard); the receipt is what keeps that from starting runtimes.
    await rewindCursor
    const again = runtimeStub("up")
    await boot(again)

    expect(again.acquired).not.toContain(botId)
    expect(await eventsFor(botId, "BotProvisioned")).toHaveLength(1)
  })

  it("reports a runtime that will not start as a failed provision", async () => {
    const runtime = runtimeStub("down")
    const botId = await Effect.runPromise(
      Effect.provide(seedCreated, StoreLayer) as Effect.Effect<BotId>,
    )
    await boot(runtime)

    // Before this, the bot looked provisioned and healthy right up until the
    // first message found out otherwise.
    expect(await eventsFor(botId, "BotProvisioned")).toEqual([])
    const failures = await eventsFor(botId, "BotProvisionFailed")
    expect(failures).toHaveLength(1)
    expect(failures[0]!["reason"]).toBe("runtime")
  })
})
