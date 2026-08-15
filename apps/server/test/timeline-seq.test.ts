import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { afterAll, describe, expect, it } from "vitest"
import { resolveHome } from "@evie/shared/home"
import { EvieConfig } from "../src/config.ts"
import { Db } from "../src/db/Db.ts"
import { MigrationsLive } from "../src/db/migrations.ts"

/**
 * `timeline_item.seq` is allocated by the database, not by either projection.
 *
 * Two projections write this table: the projector reactor, folding the whole
 * event log, and `EveAdapter`, folding a live eve stream inline so streaming
 * text does not wait for a reactor tick. Each used to allocate positions from
 * its own in-memory counter, seeded from the same rows -- which agrees only
 * until one of them projects an event the other never sees. The reactor
 * projects `MessageSent` and checkpoint rows; the adapter projects assistant
 * and tool rows. After the first such event the counters are one apart, and the
 * next two inserts collide on `(thread_id, seq)`.
 *
 * The failure mode is what makes it worth a test: the unique index rejects the
 * insert, the projector's loop *stops*, and every later event is simply never
 * projected -- the UI silently stops updating while the server looks healthy.
 *
 * It also stayed hidden for as long as the adapter's writes were failing for an
 * unrelated reason. Fixing that one surfaced this one.
 *
 * Temp directory, never `~/.evie` -- see rule 2 in AGENTS.md.
 */

const root = mkdtempSync(join(tmpdir(), "evie-timeline-seq-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const ConfigTest = Layer.succeed(EvieConfig, {
  home: resolveHome({ EVIE_HOME: root } as NodeJS.ProcessEnv),
  bind: "127.0.0.1",
  port: 0,
  mode: "local",
  idleStopMinutes: 10,
  flags: { persistReasoning: false },
})

const TestLayer = MigrationsLive.pipe(Layer.provideMerge(Db.layer), Layer.provide(ConfigTest))

const run = <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestLayer)) as Effect.Effect<A>)

const THREAD = "01M01C46ZKX9GT28EFXEEK73ME"

/** `timeline_item.thread_id` references `thread(id)`, so the parent must exist. */
const thread = (sql: SqlClient.SqlClient, id: string) => sql`
  insert into thread (id, org_id, title, created_by, created_at, last_activity)
  values (${id}, 'org_1', null, 'user_1', 0, 0)
  on conflict (id) do nothing`

/** The insert both writers now share, reduced to the part under test. */
const put = (sql: SqlClient.SqlClient, id: string, thread: string, body: string) => sql`
  insert into timeline_item (id, thread_id, seq, kind, bot_id, actor_user_id, turn_id, body, at)
  values (${id}, ${thread},
          coalesce(
            (select seq from timeline_item where id = ${id}),
            (select coalesce(max(seq), 0) + 1 from timeline_item where thread_id = ${thread})
          ),
          'assistant', null, null, null, ${body}, 0)
  on conflict (id) do update set body = excluded.body`

describe("timeline_item.seq", () => {
  it("hands consecutive positions to different rows", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* thread(sql, THREAD)
        yield* put(sql, "a", THREAD, "one")
        yield* put(sql, "b", THREAD, "two")
        yield* put(sql, "c", THREAD, "three")
        return yield* sql<{ id: string; seq: number }>`
          select id, seq from timeline_item where thread_id = ${THREAD} order by seq`
      }),
    )
    expect(rows.map((r) => [r.id, r.seq])).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ])
  })

  /*
   * The reason a caller cannot own this number: rewriting a row must not move
   * it. A streaming assistant message is written once per flush window.
   */
  it("keeps a row's position when it is rewritten", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* thread(sql, THREAD)
        yield* put(sql, "stream", THREAD, "Hi")
        yield* put(sql, "after", THREAD, "a later row")
        yield* put(sql, "stream", THREAD, "Hi again! What can I help you with?")
        return yield* sql<{ id: string; seq: number; body: string }>`
          select id, seq, body from timeline_item where thread_id = ${THREAD} order by seq`
      }),
    )
    const stream = rows.find((r) => r.id === "stream")
    const after = rows.find((r) => r.id === "after")
    expect(stream?.body).toContain("What can I help you with?")
    // Rewritten in place, and still ahead of the row that followed it.
    expect(stream!.seq).toBeLessThan(after!.seq)
  })

  /*
   * The collision itself: two writers that both believe the next free position
   * is N. Under caller-allocated seq the second insert threw; now neither can
   * name a position at all, so the question cannot arise.
   */
  it("cannot be made to collide by two writers racing the same position", async () => {
    const other = "01M01A6NDV8D5F798BDR3HDFHP"
    const rows = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* thread(sql, other)
        yield* put(sql, "w1", other, "from the reactor")
        yield* put(sql, "w2", other, "from the adapter")
        return yield* sql<{ rows: number; positions: number }>`
          select count(*) as rows, count(distinct seq) as positions
          from timeline_item where thread_id = ${other}`
      }),
    )
    expect(rows[0]?.rows).toBe(2)
    // Two rows, two positions: the collision cannot happen.
    expect(rows[0]?.positions).toBe(2)
  })

  it("counts positions per thread, not globally", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* thread(sql, "01M01A88JJ3SAT5ZTAG3RCPNFT")
        yield* put(sql, "solo", "01M01A88JJ3SAT5ZTAG3RCPNFT", "first in its own thread")
        return yield* sql<{ seq: number }>`
          select seq from timeline_item where id = 'solo'`
      }),
    )
    expect(rows[0]?.seq).toBe(1)
  })
})
