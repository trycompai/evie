import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { afterAll, describe, expect, it } from "vitest"
import type { StoredEvent } from "@evie/contracts/events"
import type { BotId, OrgId, SessionId, ThreadId } from "@evie/contracts/ids"
import { resolveHome } from "@evie/shared/home"
import { ulid } from "@evie/shared/ulid"
import { EvieConfig } from "../src/config.ts"
import { Db } from "../src/db/Db.ts"
import { MigrationsLive } from "../src/db/migrations.ts"
import { apply, emptyReadModel } from "../src/domain/project.ts"

/**
 * "Always allow for this session", which Evie has to implement itself.
 *
 * eve's `inputResponseSchema` is strict and carries exactly `requestId`,
 * `optionId`, and `text` — there is nowhere to put a scope and an unknown key
 * is rejected rather than ignored. So the grant is Evie's: recorded against
 * (session, tool) when the user answers with `always`, and applied by the turn
 * reactor the next time that tool asks.
 *
 * Two things are worth pinning, and they are the two that would silently make
 * the feature a lie again: that the tool name survives projection (a grant with
 * no tool to key on cannot be stored), and that re-granting updates rather than
 * duplicating or throwing.
 *
 * Temp directory, never `~/.evie` — see rule 2 in AGENTS.md.
 */

const root = mkdtempSync(join(tmpdir(), "evie-input-grant-"))
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

const TestLayer = MigrationsLive.pipe(Layer.provideMerge(Db.layer), Layer.provide(ConfigTest))

const CLOCK = 1_700_000_000_000
const orgId = "org_1" as OrgId
const botId = ulid(CLOCK) as BotId
const threadId = ulid(CLOCK) as ThreadId
const sessionId = "sess_1" as SessionId

/** One mirrored `input.requested`, in eve's real shape. */
const requested = (request: Record<string, unknown>): StoredEvent =>
  ({
    id: ulid(CLOCK),
    orgId,
    threadId,
    botId,
    at: CLOCK,
    actorUserId: "user_1",
    data: {
      _tag: "EveMirrored",
      threadId,
      botId,
      sessionId,
      streamIndex: 1,
      eveType: "input.requested",
      payload: { requests: [request] },
    },
  }) as unknown as StoredEvent

describe("the tool name a grant is keyed on", () => {
  const project = (request: Record<string, unknown>) => {
    const model = emptyReadModel()
    const changes = apply(model, requested(request))
    const change = changes.find((candidate) => candidate.kind === "timeline")
    return change === undefined
      ? undefined
      : (change as { row: { item: { toolName?: string } } }).row.item
  }

  it("reads eve's nested action.toolName", () => {
    const item = project({
      requestId: "req_1",
      prompt: "Run this?",
      kind: "tool-approval",
      action: { kind: "tool-call", toolName: "bash", callId: "c1", input: {} },
    })
    expect(item?.toolName).toBe("bash")
  })

  /* Older payloads put the tool at the top level; both are the same request. */
  it("falls back to a top-level toolName", () => {
    expect(project({ requestId: "req_2", prompt: "Run?", toolName: "write_file" })?.toolName).toBe(
      "write_file",
    )
  })

  /*
   * A plain question gates no tool, so there is nothing a session grant could
   * mean. The card must not offer one, which is what an absent name produces.
   */
  it("leaves the tool absent for a question", () => {
    const item = project({ requestId: "req_3", prompt: "Which colour?", kind: "question" })
    expect(item?.toolName).toBeUndefined()
  })
})

describe("input_grant", () => {
  const run = <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) =>
    Effect.runPromise(effect.pipe(Effect.provide(TestLayer)) as Effect.Effect<A>)

  it("is keyed by session and tool, and re-granting updates in place", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const insert = (optionId: string, by: string) => sql`
          insert into input_grant (session_id, tool_name, option_id, granted_by, granted_at)
          values (${sessionId}, 'bash', ${optionId}, ${by}, ${CLOCK})
          on conflict (session_id, tool_name) do update set
            option_id = excluded.option_id,
            granted_by = excluded.granted_by,
            granted_at = excluded.granted_at`

        yield* insert("approve", "user_1")
        // A second grant for the same tool must not throw and must not stack.
        yield* insert("approve-once", "user_2")

        return yield* sql<{ option_id: string; granted_by: string; n: number }>`
          select option_id, granted_by, count(*) as n from input_grant
          where session_id = ${sessionId} and tool_name = 'bash'`
      }),
    )
    expect(rows[0]?.n).toBe(1)
    expect(rows[0]?.option_id).toBe("approve-once")
    expect(rows[0]?.granted_by).toBe("user_2")
  })

  /* The promise on the card is "for this session". A second session is a second decision. */
  it("does not leak across sessions", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`
          insert into input_grant (session_id, tool_name, option_id, granted_by, granted_at)
          values ('sess_other', 'bash', 'approve', 'user_1', ${CLOCK})`
        return yield* sql<{ session_id: string }>`
          select session_id from input_grant where tool_name = 'bash' order by session_id`
      }),
    )
    expect(rows.map((row) => row.session_id)).toEqual(["sess_1", "sess_other"])
  })
})
