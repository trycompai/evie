import { describe, expect, it } from "vitest"
import type { Command } from "@evie/contracts/commands"
import type { EvieEvent } from "@evie/contracts/events"
import type { BotId, OrgId, ThreadId, UserId } from "@evie/contracts/ids"
import { ulid } from "@evie/shared/ulid"
import { decide, type DecideEnv } from "../src/domain/decide.ts"
import { foldAggregate, type Actor } from "../src/domain/state.ts"

/**
 * The decider is pure, so it is tested with no model, no process, and no
 * socket. That is the whole reason it exists as a separate function: every
 * business rule in Evie is reachable from here in one call.
 *
 * Two kinds of assertion below, and they mean different things:
 *   - a rule produced the event it should have;
 *   - a rule REFUSED, and refused for the reason a user can act on.
 * The second kind is the one that rots silently, because a refusal that stops
 * firing looks exactly like a feature working.
 */

const orgId = "org_1" as OrgId
const userId = "user_1" as UserId
const otherUser = "user_2" as UserId

// Real ULIDs from the real minter at a fixed instant. Hand-written ids kept
// failing `isULID` in ways that looked like decider bugs -- Crockford base32
// has no I, L, O, or U, and the length is exactly 26.
const CLOCK = 1_700_000_000_000
const botId = ulid(CLOCK) as BotId
const threadId = ulid(CLOCK) as ThreadId
const strangerBotId = ulid(CLOCK) as BotId

const actor: Actor = { userId, orgId, role: "owner" }

const env = (over: Partial<DecideEnv> = {}): DecideEnv => ({
  now: CLOCK,
  // The real minter, so ids are valid ULIDs and monotonic within the run --
  // hand-written ids failed `isULID` in ways that looked like decider bugs.
  newId: () => ulid(CLOCK),
  orgMemberCount: 1,
  ...over,
})

/** Replays events into the aggregate they belong to, the way the gateway does. */
const at = (kind: "bot" | "thread" | "org", events: ReadonlyArray<EvieEvent>) =>
  foldAggregate(kind, events)

const created = (over: Partial<Parameters<typeof mkBotCreated>[0]> = {}) => mkBotCreated(over)

function mkBotCreated(over: { slug?: string; name?: string } = {}): EvieEvent {
  return {
    _tag: "BotCreated",
    botId,
    slug: over.slug ?? "ops",
    name: over.name ?? "Ops",
    teamId: null,
    model: "anthropic/claude-opus-4.8",
  } as EvieEvent
}

const threadOpened: EvieEvent = {
  _tag: "ThreadOpened",
  threadId,
  participants: [botId],
  title: null,
} as EvieEvent

describe("bots", () => {
  it("mints a slug that does not collide inside the organization", () => {
    const org = at("org", [mkBotCreated({ slug: "chief-of-staff" })])
    const [event] = decide(
      org,
      { _tag: "CreateBot", input: { name: "Chief of Staff", model: "m" } } as Command,
      actor,
      env(),
    )
    expect(event?._tag).toBe("BotCreated")
    // Two bots called "Chief of Staff" is a normal thing to want. The user
    // should not be told no.
    expect((event as { slug: string }).slug).toBe("chief-of-staff-2")
  })

  it("treats archiving an archived bot as a no-op, not an error", () => {
    const bot = at("bot", [created(), { _tag: "BotArchived", botId } as EvieEvent])
    // Two clients double-clicking is not a defect.
    expect(decide(bot, { _tag: "ArchiveBot", botId } as Command, actor, env())).toEqual([])
  })

  it("refuses to edit an archived bot", () => {
    const bot = at("bot", [created(), { _tag: "BotArchived", botId } as EvieEvent])
    expect(() => decide(bot, { _tag: "RenameBot", botId, name: "New" } as Command, actor, env())).toThrow(
      /archived/i,
    )
  })

  it("refuses a command against a bot that does not exist", () => {
    expect(() =>
      decide(at("bot", []), { _tag: "RenameBot", botId, name: "New" } as Command, actor, env()),
    ).toThrow()
  })
})

describe("the sandbox isolation refusal", () => {
  const toJustBash = { _tag: "SetSandboxBackend", botId, backend: "just-bash" } as Command

  it("allows just-bash in a one-member organization", () => {
    const bot = at("bot", [created()])
    expect(decide(bot, toJustBash, actor, env({ orgMemberCount: 1 }))).toHaveLength(1)
  })

  it("blocks moving TO just-bash once a second member exists", () => {
    // 05, refusal 3. Refusal 2 guards the door (invitations); this guards the
    // window. "Switch the sandbox, then invite" and "invite, then switch the
    // sandbox" have to reach the same answer or the check is decorative.
    const bot = at("bot", [created()])
    expect(() => decide(bot, toJustBash, actor, env({ orgMemberCount: 2 }))).toThrow(/isolation/i)
  })

  it("names a remedy the UI can offer", () => {
    const bot = at("bot", [created()])
    try {
      decide(bot, toJustBash, actor, env({ orgMemberCount: 2 }))
      expect.unreachable("should have refused")
    } catch (error) {
      // A refusal with no way out is a dead end, and the Computer pane has to
      // put something in the greyed-out option's tooltip.
      expect((error as { remedy?: string }).remedy).toBeTruthy()
    }
  })

  it("still allows an isolating backend at any member count", () => {
    const bot = at("bot", [created()])
    const events = decide(
      bot,
      { _tag: "SetSandboxBackend", botId, backend: "microsandbox" } as Command,
      actor,
      env({ orgMemberCount: 5 }),
    )
    expect(events).toHaveLength(1)
  })
})

describe("threads and turns", () => {
  it("folds a retried send onto the same message", () => {
    const send = {
      _tag: "SendMessage",
      threadId,
      text: "hi",
      mentions: [],
      attachments: [],
      idempotencyKey: "key-1",
    } as Command

    const first = decide(at("thread", [threadOpened]), send, actor, env())
    expect(first).toHaveLength(1)

    // A retry after a dropped socket is the same message, not a second one.
    const second = decide(at("thread", [threadOpened, ...first]), send, actor, env())
    expect(second).toEqual([])
  })

  it("refuses an @mention of a bot that is not in the thread", () => {
    expect(() =>
      decide(
        at("thread", [threadOpened]),
        {
          _tag: "SendMessage",
          threadId,
          text: "hi",
          mentions: [strangerBotId],
          attachments: [],
          idempotencyKey: "k",
        } as Command,
        actor,
        env(),
      ),
    ).toThrow(/not in the thread/i)
  })

  it("has an inverse for every one-way-looking state", () => {
    // AGENTS.md's reverse-state rule, asserted rather than remembered.
    const pairs: ReadonlyArray<readonly [Command, Command]> = [
      [
        { _tag: "SnoozeThread", threadId, until: CLOCK + 3_600_000 } as Command,
        { _tag: "UnsnoozeThread", threadId } as Command,
      ],
      [
        { _tag: "ArchiveThread", threadId } as Command,
        { _tag: "UnarchiveThread", threadId } as Command,
      ],
    ]

    for (const [forward, back] of pairs) {
      const applied = decide(at("thread", [threadOpened]), forward, actor, env())
      expect(applied.length, `${forward._tag} produced nothing`).toBeGreaterThan(0)
      const undone = decide(at("thread", [threadOpened, ...applied]), back, actor, env())
      expect(undone.length, `${back._tag} produced nothing`).toBeGreaterThan(0)
    }
  })
})

describe("boundaries the decider must not cross", () => {
  it("rejects organization commands instead of inventing events for them", () => {
    // They delegate to Better Auth. If one reaches the decider, that is a
    // routing bug and it should be loud rather than a silent no-op.
    expect(() =>
      decide(
        at("org", []),
        { _tag: "InviteMember", email: "a@b.c", role: "member" } as Command,
        actor,
        env(),
      ),
    ).toThrow()
  })

  it("never puts a secret value in an event", () => {
    const events = decide(
      at("org", []),
      { _tag: "SetSecret", scope: "org", name: "AI_GATEWAY_API_KEY", value: "sk-live-abcd1234" } as Command,
      actor,
      env(),
    )
    const json = JSON.stringify(events)
    expect(json).not.toContain("sk-live-abcd1234")
    // Only a hint survives, and it is short enough to be useless on its own.
    expect(json).toContain("AI_GATEWAY_API_KEY")
  })

  it("is deterministic: same state, same command, same events", () => {
    const state = at("bot", [created()])
    const command = { _tag: "RenameBot", botId, name: "Renamed" } as Command
    const a = decide(state, command, actor, env())
    const b = decide(at("bot", [created()]), command, actor, env())
    expect(a).toEqual(b)
  })

  it("does not read the actor for authorization", () => {
    // Authorization already ran in middleware. A `member` actor and an `owner`
    // actor must produce identical events for the same command -- if they ever
    // diverge, permission logic has leaked into business rules.
    const state = at("bot", [created()])
    const command = { _tag: "RenameBot", botId, name: "Renamed" } as Command
    const asOwner = decide(state, command, actor, env())
    const asMember = decide(
      at("bot", [created()]),
      command,
      { userId: otherUser, orgId, role: "member" },
      env(),
    )
    expect(asOwner).toEqual(asMember)
  })
})
