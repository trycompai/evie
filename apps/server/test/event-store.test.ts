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
    avatar: null,
    reasoning: null,
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

  /*
   * The org aggregate is the organization's *decisions*, not its traffic.
   *
   * It used to be every product event carrying the org id -- so a turn
   * settling in one thread moved the version a `CreateBot` had folded at, the
   * append conflicted, and after the single retry the command failed. With a
   * bot streaming, which is the normal state of a working Evie, creating
   * another bot was effectively impossible.
   */
  it("does not move the org's version when a thread has activity", async () => {
    const threadId = ulid()
    const result = await run(
      Effect.gen(function* () {
        const store = yield* EventStore
        const org = { kind: "org" as const, id: orgId }
        const before = yield* store.readAggregate(org)

        // A turn's worth of traffic in some thread of the same org.
        yield* store.append(
          [
            {
              data: {
                _tag: "TurnSettled",
                threadId,
                botId: ulid(),
                turnId: ulid(),
                outcome: "completed",
              } as unknown as EvieEvent,
              orgId,
              threadId,
            },
          ],
          { aggregate: { kind: "thread", id: threadId } },
        )

        const after = yield* store.readAggregate(org)
        // And a bot creation still lands at the version it folded at.
        const created = yield* store
          .append([{ data: botCreated(ulid() as BotId, "Fresh"), orgId }], {
            aggregate: org,
            expectedVersion: after.version,
          })
          .pipe(Effect.result)
        return { before: before.version, after: after.version, created }
      }),
    )

    expect(result.after).toBe(result.before)
    expect(result.created._tag).toBe("Success")
  })

  /*
   * A stored event outlives the code that wrote it. When a required field was
   * added to `CheckpointWritten`, every older row stopped decoding -- and
   * because the decode threw, every command that folded an aggregate holding
   * one died. The organization could not create a bot and the affected threads
   * could not be sent to, with nothing in the UI to say why.
   */
  it("skips a row it cannot decode instead of failing the whole read", async () => {
    const botId = ulid() as BotId
    const aggregate = { kind: "bot" as const, id: botId }

    const result = await run(
      Effect.gen(function* () {
        const store = yield* EventStore
        const db = yield* Db
        yield* store.append([{ data: botCreated(botId, "Survivor"), orgId }], { aggregate })
        // A row written by some future build: right tag, unreadable body.
        yield* db.sql`
          insert into event (id, session_id, seq, org_id, thread_id, bot_id, actor_user_id,
                             stream_index, type, data, at)
          values (${ulid()}, '', 99999, ${orgId}, null, ${botId}, null, null, 'BotRenamed',
                  '{"_tag":"BotRenamed","botId":"nope"}', 0)`
        return yield* store.readAggregate(aggregate)
      }),
    )

    // The readable event survives...
    expect(result.events.map((event) => event.data._tag)).toEqual(["BotCreated"])
    // ...and the unreadable one still holds its place, so a stale decision
    // cannot append over a fresh one it never saw.
    expect(result.version).toBe(2)
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
