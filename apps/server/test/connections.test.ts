import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import type { BotId, OrgId } from "@evie/contracts/ids"
import { botDir, resolveHome } from "@evie/shared/home"
import { Effect, Layer, Redacted } from "effect"
import { afterAll, describe, expect, it } from "vitest"
import { EvieConfig } from "../src/config.ts"
import {
  connectionEnvName,
  isGeneratable,
  Scaffold,
  type ConnectionSpec,
} from "../src/provider/scaffold.ts"
import { spawnEnv } from "../src/provider/Supervisor.ts"

/**
 * Connecting a service has to actually give the bot its tools.
 *
 * Before this, `ServiceConnected` updated the read model and stopped there:
 * the app showed a connection, `agent/connections/` stayed empty, and the bot
 * had no tool for the service it had just been handed. This reconciles that
 * directory from the bot's rows on every spawn.
 *
 * The two halves that can silently disagree are pinned here. The generated
 * file reads a token from an environment variable, and `spawnEnv` is what puts
 * it there -- written in a different module, so a rename on one side is a 401
 * at the first tool call and nothing at build time. And the sweep is what
 * makes disconnecting real; without it a revoked integration keeps working.
 *
 * Temp directory, never `~/.evie` -- see rule 2 in AGENTS.md.
 */

const root = mkdtempSync(join(tmpdir(), "evie-connections-"))
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

const ScaffoldTest = Scaffold.layer.pipe(Layer.provide([ConfigTest, NodeServices.layer]))

const orgId = "org_1" as OrgId

const spec = (over: Partial<ConnectionSpec> = {}): ConnectionSpec => ({
  name: "linear",
  kind: "mcp",
  scope: "org",
  authKind: "token",
  url: "https://mcp.linear.app/mcp",
  ...over,
})

const seedBot = (botId: BotId) => {
  const dir = botDir(home, orgId, botId)
  mkdirSync(join(dir, "agent", "channels"), { recursive: true })
  mkdirSync(join(dir, "agent", "sandbox"), { recursive: true })
  writeFileSync(join(dir, "agent", "instructions.md"), "# Bot\n", "utf8")
  return dir
}

const run = <A, E>(effect: Effect.Effect<A, E, Scaffold>) =>
  Effect.runPromise(effect.pipe(Effect.provide(ScaffoldTest)) as Effect.Effect<A, E, never>)

const regenerate = (botId: BotId, connections: ReadonlyArray<ConnectionSpec>) =>
  run(Effect.flatMap(Scaffold, (scaffold) => scaffold.regenerate({ orgId, botId, connections })))

const connectionsDir = (dir: string) => join(dir, "agent", "connections")
const listConnections = (dir: string) => readdirSync(connectionsDir(dir)).sort()

describe("generating a connection", () => {
  it("writes an MCP connection the model can reach", async () => {
    const botId = "bot_mcp" as BotId
    const dir = seedBot(botId)

    await regenerate(botId, [spec()])

    const source = readFileSync(join(connectionsDir(dir), "linear.ts"), "utf8")
    expect(source).toContain("defineMcpClientConnection")
    expect(source).toContain("https://mcp.linear.app/mcp")
    // The filename is the runtime name eve registers, so the model calls its
    // tools as `linear__*`. Getting this from anywhere but the row is a rename
    // the user never asked for.
    expect(listConnections(dir)).toEqual(["linear.ts"])
  })

  it("writes an OpenAPI connection with its document and base URL", async () => {
    const botId = "bot_openapi" as BotId
    const dir = seedBot(botId)

    await regenerate(botId, [
      spec({
        name: "warehouse",
        kind: "openapi",
        url: "https://api.example.com/openapi.json",
        baseUrl: "https://api.example.com",
      }),
    ])

    const source = readFileSync(join(connectionsDir(dir), "warehouse.ts"), "utf8")
    expect(source).toContain("defineOpenAPIConnection")
    expect(source).toContain('spec: "https://api.example.com/openapi.json"')
    expect(source).toContain('baseUrl: "https://api.example.com"')
  })

  it("reads its token from the variable the spawn actually sets", async () => {
    const botId = "bot_token" as BotId
    const dir = seedBot(botId)

    await regenerate(botId, [spec()])
    const source = readFileSync(join(connectionsDir(dir), "linear.ts"), "utf8")

    // The whole point of this test. `connectionEnvName` is the only thing
    // standing between the file and the spawn, so assert against the env
    // `spawnEnv` really builds, not against a string literal.
    const env = spawnEnv(
      botId,
      "runtime-secret",
      [],
      "/msb",
      [],
      [[connectionEnvName("linear"), Redacted.make("tok_live")]],
    )
    const name = connectionEnvName("linear")
    expect(name).toBe("EVIE_CONN_LINEAR")
    expect(source).toContain(name)
    expect(Object.keys(env)).toContain(name)
  })

  it("omits auth entirely when the service needs none", async () => {
    const botId = "bot_noauth" as BotId
    const dir = seedBot(botId)

    await regenerate(botId, [spec({ name: "public", authKind: "none" })])

    const source = readFileSync(join(connectionsDir(dir), "public.ts"), "utf8")
    expect(source).not.toContain("getToken")
    expect(source).not.toContain("EVIE_CONN")
  })

  it("names the missing variable rather than sending undefined as a bearer token", async () => {
    const botId = "bot_missing_token" as BotId
    const dir = seedBot(botId)

    await regenerate(botId, [spec()])

    const source = readFileSync(join(connectionsDir(dir), "linear.ts"), "utf8")
    // An unlinked grant is a normal state. It has to fail as something a person
    // can act on, not as `Authorization: Bearer undefined`.
    expect(source).toContain("is not set")
    expect(source).toMatch(/throw new Error/)
  })
})

describe("what Evie refuses to generate", () => {
  it("skips member scope and interactive auth, which need an OAuth proxy that does not exist", () => {
    expect(isGeneratable(spec({ scope: "member" }))).toBe(false)
    expect(isGeneratable(spec({ authKind: "interactive" }))).toBe(false)
    expect(isGeneratable(spec({ kind: "graphql" }))).toBe(false)
    expect(isGeneratable(spec())).toBe(true)
  })

  it("writes no file for one, so the bot has no tool rather than a broken one", async () => {
    const botId = "bot_member" as BotId
    const dir = seedBot(botId)

    await regenerate(botId, [spec({ name: "gmail", scope: "member", authKind: "interactive" })])

    // A file here would compile and then fail at the first tool call, which
    // reads as a broken service instead of an unfinished feature.
    expect(listConnections(dir)).toEqual([])
  })
})

describe("reconciling the directory", () => {
  it("removes the file when a service is disconnected", async () => {
    const botId = "bot_sweep" as BotId
    const dir = seedBot(botId)

    await regenerate(botId, [spec(), spec({ name: "github", url: "https://api.github.com/mcp" })])
    expect(listConnections(dir)).toEqual(["github.ts", "linear.ts"])

    await regenerate(botId, [spec({ name: "github", url: "https://api.github.com/mcp" })])

    // The direction that matters: a revoked integration that keeps working is
    // the worst way for this to fail.
    expect(listConnections(dir)).toEqual(["github.ts"])
  })

  it("leaves a hand-authored connection alone", async () => {
    const botId = "bot_handwritten" as BotId
    const dir = seedBot(botId)
    mkdirSync(connectionsDir(dir), { recursive: true })
    const mine = join(connectionsDir(dir), "mine.ts")
    const authored = "// mine\nexport default {};\n"
    writeFileSync(mine, authored, "utf8")

    await regenerate(botId, [spec()])

    // Evie owns the files it wrote, identified by its marker -- not the
    // directory. Eating someone's authored connection is not a sweep.
    expect(readFileSync(mine, "utf8")).toBe(authored)
    expect(listConnections(dir)).toEqual(["linear.ts", "mine.ts"])
  })

  it("is idempotent, because every spawn runs it", async () => {
    const botId = "bot_twice" as BotId
    const dir = seedBot(botId)

    await regenerate(botId, [spec()])
    const first = readFileSync(join(connectionsDir(dir), "linear.ts"), "utf8")
    await regenerate(botId, [spec()])

    expect(readFileSync(join(connectionsDir(dir), "linear.ts"), "utf8")).toBe(first)
  })
})

describe("the environment variable name", () => {
  it("is a legal POSIX identifier whatever the connection is called", () => {
    // Connection names come from a catalog and from people. `grant:<id>` is
    // deliberately not injectable (see `injectable`), so this is the only name
    // a credential travels under -- it has to survive punctuation.
    expect(connectionEnvName("google-calendar")).toBe("EVIE_CONN_GOOGLE_CALENDAR")
    expect(connectionEnvName("my api v2")).toBe("EVIE_CONN_MY_API_V2")
    for (const name of ["linear", "google-calendar", "my api v2", "a.b.c"]) {
      expect(connectionEnvName(name)).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/)
    }
  })
})
