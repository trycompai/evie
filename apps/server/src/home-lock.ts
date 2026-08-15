import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { EvieConfig } from "./config.ts"

/**
 * One server per Evie home.
 *
 * Decision 015 says exactly one SQLite writer per process, and this is the
 * other half of it: two servers pointed at the same home are two writers, two
 * projectors, and — the part that actually bites — two supervisors spawning
 * `eve dev` in the same bot directory. eve's dev server dedupes to a single
 * runtime, which belongs to whichever server started it and carries that
 * server's `EVIE_RUNTIME_SECRET`. The other one then gets **401 on every turn,
 * forever**, and retries look like a session problem rather than what they are.
 *
 * That is not hypothetical: `turbo dev` starting the standalone server while
 * the desktop app was running produced precisely this, and the symptom was a
 * bot that had answered a minute earlier going permanently silent.
 *
 * A pid in a file, not an advisory lock: it survives a hard kill in a form the
 * next boot can reason about, and it is readable by a human debugging exactly
 * this. A lock whose owner is gone is stale and taken over silently — crashing
 * should not require a manual cleanup step.
 *
 * The file doubles as **discovery**. It carries the server's URL and its
 * launcher token, so a launcher that finds a home already served can attach to
 * it rather than refuse or, worse, start a rival. Mutual exclusion and "who is
 * already here" are the same question, and answering both from one file means
 * they cannot disagree. It is 0600: the token in it mints a session, which is
 * the same authority as read access to the database beside it.
 */

const LOCK = "evie.lock"

/** What a running server publishes about itself for a launcher to find. */
export interface ServerClaim {
  readonly pid: number
  readonly url: string
  /** Bearer for `POST /internal/launcher/claim`. Loopback and local mode only. */
  readonly launcherToken: string
}

/**
 * Reads the claim of the server currently serving this home, if any.
 *
 * Returns null for an absent file, an unreadable one, or a holder that has
 * exited -- all of which mean the same thing to a caller: nobody is here.
 */
export const readServerClaim = (userdata: string): ServerClaim | null => {
  try {
    const raw = JSON.parse(readFileSync(join(userdata, LOCK), "utf8")) as Partial<ServerClaim>
    if (typeof raw.pid !== "number" || !alive(raw.pid)) return null
    if (typeof raw.url !== "string" || typeof raw.launcherToken !== "string") return null
    return { pid: raw.pid, url: raw.url, launcherToken: raw.launcherToken }
  } catch {
    return null
  }
}

const alive = (pid: number): boolean => {
  try {
    // Signal 0 tests for existence and permission without delivering anything.
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means it exists and belongs to someone else, which still counts.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export class HomeInUse extends Error {
  constructor(
    readonly home: string,
    readonly pid: number,
  ) {
    super(
      `Another Evie server (pid ${pid}) is already using ${home}.\n` +
        `Two servers on one home fight over the same bot runtimes and the loser gets 401 on every turn.\n` +
        `Stop that one, or set EVIE_HOME to a different directory for this server.`,
    )
    this.name = "HomeInUse"
  }
}

/**
 * Acquired before anything opens the database, released when the layer scope
 * closes. Throws rather than fails: a second server on one home is a defect in
 * how the process was started, and nothing downstream may run after it.
 */
/**
 * The token the launcher route checks.
 *
 * Taken from the environment when a launcher passed one down at spawn, and
 * generated otherwise so that a hand-started server is still attachable -- that
 * is what lets `turbo dev`'s server be adopted by the desktop app. Generating
 * it does not widen anything: the route is still loopback-only, local-mode-only,
 * and gated on a secret that only something able to read `userdata` can see.
 */
const launcherToken = (): string => {
  const provided = process.env["EVIE_LAUNCHER_TOKEN"]
  if (provided !== undefined && provided.length > 0) return provided
  const minted = randomBytes(32).toString("base64url")
  process.env["EVIE_LAUNCHER_TOKEN"] = minted
  return minted
}

export const HomeLockLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* EvieConfig
    const path = join(config.home.userdata, LOCK)

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        // Runs before `Db.make`, which is what normally creates these.
        mkdirSync(config.home.userdata, { recursive: true })
        const held = readServerClaim(config.home.userdata)
        if (held !== null && held.pid !== process.pid) {
          throw new HomeInUse(config.home.root, held.pid)
        }
        const claim: ServerClaim = {
          pid: process.pid,
          url: `http://127.0.0.1:${config.port}`,
          launcherToken: launcherToken(),
        }
        writeFileSync(path, JSON.stringify(claim), { encoding: "utf8", mode: 0o600 })
        return path
      }),
      (held) =>
        Effect.sync(() => {
          // Only ever remove our own claim; a takeover must not delete the
          // lock a newer server has since written.
          try {
            const current = JSON.parse(readFileSync(held, "utf8")) as { pid?: number }
            if (current.pid === process.pid) rmSync(held, { force: true })
          } catch {
            /* already gone */
          }
        }),
    )
  }),
)
