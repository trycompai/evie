import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { afterAll, describe, expect, it } from "vitest"
import { resolveHome } from "@evie/shared/home"
import { EvieConfig } from "../src/config.ts"
import { HomeInUse, HomeLockLive, readServerClaim } from "../src/home-lock.ts"

/**
 * One server per Evie home.
 *
 * The failure this prevents is nasty precisely because it does not look like a
 * locking problem: two servers sharing a home both spawn `eve dev` in the same
 * bot directory, eve dedupes to one runtime, and the server that did not start
 * it gets 401 on every turn — forever, and only for *some* of the bots. It
 * presents as "the bot stopped answering", which is a long way from "you are
 * running two servers".
 *
 * Both halves matter and pull against each other: refusing a live holder is the
 * point, and taking over a dead one is what stops a crash from requiring manual
 * cleanup before the app will start again.
 *
 * The same file is how a launcher *finds* a running server, so a desktop app
 * started beside `turbo dev` can attach instead of starting a rival. That is
 * why the claim carries a URL and a token, and why a stale claim must read as
 * "nobody is here" rather than as a server to dial.
 *
 * Temp directory, never `~/.evie` — see rule 2 in AGENTS.md.
 */

const root = mkdtempSync(join(tmpdir(), "evie-home-lock-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const configFor = (home: string) =>
  Layer.succeed(EvieConfig, {
    home: resolveHome({ EVIE_HOME: home } as NodeJS.ProcessEnv),
    bind: "127.0.0.1",
    port: 0,
    mode: "local" as const,
    idleStopMinutes: 10,
    flags: { persistReasoning: false },
  })

/** Builds the lock layer inside a scope and runs `body` while it is held. */
const holding = <A>(home: string, body: Effect.Effect<A>) =>
  Effect.runPromise(
    Effect.scoped(
      Layer.build(HomeLockLive.pipe(Layer.provide(configFor(home)))).pipe(Effect.andThen(body)),
    ) as Effect.Effect<A>,
  )

const lockPath = (home: string) => join(home, "userdata", "evie.lock")

describe("the Evie home lock", () => {
  it("publishes a claim and removes it on release", async () => {
    const home = join(root, "clean")
    const during = await holding(home, Effect.sync(() => readFileSync(lockPath(home), "utf8")))
    const claim = JSON.parse(during) as { pid: number; url: string; launcherToken: string }
    expect(claim.pid).toBe(process.pid)
    expect(claim.url).toMatch(/^http:\/\/127\.0\.0\.1:/)
    // A launcher attaching needs this to mint a session without a restart.
    expect(claim.launcherToken.length).toBeGreaterThan(20)
    // The scope has closed by now.
    expect(() => readFileSync(lockPath(home), "utf8")).toThrow()
  })

  it("is readable as a claim while held, and not after", async () => {
    const home = join(root, "discovery")
    const during = await holding(
      home,
      Effect.sync(() => readServerClaim(join(home, "userdata"))),
    )
    expect(during?.pid).toBe(process.pid)
    expect(readServerClaim(join(home, "userdata"))).toBeNull()
  })

  it("refuses a home a live server already holds", async () => {
    const home = join(root, "contended")
    mkdirSync(join(home, "userdata"), { recursive: true })
    // A pid that is definitely alive and is not us: our own parent.
    writeFileSync(
      lockPath(home),
      JSON.stringify({ pid: process.ppid, url: "http://127.0.0.1:3773", launcherToken: "x".repeat(32) }),
      "utf8",
    )

    await expect(holding(home, Effect.void)).rejects.toThrow(HomeInUse)
  })

  /*
   * A crash leaves the file behind. Requiring a human to delete it before the
   * app will start is the kind of papercut that turns one bad shutdown into a
   * support thread.
   */
  it("takes over a lock whose owner is gone", async () => {
    const home = join(root, "stale")
    mkdirSync(join(home, "userdata"), { recursive: true })
    // Above the pid_max on any platform we run on, so it cannot be alive.
    writeFileSync(
      lockPath(home),
      JSON.stringify({ pid: 9_999_999, url: "http://127.0.0.1:3773", launcherToken: "x".repeat(32) }),
      "utf8",
    )
    // A dead holder must not be offered to a launcher as somewhere to attach.
    expect(readServerClaim(join(home, "userdata"))).toBeNull()

    const during = await holding(
      home,
      Effect.sync(() => readServerClaim(join(home, "userdata"))),
    )
    expect(during?.pid).toBe(process.pid)
  })

  it("takes over a file that is not a claim at all", async () => {
    const home = join(root, "garbage")
    mkdirSync(join(home, "userdata"), { recursive: true })
    writeFileSync(lockPath(home), "not json at all\n", "utf8")
    expect(readServerClaim(join(home, "userdata"))).toBeNull()

    const during = await holding(
      home,
      Effect.sync(() => readServerClaim(join(home, "userdata"))),
    )
    expect(during?.pid).toBe(process.pid)
  })

  it("names the holder, because the symptom points nowhere near the cause", async () => {
    const home = join(root, "message")
    mkdirSync(join(home, "userdata"), { recursive: true })
    writeFileSync(
      lockPath(home),
      JSON.stringify({ pid: process.ppid, url: "http://127.0.0.1:3773", launcherToken: "x".repeat(32) }),
      "utf8",
    )

    await expect(holding(home, Effect.void)).rejects.toThrow(
      new RegExp(`pid ${process.ppid}\\b`),
    )
  })
})
