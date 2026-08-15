import { Redacted } from "effect"
import { describe, expect, it } from "vitest"
import type { BotId } from "@evie/contracts/ids"
import { inScopeOrder, spawnEnv } from "../src/provider/Supervisor.ts"

/**
 * `spawnEnv` is where BYOK either works or silently does not, so it is a pure
 * function and tested with no database, no child process, and no eve.
 *
 * The assertion that looks like nothing is the load-bearing one: a name with no
 * stored secret must be ABSENT from this object rather than empty. Absent is
 * what lets `extendEnv: true` fall through to the operator's own export, which
 * is the only path the shipped docs describe.
 */

const botId = "01JQ0000000000000000000000" as BotId
const runtimeSecret = "runtime-secret"
const msbHomeDir = "/evie-home/userdata/msb/0.5.10"
const stored = (name: string, value: string) => [name, Redacted.make(value)] as const

describe("the eve child's environment", () => {
  it("carries a stored secret under the name it was stored with", () => {
    const env = spawnEnv(botId, runtimeSecret, [], msbHomeDir, [stored("AI_GATEWAY_API_KEY", "sk-live-abcd1234")])
    // `extendEnv: true` merges this over `process.env`, so present here means
    // it beats whatever the operator exported.
    expect(env.AI_GATEWAY_API_KEY).toBe("sk-live-abcd1234")
  })

  it("leaves a name it has no secret for alone, so the operator's export survives", () => {
    const env = spawnEnv(botId, runtimeSecret, [], msbHomeDir, [])
    expect("AI_GATEWAY_API_KEY" in env).toBe(false)
    expect("ANTHROPIC_API_KEY" in env).toBe(false)
  })

  it("gives the bot scope the last word over the org's", () => {
    // `storedSecrets` lists org before bot; this is the half that makes that
    // ordering mean something.
    const env = spawnEnv(botId, runtimeSecret, [], msbHomeDir, [
      stored("AI_GATEWAY_API_KEY", "org-key"),
      stored("AI_GATEWAY_API_KEY", "bot-key"),
    ])
    expect(env.AI_GATEWAY_API_KEY).toBe("bot-key")
  })

  it("refuses to let a stored secret shadow the vars the runtime is trusted by", () => {
    // Whoever holds `secret:manage` could otherwise choose the token every
    // caller of this runtime authenticates with.
    const env = spawnEnv(botId, runtimeSecret, ["ai-gateway.vercel.sh"], msbHomeDir, [
      stored("EVIE_RUNTIME_SECRET", "chosen-by-an-admin"),
      stored("EVIE_BOT_ID", "some-other-bot"),
      stored("EVIE_ALLOWED_HOSTS", "[]"),
    ])
    expect(env.EVIE_RUNTIME_SECRET).toBe(runtimeSecret)
    expect(env.EVIE_BOT_ID).toBe(botId)
    expect(env.EVIE_ALLOWED_HOSTS).toBe(JSON.stringify(["ai-gateway.vercel.sh"]))
  })

  it("points the sandbox VM database at Evie's own version-keyed home", () => {
    // Not the machine-global ~/.microsandbox: msb aborts on a database
    // migrated by a different msb version, and anything else on the box may
    // have migrated the global one. A stored secret cannot re-point it either.
    const env = spawnEnv(botId, runtimeSecret, [], msbHomeDir, [
      stored("MSB_HOME", "/somewhere/else"),
    ])
    expect(env.MSB_HOME).toBe(msbHomeDir)
  })
})

/**
 * What must not reach the child.
 *
 * These are the cases where an env var stops being a credential and starts
 * being a way to change how the process runs -- or, in the grant case, a
 * credential handed to a sandbox that has no use for it.
 */
describe("names the child must never receive", () => {
  it("drops a connection grant, which is stored in the org scope and read by nobody", () => {
    // `gateway/handlers.ts` writes these as `grant:<connectionId>`. Without the
    // shape test every org grant would sit in every runtime's environment,
    // readable from inside the sandbox with `env`, in exchange for nothing.
    const env = spawnEnv(botId, runtimeSecret, [], msbHomeDir, [stored("grant:01JQABC", "tok_live_xyz")])
    expect(Object.keys(env)).toEqual([
      "EVIE_BOT_ID",
      "EVIE_RUNTIME_SECRET",
      "EVIE_ALLOWED_HOSTS",
      "MSB_HOME",
    ])
    expect(JSON.stringify(env)).not.toContain("tok_live_xyz")
  })

  it.each(["PATH", "NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "HOME", "SHELL"])(
    "refuses %s, which reconfigures the process rather than crediting it",
    (name) => {
      const env = spawnEnv(botId, runtimeSecret, [], msbHomeDir, [stored(name, "anything")])
      expect(name in env).toBe(false)
    },
  )

  it("still carries an ordinary key that merely looks unusual", () => {
    const env = spawnEnv(botId, runtimeSecret, [], msbHomeDir, [stored("_MY_PROVIDER_KEY2", "sk-1")])
    expect(env._MY_PROVIDER_KEY2).toBe("sk-1")
  })
})

/**
 * Scope precedence, held where it is actually decided.
 *
 * `spawnEnv` resolves precedence by assignment order, so the ordering step is
 * the thing that makes a bot-scoped key beat the org's. It cannot be delegated
 * to the query: `Secrets.list` sorts `order by scope, name`, and `bot:` sorts
 * before `org:` -- the exact inverse. This is the assertion that fails if
 * someone replaces the ordering with a plain map over the rows.
 */
describe("scope precedence", () => {
  const scopes = ["org:org_1", "bot:bot_1"] as const

  it("puts org before bot, against the order the database returns", () => {
    // Deliberately in the database's own (wrong) order.
    const rows = [
      { scope: "bot:bot_1", name: "AI_GATEWAY_API_KEY" },
      { scope: "org:org_1", name: "AI_GATEWAY_API_KEY" },
    ]
    expect(inScopeOrder(scopes, rows).map((ref) => ref.scope)).toEqual([
      "org:org_1",
      "bot:bot_1",
    ])
  })

  it("and so the bot's value is the one the child receives", () => {
    const rows = [
      { scope: "bot:bot_1", name: "AI_GATEWAY_API_KEY" },
      { scope: "org:org_1", name: "AI_GATEWAY_API_KEY" },
    ]
    const value = (scope: string) => (scope.startsWith("bot:") ? "sk-bot" : "sk-org")
    const env = spawnEnv(
      botId,
      runtimeSecret,
      [],
      msbHomeDir,
      inScopeOrder(scopes, rows).map((ref) => stored(ref.name, value(ref.scope))),
    )
    expect(env.AI_GATEWAY_API_KEY).toBe("sk-bot")
  })

  it("ignores a scope nobody stored anything in", () => {
    expect(inScopeOrder(scopes, [{ scope: "user:u_1", name: "X" }])).toEqual([])
  })
})
