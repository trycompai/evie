import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { afterAll, describe, expect, it } from "vitest"
import type { EvieEvent } from "@evie/contracts/events"
import type { BotId, OrgId } from "@evie/contracts/ids"
import { resolveHome } from "@evie/shared/home"
import { ulid } from "@evie/shared/ulid"
import { EvieConfig } from "../src/config.ts"
import { Db } from "../src/db/Db.ts"
import { MigrationsLive } from "../src/db/migrations.ts"
import { EventStore } from "../src/store/EventStore.ts"

/**
 * The append guard, against a real SQLite file.
 *
 * `specs/06` asks for this by name: "Two commands against one aggregate,
 * issued together; assert one wins, the other refolds and retries, and the
 * event log has no lost write. Then the same against two *different*
 * aggregates, asserting they do not serialize against each other."
 *
 * The decider is tested pure in `decide.test.ts`. What cannot be tested pure is
 * the part that matters here: whether two deciders that both saw version N can
 * both write. A chance unique index catches `CreateBot` and nothing else, which
 * is why `expectedVersion` exists and why it is asserted rather than assumed.
 *
 * Temp directory, never `~/.evie` — see rule 2 in AGENTS.md.
 */

const root = mkdtempSync(join(tmpdir(), "evie-eventstore-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const home = resolveHome({ EVIE_HOME: root } as NodeJS.ProcessEnv)

const ConfigTest = Layer.succeed(EvieConfig, {
  home,
  bind: "127.0.0.1",
  port: 0,
  mode: "local",
  idleStopMinutes: 10,
  flags: { persistReasoning: false },
})

const TestLayer = EventStore.layer.pipe(
  Layer.provideMerge(MigrationsLive),
  Layer.provideMerge(Db.layer),
  Layer.provide(ConfigTest),
)

const run = <A, E>(effect: Effect.Effect<A, E, EventStore | Db>): Promise<A> =>
  Effect.runPromise(Effect.scoped(Effect.provide(effect, TestLayer)) as Effect.Effect<A, E>)

const orgId = "org_1" as OrgId

const botCreated = (botId: BotId, name: string): EvieEvent =>
  ({
    _tag: "BotCreated",
    botId,
    slug: name.toLowerCase(),
    name,
    teamId: null,
    model: "anthropic/claude-opus-4.8",
  }) as EvieEvent

describe("EventStore.append", () => {
  it("lets exactly one of two writers at the same version through", async () => {
    const botId = ulid() as BotId
    const aggregate = { kind: "bot" as const, id: botId }

    const result = await run(
      Effect.gen(function* () {
        const store = yield* EventStore

        // Seed so the aggregate is at version 1 and both writers fold to it.
        yield* store.append([{ data: botCreated(botId, "Ops"), orgId }], { aggregate })

        const write = (name: string) =>
          store
            .append([{ data: botCreated(botId, name), orgId }], { aggregate, expectedVersion: 1 })
            .pipe(Effect.result)

        // Both issued together, both having folded at version 1.
        const [a, b] = yield* Effect.all([write("A"), write("B")], { concurrency: 2 })
        const after = yield* store.readAggregate(aggregate)
        return { a, b, after }
      }),
    )

    const wins = [result.a, result.b].filter((r) => r._tag === "Success").length
    const conflicts = [result.a, result.b].filter((r) => r._tag === "Failure").length

    expect(wins, "exactly one writer should win").toBe(1)
    expect(conflicts, "the loser should get a typed conflict, not a silent write").toBe(1)

    const loser = [result.a, result.b].find((r) => r._tag === "Failure")
    expect(loser?._tag === "Failure" && loser.failure._tag).toBe("ConcurrencyConflict")

    // The seed plus exactly one winner. Two rows would be the lost-update bug
    // this guard exists to prevent; one row would mean the winner was dropped.
    expect(result.after.version).toBe(2)
  })

  it("does not serialize two different aggregates against each other", async () => {
    const first = ulid() as BotId
    const second = ulid() as BotId

    const result = await run(
      Effect.gen(function* () {
        const store = yield* EventStore
        // Both at version 0, both writing at the same moment. If the guard had
        // become a global lock, one of these would fail -- which is the failure
        // mode a per-aggregate semaphore is supposed to avoid and the easiest
        // one to introduce by accident.
        const [a, b] = yield* Effect.all(
          [
            store
              .append([{ data: botCreated(first, "First"), orgId }], {
                aggregate: { kind: "bot", id: first },
                expectedVersion: 0,
              })
              .pipe(Effect.result),
            store
              .append([{ data: botCreated(second, "Second"), orgId }], {
                aggregate: { kind: "bot", id: second },
                expectedVersion: 0,
              })
              .pipe(Effect.result),
          ],
          { concurrency: 2 },
        )
        return { a, b }
      }),
    )

    expect(result.a._tag).toBe("Success")
    expect(result.b._tag).toBe("Success")
  })

  it("is idempotent on (sessionId, id) so a replayed mirror row inserts once", async () => {
    const botId = ulid() as BotId
    const eventId = ulid()

    const count = await run(
      Effect.gen(function* () {
        const store = yield* EventStore
        const mirror = {
          data: botCreated(botId, "Mirror"),
          orgId,
          id: eventId,
          sessionId: "sess_1",
        }
        const aggregate = { kind: "bot" as const, id: botId }
        // Reconnect re-reads from the last PERSISTED stream index, so overlap
        // is normal by design. It has to be harmless, not merely unlikely.
        yield* store.append([mirror], { aggregate })
        yield* store.append([mirror], { aggregate })
        // `readAggregate` is product events only, and a mirror row is not one
        // -- so this counts through the reactor read path instead.
        const forward = yield* store.readForward(0, 1000)
        return forward.filter((e) => e.sessionId === "sess_1" && e.id === eventId).length
      }),
    )

    expect(count).toBe(1)
  })

  it("reads strictly forward and tolerates gaps in seq", async () => {
    const botId = ulid() as BotId
    const aggregate = { kind: "bot" as const, id: botId }

    const seqs = await run(
      Effect.gen(function* () {
        const store = yield* EventStore
        // A conflict consumes seq values and rolls back, so `seq` is monotonic
        // but NOT contiguous. A reactor that waited for the next contiguous
        // value would wedge here forever.
        yield* store.append([{ data: botCreated(botId, "Gap"), orgId }], { aggregate })
        yield* store
          .append([{ data: botCreated(botId, "Doomed"), orgId }], {
            aggregate,
            expectedVersion: 999,
          })
          .pipe(Effect.result)
        yield* store.append([{ data: botCreated(botId, "After"), orgId }], { aggregate })

        const forward = yield* store.readForward(0, 100)
        return forward.map((event) => event.seq)
      }),
    )

    expect(seqs.length).toBeGreaterThanOrEqual(2)
    // Strictly increasing is the contract; contiguous is not.
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!)
  })
})
