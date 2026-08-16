import { describe, expect, it } from "vitest"
import type { Command } from "@evie/contracts/commands"
import type { EvieEvent } from "@evie/contracts/events"
import type { BotId, OrgId, RoutineId, UserId } from "@evie/contracts/ids"
import { ulid } from "@evie/shared/ulid"
import { decide, type DecideEnv } from "../src/domain/decide.ts"
import { routineOf, type RoutineTableRow } from "../src/gateway/routine-row.ts"
import { foldAggregate, type Actor } from "../src/domain/state.ts"

/**
 * Routines: the rules a person can actually hit from the editor, and the one
 * judgement the read model makes on the way out.
 *
 * The decider half is about refusals. A routine runs with nobody present, so
 * the two things it can get wrong are a cron that means the wrong morning and
 * a run that has no principal to act as -- and eve answers the second with
 * `principal_required` at fire time, hours later, in a log nobody is reading.
 * Catching it at the command is the whole point.
 *
 * The read-model half is `nextRunAt`, which is the only field that is not a
 * rename.
 */

const orgId = "org_1" as OrgId
const userId = "user_1" as UserId
const CLOCK = 1_700_000_000_000
const botId = ulid(CLOCK) as BotId
const routineId = ulid(CLOCK) as RoutineId

const actor: Actor = { userId, orgId, role: "owner" }

const env = (over: Partial<DecideEnv> = {}): DecideEnv => ({
  now: CLOCK,
  newId: () => ulid(CLOCK),
  orgMemberCount: 1,
  ...over,
})

const created: EvieEvent = {
  _tag: "BotCreated",
  botId,
  slug: "ops",
  name: "Ops",
  teamId: null,
  model: "anthropic/claude-opus-4.8",
  avatar: null,
  reasoning: null,
} as EvieEvent

/** A member-scoped connection is what makes `runAs` mandatory. */
const memberConnection: EvieEvent = {
  _tag: "ServiceConnected",
  botId,
  connectionId: ulid(CLOCK),
  name: "linear",
  kind: "mcp",
  scope: "member",
  config: { url: "https://mcp.linear.app/mcp" },
  authKind: "interactive",
} as EvieEvent

const routineCreated = (over: { runAs?: UserId | null } = {}): EvieEvent =>
  ({
    _tag: "RoutineCreated",
    routineId,
    botId,
    name: "Morning digest",
    cron: "0 9 * * 1-5",
    tz: "Europe/London",
    prompt: "Summarise what changed.",
    threadId: null,
    runAs: over.runAs === undefined ? null : over.runAs,
  }) as EvieEvent

const create = (over: Partial<Record<string, unknown>> = {}): Command =>
  ({
    _tag: "CreateRoutine",
    botId,
    name: "Morning digest",
    cron: "0 9 * * 1-5",
    tz: "Europe/London",
    prompt: "Summarise what changed.",
    ...over,
  }) as Command

describe("creating a routine", () => {
  it("accepts the cadences the editor builds", () => {
    const bot = foldAggregate("bot", [created])
    // Exactly the expressions `buildCron` produces, so the editor cannot offer
    // a cadence the decider rejects.
    for (const cron of ["*/15 * * * *", "30 * * * *", "0 9 * * *", "0 9 * * 1-5", "5 8 * * 3"]) {
      const events = decide(bot, create({ cron }), actor, env())
      expect(events, cron).toHaveLength(1)
      expect(events[0]?._tag).toBe("RoutineCreated")
    }
  })

  it("refuses a cron that is not five fields", () => {
    const bot = foldAggregate("bot", [created])
    // The field count is the one cron mistake that is silent: four fields
    // parses somewhere and means something else.
    for (const cron of ["0 9 * *", "0 9 * * 1-5 2026", "@daily", ""]) {
      expect(() => decide(bot, create({ cron }), actor, env()), cron).toThrow(/cron/i)
    }
  })

  it("demands a run-as member once the bot holds a member-scoped connection", () => {
    const bot = foldAggregate("bot", [created, memberConnection])
    // eve fails this at fire time with `principal_required`. Refusing at the
    // command is the difference between a message now and a silent 3am no-op.
    expect(() => decide(bot, create(), actor, env())).toThrow(/run-as|member/i)
  })

  it("accepts the same routine once it names one", () => {
    const bot = foldAggregate("bot", [created, memberConnection])
    expect(decide(bot, create({ runAs: userId }), actor, env())).toHaveLength(1)
  })

  it("needs no run-as member when nothing is member-scoped", () => {
    const bot = foldAggregate("bot", [created])
    expect(decide(bot, create(), actor, env())).toHaveLength(1)
  })
})

describe("pausing and resuming", () => {
  const enabled = (value: boolean): Command =>
    ({ _tag: "SetRoutineEnabled", botId, routineId, enabled: value }) as Command

  it("is a no-op when the routine is already in that state", () => {
    const bot = foldAggregate("bot", [created, routineCreated()])
    // Two clients clicking Pause is not a defect.
    expect(decide(bot, enabled(true), actor, env())).toEqual([])
  })

  it("pauses a live routine", () => {
    const bot = foldAggregate("bot", [created, routineCreated()])
    const events = decide(bot, enabled(false), actor, env())
    expect(events).toHaveLength(1)
    expect(events[0]?._tag).toBe("RoutineEnabled")
  })

  it("refuses to resume one that lost its principal", () => {
    const bot = foldAggregate("bot", [
      created,
      memberConnection,
      routineCreated(),
      { _tag: "RoutineEnabled", botId, routineId, enabled: false } as EvieEvent,
    ])
    // Pausing is always allowed; resuming into a run that cannot authenticate
    // is not. The reverse state exists, it just refuses to lie.
    expect(() => decide(bot, enabled(true), actor, env())).toThrow(/run-as|member/i)
  })

  it("refuses a routine that does not exist", () => {
    const bot = foldAggregate("bot", [created])
    expect(() => decide(bot, enabled(false), actor, env())).toThrow()
  })
})

describe("what the list reports", () => {
  const row = (over: Partial<RoutineTableRow> = {}): RoutineTableRow => ({
    id: routineId,
    bot_id: botId,
    thread_id: null,
    name: "Morning digest",
    cron: "0 9 * * 1-5",
    tz: "Europe/London",
    prompt: "Summarise what changed.",
    run_as: null,
    enabled: 1,
    blocked_reason: null,
    last_run_at: CLOCK,
    next_run_at: CLOCK + 86_400_000,
    ...over,
  })

  it("carries the due time for a live routine", () => {
    expect(routineOf(row()).nextRunAt).toBe(CLOCK + 86_400_000)
  })

  it("reports no due time for a paused one", () => {
    // The scheduler only recomputes rows it might fire, so a paused routine
    // keeps a stale `next_run_at` that drifts into the past. Passing it
    // through would render "Next run" for something that never runs.
    expect(routineOf(row({ enabled: 0 })).nextRunAt).toBeNull()
    expect(routineOf(row({ enabled: 0 })).enabled).toBe(false)
  })

  it("reports no due time for a blocked one, and says why", () => {
    const blocked = routineOf(row({ blocked_reason: "run-as member left the organization" }))
    expect(blocked.nextRunAt).toBeNull()
    expect(blocked.blockedReason).toBe("run-as member left the organization")
    // Blocked is not paused: the switch is still on, which is what makes the
    // row explain itself rather than invite a pointless click.
    expect(blocked.enabled).toBe(true)
  })

  it("survives SQLite handing back bigints", () => {
    // better-sqlite3 returns integers as bigint past 2^31; a Date built from
    // one throws, and it would throw inside a list render.
    const wide = routineOf(row({ last_run_at: BigInt(CLOCK), next_run_at: BigInt(CLOCK + 60_000) }))
    expect(wide.lastRunAt).toBe(CLOCK)
    expect(wide.nextRunAt).toBe(CLOCK + 60_000)
  })
})
