import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Bot } from "../src/bot.ts"
import { Command, aggregateOf, permissionOf } from "../src/commands.ts"
import { EvieError } from "../src/errors.ts"
import { SessionInfo } from "../src/org.ts"
import { Thread } from "../src/thread.ts"
import { TimelineFrame, TimelineItem } from "../src/timeline.ts"

/**
 * The tripwire for building on a release candidate.
 *
 * Effect 4 is at `4.0.0-rc.*` and the modules this whole contract rests on live
 * under `effect/unstable/*`, which is the library's own word for "this will
 * move". An rc that changes how a `Schema.Union` or an optional field encodes
 * would otherwise surface as a decode failure in production, on one message
 * type, weeks later. Here it surfaces as a red test on the upgrade commit.
 *
 * Round-trip, not shape: `encode(decode(x))` must equal `x` for a value of
 * every variant that crosses the wire. A schema can be structurally fine and
 * still lose a field in one direction.
 */

const roundTrip = <A, I>(schema: Schema.Codec<A, I>, value: A): A => {
  const encoded = Schema.encodeUnknownSync(schema)(value)
  return Schema.decodeUnknownSync(schema)(encoded)
}

const ULID = "01J9ZZZZZZZZZZZZZZZZZZZZZZ"
const now = 1_700_000_000_000

describe("wire round-trips", () => {
  it("Bot", () => {
    const bot = Schema.decodeUnknownSync(Bot)({
      id: ULID,
      orgId: "org_1",
      teamId: null,
      slug: "chief-of-staff",
      name: "Chief of Staff",
      description: null,
      avatar: null,
      model: "anthropic/claude-opus-4.8",
      reasoning: "high",
      runtimeMode: "dev",
      sandbox: {
        backend: "docker",
        network: { mode: "allow-list", allow: ["ai-gateway.vercel.sh"], enforced: "coarse" },
      },
      health: { kind: "ready" },
      createdBy: "user_1",
      createdAt: now,
      archivedAt: null,
    })
    expect(roundTrip(Bot, bot)).toEqual(bot)
  })

  it("Thread, with every status variant", () => {
    const base = {
      id: ULID,
      orgId: "org_1",
      title: null,
      participants: [{ botId: ULID, eveSessionId: null, streamIndex: 0, isDefault: true }],
      preview: null,
      createdBy: "user_1",
      createdAt: now,
      lastActivity: now,
      snoozedUntil: null,
      archivedAt: null,
    }
    const statuses = [
      { kind: "ready" },
      { kind: "thinking", turnId: ULID },
      { kind: "thinking", turnId: null },
      { kind: "running", tool: "bash", turnId: ULID },
      { kind: "waitingOnYou" },
      { kind: "waitingOnSignIn", service: "GitHub", forUserId: "user_1" },
      { kind: "waitingOnSubagent", name: "researcher" },
      { kind: "compacting" },
      { kind: "reconnecting" },
      { kind: "catchingUp" },
    ]
    for (const status of statuses) {
      const thread = Schema.decodeUnknownSync(Thread)({ ...base, status })
      expect(roundTrip(Thread, thread)).toEqual(thread)
    }
  })

  const timelineBase = { id: "row-1", threadId: ULID, seq: 1, at: now }

  const items: ReadonlyArray<unknown> = [
    { ...timelineBase, kind: "user", authorId: "user_1", parts: [{ type: "text", text: "hi" }] },
    {
      ...timelineBase,
      kind: "assistant",
      botId: ULID,
      turnId: ULID,
      parts: [
        { type: "text", text: "hello" },
        // The count with no body: what a reopened thread always decodes to.
        { type: "reasoning", tokens: 4200 },
        { type: "file", mediaType: "text/csv", filename: "q3.csv", size: 12 },
      ],
      finishReason: "stop",
    },
    {
      ...timelineBase,
      kind: "tool",
      botId: ULID,
      turnId: ULID,
      callId: "call_1",
      name: "bash",
      state: "ok",
      input: "ls /workspace",
      output: { stdout: "data\n" },
      truncated: false,
      durationMs: 412,
    },
    {
      ...timelineBase,
      kind: "input",
      botId: ULID,
      requestId: "req_1",
      prompt: "Send the summary to #finance?",
      options: [
        { id: "yes", label: "Approve", hotkey: "A" },
        { id: "always", label: "Always for this session" },
        { id: "no", label: "Deny", tone: "danger" },
      ],
      allowFreeform: false,
      state: "pending",
    },
    {
      ...timelineBase,
      kind: "auth",
      botId: ULID,
      forUserId: "user_1",
      displayName: "GitHub",
      url: "https://github.com/login/device",
      userCode: "WDJB-MJHT",
      state: "pending",
    },
    {
      ...timelineBase,
      kind: "subagent",
      botId: ULID,
      childSessionId: "sess_1",
      name: "researcher",
      state: "running",
    },
    { ...timelineBase, kind: "system", event: "compacted" },
    { ...timelineBase, kind: "error", code: "CredentialProblem", message: "no key", retryable: false },
  ]

  it.each(items.map((item) => [(item as { kind: string }).kind, item] as const))(
    "TimelineItem: %s",
    (_kind, raw) => {
      const item = Schema.decodeUnknownSync(TimelineItem)(raw)
      expect(roundTrip(TimelineItem, item)).toEqual(item)
    },
  )

  it("TimelineFrame carries every op shape", () => {
    const frame = Schema.decodeUnknownSync(TimelineFrame)({
      threadId: ULID,
      seq: 12,
      mode: "full",
      status: { kind: "thinking", turnId: ULID },
      ops: [
        { op: "insert", item: items[0] },
        { op: "appendText", id: "row-1", partIndex: 0, chunk: " world" },
        { op: "appendReasoning", id: "row-1", partIndex: 1, tokens: 10 },
        { op: "appendReasoning", id: "row-1", partIndex: 1, tokens: 20, chunk: "hmm" },
        { op: "replace", item: items[2] },
      ],
    })
    expect(roundTrip(TimelineFrame, frame)).toEqual(frame)
  })

  it("SessionInfo", () => {
    const session = Schema.decodeUnknownSync(SessionInfo)({
      contractVersion: 1,
      userId: "user_1",
      orgId: "org_1",
      role: "owner",
      permissions: ["bot:create", "thread:write"],
      mode: "local",
      organizations: [{ id: "org_1", name: "Personal", slug: "personal", logo: null, memberCount: 1 }],
    })
    expect(roundTrip(SessionInfo, session)).toEqual(session)
  })

  it("every EvieError variant", () => {
    const errors: ReadonlyArray<unknown> = [
      { _tag: "ContractMismatch", client: 1, server: 2 },
      { _tag: "HandshakeRequired" },
      { _tag: "Unauthenticated" },
      { _tag: "Forbidden", permission: "bot:create" },
      { _tag: "NotFound", resource: "bot", id: ULID },
      { _tag: "ConcurrencyConflict", aggregate: `bot:${ULID}`, expected: 3, actual: 4 },
      { _tag: "InvalidCommand", reason: "already archived" },
      { _tag: "PolicyViolation", policy: "just-bash", reason: "second member exists" },
      { _tag: "RuntimeUnavailable", botId: ULID, reason: "spawn failed" },
      { _tag: "CredentialProblem", secretName: "AI_GATEWAY_API_KEY", reason: "missing" },
      { _tag: "StorageUnavailable", reason: "disk full" },
    ]
    for (const raw of errors) {
      const error = Schema.decodeUnknownSync(EvieError)(raw)
      expect(roundTrip(EvieError, error)).toEqual(error)
    }
  })
})

describe("command routing", () => {
  /**
   * Exhaustiveness by construction: `Command` is a union and both helpers
   * switch on `_tag`, so a new command that nobody routed falls through to the
   * default and is silently org-scoped and thread-permissioned. Walking every
   * member of the union is what makes that loud.
   */
  const tags = (Command.members as ReadonlyArray<{ readonly fields: { readonly _tag: { readonly schema: { readonly literal: string } } } }>)
    .map((member) => member.fields._tag.schema.literal)

  it("covers every command in the union", () => {
    expect(tags.length).toBeGreaterThan(30)
    expect(new Set(tags).size).toBe(tags.length)
  })

  it("routes bot-scoped commands to their bot", () => {
    expect(aggregateOf({ _tag: "RenameBot", botId: ULID, name: "x" } as Command)).toEqual({
      kind: "bot",
      id: ULID,
    })
  })

  it("routes thread-scoped commands to their thread", () => {
    expect(
      aggregateOf({
        _tag: "SendMessage",
        threadId: ULID,
        text: "hi",
        mentions: [],
        attachments: [],
        idempotencyKey: "k",
      } as unknown as Command),
    ).toEqual({ kind: "thread", id: ULID })
  })

  it("routes creation commands to the organization", () => {
    // The aggregate they would otherwise name does not exist yet. This is the
    // one case where org-level serialization is correct rather than lazy.
    expect(aggregateOf({ _tag: "OpenThread", participants: [ULID] } as unknown as Command)).toEqual({ kind: "org" })
  })

  it("gives every command a permission, or an explicit null", () => {
    for (const tag of tags) {
      const permission = permissionOf({ _tag: tag } as Command)
      // `null` is a decision, not a default: it says the check belongs
      // somewhere other than `hasPermission` against the current org. Only
      // SetActiveOrg qualifies today, and the middleware branches on it.
      if (tag === "SetActiveOrg") expect(permission).toBeNull()
      else expect(permission, `${tag} has no permission`).toMatch(/^[a-z]+:[a-z]+$/)
    }
  })
})
