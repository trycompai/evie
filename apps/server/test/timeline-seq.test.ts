import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { afterAll, describe, expect, it } from "vitest"
import { resolveHome } from "@evie/shared/home"
import type { StoredEvent } from "@evie/contracts/events"
import { EvieConfig } from "../src/config.ts"
import { Db } from "../src/db/Db.ts"
import { MigrationsLive } from "../src/db/migrations.ts"
import {
  apply,
  emptyReadModel,
  makeThreadPositions,
  type ReadModel,
  type RowChange,
} from "../src/domain/project.ts"
import { positionOf } from "../src/store/positions.ts"

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

/**
 * The insert both writers share, reduced to the part under test. `predicted`
 * is what the caller's allocator believes the position is; the statement is
 * what happens when it is right, and when it is not.
 */
const put = (
  sql: SqlClient.SqlClient,
  id: string,
  thread: string,
  text: string,
  predicted = 1,
) => sql`
  insert into timeline_item (id, thread_id, seq, kind, bot_id, actor_user_id, turn_id, body, at)
  select ${id}, ${thread}, position, 'assistant', null, null, null,
         json_set(${JSON.stringify({ id, text, seq: predicted })}, '$.seq', position), 0
  from (select ${positionOf(sql, { id, threadId: thread, predicted })} as position) where true
  on conflict (id) do update set body = excluded.body`

/** What a client would read out of the row: the position it carries. */
const bodySeq = (body: string): number => (JSON.parse(body) as { seq: number }).seq

const BOT = "01M01C46XSV5ZYJTMYGN9G0GGW"

const seqOf = (changes: ReadonlyArray<RowChange>): number => {
  const change = changes.find((candidate) => candidate.kind === "timeline")
  if (change === undefined) throw new Error("projected no timeline row")
  return (change as { row: { item: { seq: number } } }).row.item.seq
}

/** A user message: a row only the projector's model ever sees. */
const putUserItem = (model: ReadModel, id: string, threadId = THREAD): number =>
  seqOf(
    apply(model, {
      id,
      orgId: "org_1",
      threadId,
      botId: null,
      at: 0,
      actorUserId: "user_1",
      data: {
        _tag: "MessageSent",
        threadId,
        text: id,
        mentions: [],
        attachments: [],
        idempotencyKey: id,
      },
    } as unknown as StoredEvent),
  )

/** An assistant reply: a row only the adapter's model ever sees. */
const putAssistantItem = (model: ReadModel, id: string, threadId = THREAD): number =>
  seqOf(
    apply(model, {
      id: `evt_${id}`,
      orgId: "org_1",
      threadId,
      botId: BOT,
      at: 0,
      actorUserId: "user_1",
      data: {
        _tag: "EveMirrored",
        threadId,
        botId: BOT,
        sessionId: "wrun_1",
        streamIndex: 1,
        eveType: "message.completed",
        payload: {
          message: "hi",
          finishReason: "stop",
          sequence: Number(id.split("/")[2]),
          stepIndex: 0,
          turnId: id.split("/")[0],
        },
      },
    } as unknown as StoredEvent),
  )

describe("timeline_item.seq", () => {
  it("hands consecutive positions to different rows", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* thread(sql, THREAD)
        yield* put(sql, "a", THREAD, "one", 1)
        yield* put(sql, "b", THREAD, "two", 2)
        yield* put(sql, "c", THREAD, "three", 3)
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
        yield* put(sql, "stream", THREAD, "Hi", 1)
        yield* put(sql, "after", THREAD, "a later row", 2)
        yield* put(sql, "stream", THREAD, "Hi again! What can I help you with?", 1)
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
   * is N. Under a caller-allocated seq the second insert threw; the statement
   * now clamps the loser up instead of failing.
   */
  it("cannot be made to collide by two writers racing the same position", async () => {
    const other = "01M01A6NDV8D5F798BDR3HDFHP"
    const rows = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* thread(sql, other)
        yield* put(sql, "w1", other, "from the reactor", 1)
        yield* put(sql, "w2", other, "from the adapter", 1)
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
        yield* put(sql, "solo", "01M01A88JJ3SAT5ZTAG3RCPNFT", "first in its own thread", 1)
        return yield* sql<{ seq: number }>`
          select seq from timeline_item where id = 'solo'`
      }),
    )
    expect(rows[0]?.seq).toBe(1)
  })

  /*
   * The second half of the same bug, and the one that reached the client.
   *
   * A row carries its position twice: the column, which the server pages and
   * resumes by, and a copy in the body, which is what the client sorts on.
   * Clamping the column without rewriting the body left the two disagreeing,
   * so rows tied in the UI and every `since` cursor was compared against a
   * number from the other namespace.
   */
  it("writes the position it allocated into the body", async () => {
    const thr = "01M02YKS3PHBGTSRA8ZYHWMTFQ"
    const rows = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* thread(sql, thr)
        yield* put(sql, "first", thr, "one", 1)
        // A stale prediction -- exactly what a second, unshared counter hands
        // out. The row is clamped past the collision, and the body follows.
        yield* put(sql, "second", thr, "two", 1)
        return yield* sql<{ id: string; seq: number; body: string }>`
          select id, seq, body from timeline_item where thread_id = ${thr} order by seq`
      }),
    )
    expect(rows.map((r) => [r.id, r.seq])).toEqual([
      ["first", 1],
      ["second", 2],
    ])
    for (const row of rows) expect(bodySeq(row.body)).toBe(row.seq)
  })

  it("keeps the body in step when a row is rewritten", async () => {
    const thr = "01M02ZCGKYRDYJGXB8EJN6S44Z"
    const rows = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* thread(sql, thr)
        yield* put(sql, "reply", thr, "Hi", 1)
        yield* put(sql, "next", thr, "later", 2)
        // The streaming row is rewritten every flush window, and the predicted
        // position it was first given is the one it must keep.
        yield* put(sql, "reply", thr, "Hi again", 1)
        return yield* sql<{ id: string; seq: number; body: string }>`
          select id, seq, body from timeline_item where thread_id = ${thr} order by seq`
      }),
    )
    expect(rows.map((r) => [r.id, r.seq, bodySeq(r.body)])).toEqual([
      ["reply", 1, 1],
      ["next", 2, 2],
    ])
  })
})

/*
 * Why a caller can predict the position at all: both projections allocate from
 * one counter. Each publishes its row to subscribers before the write, so the
 * number on the wire has to be the number the row ends up with -- which is
 * only true if nobody else can take it first.
 */
describe("the shared position allocator", () => {
  it("never hands the same position to two projections", () => {
    const positions = makeThreadPositions()
    const reactor = emptyReadModel(positions)
    const adapter = emptyReadModel(positions)

    const user = putUserItem(reactor, "user_1")
    const reply = putAssistantItem(adapter, "turn_1/0/1")
    const next = putUserItem(reactor, "user_2")

    expect([user, reply, next]).toEqual([1, 2, 3])
  })

  it("resumes from what the table already holds", () => {
    const positions = makeThreadPositions()
    // Hydration: the projector opens a thread that already has 49 rows.
    positions.observe(THREAD, 49)
    // The adapter attaches to the same thread and has hydrated nothing yet.
    expect(putAssistantItem(emptyReadModel(positions), "turn_1/0/1")).toBe(50)
  })

  it("counts each thread separately", () => {
    const positions = makeThreadPositions()
    positions.observe(THREAD, 49)
    const model = emptyReadModel(positions)
    expect(putUserItem(model, "elsewhere", "01M01A88JJ3SAT5ZTAG3RCPNFT")).toBe(1)
  })
})
