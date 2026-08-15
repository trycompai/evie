import { randomBytes } from "node:crypto"
import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { BotHealth } from "@evie/contracts/bot"
import { RuntimeUnavailable } from "@evie/contracts/errors"
import type { BotId } from "@evie/contracts/ids"
import {
  Cause,
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  FiberMap,
  Layer,
  Option,
  RcMap,
  Redacted,
  Ref,
  Schedule,
  Scope,
  Stream,
} from "effect"
import { HttpClient } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { EvieConfig } from "../config.ts"
import type { Actor } from "../domain/state.ts"
import { Secrets } from "../secrets/Secrets.ts"
import { mintTurnToken } from "./jwt.ts"

/**
 * eve runtime lifecycle: one process per ACTIVE bot, lazily started, idle-
 * stopped, crash-restarted with capped backoff (02, "Supervision").
 *
 * The runtime map is an `RcMap`: `acquire` joins concurrent callers to the
 * same in-flight start instead of locking around a spawn, holds the runtime
 * alive through each caller's scope, and releases it `idleStopMinutes` after
 * the last scope closes. Idle stop is safe by eve's contract -- workflow state
 * persists under the bot's `.eve/` and sandboxes reattach on the next turn.
 *
 * PID discipline (AGENTS.md rule 1, the most important lines in this file):
 * every child is spawned inside a scope whose finalizer kills the process
 * group, the monitor fiber is held in a `FiberMap` keyed by bot id, and
 * teardown is always by scope. We never discover a PID by matching a name, a
 * path, or a worktree string -- our own agent process has this worktree's path
 * in its argv.
 */

export interface RuntimeConnection {
  /** `http://127.0.0.1:<ephemeral>`. Never logged, never written to disk. */
  readonly baseUrl: string
  /** Signs with this spawn's `EVIE_RUNTIME_SECRET`; the secret never leaves this closure. */
  readonly mintToken: (actor: Actor) => string
}

export interface EveRuntime {
  readonly botId: BotId
  /**
   * The current connection. Waits through an in-flight (re)start; fails with
   * `RuntimeUnavailable` once the bot is marked unhealthy.
   */
  readonly connection: Effect.Effect<RuntimeConnection, RuntimeUnavailable>
}

export interface SupervisorShape {
  /**
   * A ready runtime, starting one if needed. Held through the caller's scope:
   * dispatch holds it briefly, ingestion for as long as it is attached, and
   * the idle-stop clock starts when the last holder lets go.
   */
  readonly acquire: (botId: BotId) => Effect.Effect<EveRuntime, RuntimeUnavailable, Scope.Scope>
  /** What the supervisor last observed. The UI's bot-level health chip. */
  readonly health: (botId: BotId) => Effect.Effect<BotHealth>
  /** Drops a cached runtime (or a cached failed start) so the next acquire starts fresh. */
  readonly invalidate: (botId: BotId) => Effect.Effect<void>
}

/** Failed starts stop retrying here rather than spinning behind a spinner. */
const MAX_CONSECUTIVE_START_FAILURES = 3
const STDERR_TAIL_LINES = 50
const INITIAL_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 30_000

class StartError extends Data.TaggedError("StartError")<{
  readonly reason: string
  readonly stderr: ReadonlyArray<string>
}> {}

type SlotState =
  | {
      readonly _tag: "starting"
      readonly waiting: Deferred.Deferred<RuntimeConnection, RuntimeUnavailable>
    }
  | { readonly _tag: "ready"; readonly conn: RuntimeConnection }
  | { readonly _tag: "unhealthy"; readonly error: RuntimeUnavailable }

/** The ephemeral port must never end up in a persisted stderr tail. */
const redactPorts = (line: string): string =>
  line.replace(/(127\.0\.0\.1|localhost|\[::1\]):\d+/g, "$1:<port>")

const portPattern = /(?:127\.0\.0\.1|localhost):(\d{1,5})/

/**
 * The child's explicit environment, and the one place every precedence rule
 * about it is written down. `stored` is `[name, value]` in scope order and
 * later wins, so `storedSecrets` listing org before bot is what makes a
 * bot-scoped key override the org's.
 *
 * Evie's own three vars are written last, so a stored secret named
 * `EVIE_RUNTIME_SECRET` cannot shadow the one this spawn authenticates with.
 *
 * Against the operator's own shell, `extendEnv: true` decides it: the spawner
 * merges this object over `process.env`, so a stored secret beats an exported
 * one and a name nobody stored falls straight through to whatever the operator
 * exported. **Stored wins, deliberately.** It is the only half of the pair the
 * product can see -- `SetSecret` answers with a hint and `configured: true`,
 * and a control that reports it took a key while an invisible shell export
 * keeps serving the old one is worse than no control at all. Rotation is the
 * same argument with a sharper edge: rotate in the app, restart the runtime,
 * and an inherited value that won would keep a revoked key alive. Note this
 * runs the opposite way to `EvieConfig`, where the environment beats
 * `settings.json` -- there the operator is configuring their own process, here
 * the org holds a credential that members and remote clients with no shell on
 * this box are expected to manage.
 */
export const spawnEnv = (
  botId: BotId,
  runtimeSecret: string,
  allowedHosts: ReadonlyArray<string>,
  stored: ReadonlyArray<readonly [name: string, value: Redacted.Redacted<string>]>,
): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [name, value] of stored) {
    if (!injectable(name)) continue
    env[name] = Redacted.value(value)
  }
  env.EVIE_BOT_ID = botId
  env.EVIE_RUNTIME_SECRET = runtimeSecret
  env.EVIE_ALLOWED_HOSTS = JSON.stringify(allowedHosts)
  return env
}

/**
 * Names that would change how the child runs rather than what it can reach.
 *
 * `NODE_OPTIONS` is arbitrary code execution in the eve process; `PATH` is a
 * bot that will not start, with an error nobody could trace back to a settings
 * box; the loader variables are the same trick as `NODE_OPTIONS` one layer
 * down. These are not a threat model -- `secret:manage` is admin-and-above --
 * they are a footgun. A credential store should not be able to reconfigure the
 * process it is feeding.
 */
const RESERVED = new Set([
  "PATH",
  "HOME",
  "SHELL",
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
])

/** POSIX environment identifier. Anything else cannot be read as `$NAME` anyway. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Whether a stored secret's name may become an environment variable.
 *
 * The shape test is load-bearing beyond tidiness: connection grants are stored
 * in the org scope under `grant:<connectionId>` (`gateway/handlers.ts`), and
 * without this every one of them would land in every runtime's environment
 * under a name no generated connection reads -- a credential readable from
 * inside the sandbox with `env`, in exchange for nothing. Grants reach eve
 * through the per-turn JWT principal instead, which is what that principal is
 * for.
 */
const injectable = (name: string): boolean => ENV_NAME.test(name) && !RESERVED.has(name)

/**
 * Secret refs sorted so that a later scope's entry overwrites an earlier one.
 *
 * `spawnEnv` resolves precedence by assignment order, so this is where "bot
 * beats org" is actually decided -- and it cannot be left to the query, whose
 * `order by scope, name` sorts `bot:` *before* `org:`, which is the inverse of
 * what is wanted. Pure and exported precisely because the alternative is a
 * nested loop nothing can test: swap it for a plain `refs.map(...)` and org
 * silently wins with every other assertion still green.
 */
export const inScopeOrder = <S extends string>(
  scopes: ReadonlyArray<S>,
  refs: ReadonlyArray<{ readonly scope: string; readonly name: string }>,
): ReadonlyArray<{ readonly scope: S; readonly name: string }> =>
  scopes.flatMap((scope) =>
    // Pairs each name with the scope literal it matched, so the caller keeps
    // the narrow `SecretScope` the read needs rather than the row's bare string.
    refs.filter((ref) => ref.scope === scope).map((ref) => ({ scope, name: ref.name })),
  )

/**
 * Where `eve dev` advertises a running dev server for a project.
 *
 * A second `eve dev` in the same directory adopts whatever this names instead
 * of starting its own -- which is exactly right for a person running eve twice,
 * and exactly wrong for us. The adopted server belongs to a previous Evie
 * process and was spawned with that process's `EVIE_RUNTIME_SECRET`, so every
 * request we make to it comes back **401** and the bot goes silent with no
 * explanation. Any restart that does not cleanly stop its children -- a crash,
 * a SIGKILL, `tsx watch` reloading -- leaves one of these behind.
 */
const DEV_SERVER_STATE = join(".eve", "dev-server-state.v1.json")

/**
 * Drops a dev server this process did not start, so the spawn below gets a
 * fresh one holding a secret we know.
 *
 * Only the pointer file is removed. Killing the old process would mean finding
 * it by port and matching it against a directory, and a stale runtime that
 * nobody dials is a leak rather than a fault -- the idle-stop reaper and the
 * next restart both collect it. Removing the pointer is what breaks the
 * adoption, which is the part that produces the 401.
 */
const disownStaleRuntime = (dir: string) =>
  Effect.sync(() => {
    const pointer = join(dir, DEV_SERVER_STATE)
    if (!existsSync(pointer)) return
    rmSync(pointer, { force: true })
  }).pipe(
    Effect.tap(() =>
      Effect.logDebug("Supervisor: cleared any inherited eve dev server", { dir }),
    ),
  )

const make = Effect.gen(function* () {
  const config = yield* EvieConfig
  const sql = yield* SqlClient.SqlClient
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const httpClient = yield* HttpClient.HttpClient
  const secrets = yield* Secrets
  const fibers = yield* FiberMap.make<BotId>()
  const healthMap = new Map<string, BotHealth>()

  const setHealth = (botId: BotId, health: BotHealth) =>
    Effect.sync(() => {
      healthMap.set(botId, health)
    })

  /**
   * Every secret this bot's runtime may hold, as `spawnEnv` entries in scope
   * order: org first, then bot, so a bot-scoped key overrides the org's.
   *
   * `user:` scopes are deliberately absent. One runtime serves every member's
   * turns, so a personal credential in its environment is a personal credential
   * in everybody's turns -- the one thing 05 "Secrets" promises never happens.
   * Member-scoped credentials reach eve through the principal in the per-turn
   * JWT instead, which is what that principal is for.
   */
  const storedSecrets = Effect.fn("Supervisor.secrets")(function* (orgId: string, botId: BotId) {
    const scopes = [`org:${orgId}`, `bot:${botId}`] as const
    const refs = yield* secrets.list(scopes)
    const entries: Array<readonly [string, Redacted.Redacted<string>]> = []
    for (const { scope, name } of inScopeOrder(scopes, refs)) {
      {
        const value = yield* secrets.valueForSpawn(scope, name).pipe(
          // Removed between the list and the read. Skipping is right: a spawn
          // should not fail over a secret that no longer exists.
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        )
        if (value !== undefined) entries.push([name, value] as const)
      }
    }
    return entries
  })

  /**
   * One spawn attempt inside the caller-provided scope: fresh secret, fresh
   * ephemeral port, ready only after the health route answers. The scope's
   * finalizer kills the process group, so failure cleanup is closing a scope.
   */
  const spawnRuntime = Effect.fn("Supervisor.spawn")(function* (
    botId: BotId,
    orgId: string,
    dir: string,
    allowedHosts: ReadonlyArray<string>,
  ) {
    yield* disownStaleRuntime(dir)

    const eveBin = join(dir, "node_modules", ".bin", "eve")
    if (!existsSync(eveBin)) {
      return yield* new StartError({
        reason: "eve is not installed in the bot directory -- re-create the bot project",
        stderr: [],
      })
    }
    // Fresh per spawn: a leaked token dies with the process it was minted for.
    const secret = randomBytes(32).toString("base64url")
    const stderrTail: Array<string> = []
    const tail = () => [...stderrTail]
    const pushTail = (line: string) => {
      stderrTail.push(redactPorts(line))
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift()
    }

    // A store we cannot read fails the start, because the alternative is a bot
    // that answers "no credentials" with nothing anywhere saying why. The
    // reason never carries a value -- the query binds scope and name only.
    const stored = yield* storedSecrets(orgId, botId).pipe(
      Effect.mapError(
        (error) =>
          new StartError({ reason: `the secret store could not be read: ${String(error)}`, stderr: [] }),
      ),
    )
    if (stored.length > 0) {
      // Names only, and they are already in every client's read model. The
      // failure this exists for is silent by nature -- a key that was stored,
      // looked configured, and never arrived.
      yield* Effect.logDebug("Supervisor.spawn: injecting stored secrets", {
        botId,
        names: stored.map(([name]) => name),
      })
    }

    // Always `eve dev` for now (decision 012's local mode); `runtime_mode =
    // 'built'` (eve build + eve start) is a later phase of 06-roadmap.
    const handle = yield* spawner.spawn(
      ChildProcess.make(eveBin, ["dev", "--no-ui", "--host", "127.0.0.1", "--port", "0"], {
        cwd: dir,
        env: spawnEnv(botId, secret, allowedHosts, stored),
        extendEnv: true,
        killSignal: "SIGTERM",
        forceKillAfter: "5 seconds",
      }),
    )

    // The OS picked the port; the only place it appears is the child's own
    // startup line. Scan for it, never log it.
    const port = yield* Deferred.make<number>()
    const scan = (stream: typeof handle.stdout, isStderr: boolean) =>
      Stream.decodeText(stream).pipe(
        Stream.splitLines,
        Stream.runForEach((line) => {
          if (isStderr) pushTail(line)
          const match = portPattern.exec(line)
          return match ? Deferred.succeed(port, Number(match[1])) : Effect.void
        }),
        Effect.ignore,
      )
    yield* Effect.forkScoped(scan(handle.stdout, false))
    yield* Effect.forkScoped(scan(handle.stderr, true))

    const exitedEarly = handle.exitCode.pipe(
      Effect.flatMap((code) =>
        Effect.fail(
          new StartError({ reason: `eve exited with code ${code} before it was ready`, stderr: tail() }),
        ),
      ),
    )
    const boundPort = yield* Deferred.await(port).pipe(
      Effect.raceFirst(exitedEarly),
      Effect.timeout("30 seconds"),
      Effect.mapError((error) =>
        error instanceof StartError
          ? error
          : new StartError({ reason: `eve did not report an address: ${String(error)}`, stderr: tail() }),
      ),
    )
    const baseUrl = `http://127.0.0.1:${boundPort}`

    // /eve/v1/health is the one public route; readiness gate, nothing more.
    yield* httpClient.get(`${baseUrl}/eve/v1/health`).pipe(
      Effect.flatMap((response) =>
        response.status === 200
          ? Effect.void
          : Effect.fail(new StartError({ reason: `health returned ${response.status}`, stderr: tail() })),
      ),
      Effect.timeout("2 seconds"),
      Effect.retry({
        schedule: Schedule.exponential("100 millis").pipe(
          Schedule.jittered,
          Schedule.upTo({ duration: "30 seconds" }),
        ),
      }),
      Effect.mapError((error) =>
        error instanceof StartError
          ? error
          : new StartError({
              reason: `eve never became healthy: ${String(error)}`,
              stderr: tail(),
            }),
      ),
    )

    return { handle, baseUrl, secret, tail }
  })

  /**
   * Owns one bot's runtime for the life of its RcMap entry: start, watch,
   * restart with capped exponential backoff, give up after three consecutive
   * failed starts. Runs as a fiber in the entry's scope, so idle stop and
   * shutdown are both just scope closure.
   */
  const supervise = (
    botId: BotId,
    orgId: string,
    dir: string,
    allowedHosts: ReadonlyArray<string>,
    stateRef: Ref.Ref<SlotState>,
  ) =>
    Effect.gen(function* () {
      const toStarting = Effect.gen(function* () {
        const state = yield* Ref.get(stateRef)
        if (state._tag === "starting") return state.waiting
        const waiting = yield* Deferred.make<RuntimeConnection, RuntimeUnavailable>()
        yield* Ref.set(stateRef, { _tag: "starting", waiting })
        return waiting
      })

      let consecutiveFailures = 0
      let backoffMs = INITIAL_BACKOFF_MS
      const sleepBackoff = Effect.suspend(() => {
        const jittered = backoffMs / 2 + Math.random() * backoffMs
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
        return Effect.sleep(Duration.millis(jittered))
      })

      while (true) {
        const waiting = yield* toStarting
        const childScope = yield* Scope.make()
        // Everything below runs with the child's own scope, and `ensuring`
        // closes it on every path -- crash, failed start, idle stop,
        // shutdown. Scope closure kills the process group. Rule 1.
        const outcome = yield* Effect.gen(function* () {
          const started = yield* Effect.exit(
            spawnRuntime(botId, orgId, dir, allowedHosts).pipe(Scope.provide(childScope)),
          )
          if (Exit.isFailure(started)) return { _tag: "startFailed" as const, exit: started }

          const runtime = started.value
          consecutiveFailures = 0
          backoffMs = INITIAL_BACKOFF_MS
          const conn: RuntimeConnection = {
            baseUrl: runtime.baseUrl,
            mintToken: (actor) => mintTurnToken({ botId, secret: runtime.secret, actor }),
          }
          yield* Deferred.succeed(waiting, conn)
          yield* Ref.set(stateRef, { _tag: "ready", conn })
          yield* setHealth(botId, { kind: "ready" })

          // Park until the child exits. A deliberate stop interrupts this
          // fiber instead, so reaching past this line means a crash.
          yield* Effect.exit(runtime.handle.exitCode)
          return { _tag: "crashed" as const, stderr: runtime.tail() }
        }).pipe(Effect.ensuring(Scope.close(childScope, Exit.void)))

        if (outcome._tag === "crashed") {
          yield* setHealth(botId, { kind: "restarting", attempt: 1 })
          yield* sleepBackoff
          continue
        }

        consecutiveFailures += 1
        const failure = Exit.isFailure(outcome.exit)
          ? Option.getOrUndefined(Cause.findErrorOption(outcome.exit.cause))
          : undefined
        if (consecutiveFailures >= MAX_CONSECUTIVE_START_FAILURES) {
          const error = new RuntimeUnavailable({
            botId,
            reason:
              failure instanceof StartError
                ? failure.reason
                : failure === undefined
                  ? "eve failed to start"
                  : String(failure),
            stderr: failure instanceof StartError ? failure.stderr : [],
          })
          yield* Deferred.fail(waiting, error)
          yield* Ref.set(stateRef, { _tag: "unhealthy", error })
          yield* setHealth(botId, {
            kind: "unhealthy",
            reason: error.reason,
            stderr: error.stderr ?? [],
          })
          return
        }
        yield* setHealth(botId, { kind: "restarting", attempt: consecutiveFailures })
        yield* sleepBackoff
      }
    }).pipe(
      // A supervisor that is gone must not leave a stale "ready" chip behind.
      Effect.ensuring(
        Effect.sync(() => {
          const health = healthMap.get(botId)
          if (health === undefined || health.kind !== "unhealthy") {
            healthMap.set(botId, { kind: "idle" })
          }
        }),
      ),
    )

  const runtimes = yield* RcMap.make({
    idleTimeToLive: Duration.minutes(config.idleStopMinutes),
    lookup: Effect.fn("Supervisor.start")(function* (botId: BotId) {
      const rows = yield* sql<{ dir: string; sandbox: string; org_id: string }>`
        select dir, sandbox, org_id from bot where id = ${botId} and archived_at is null`.pipe(
        Effect.mapError(
          (error) => new RuntimeUnavailable({ botId, reason: `bot lookup failed: ${String(error)}` }),
        ),
      )
      const row = rows[0]
      if (row === undefined) {
        return yield* new RuntimeUnavailable({ botId, reason: "no such bot, or it is archived" })
      }
      const allowedHosts = allowedHostsOf(row.sandbox)

      yield* setHealth(botId, { kind: "starting" })
      const waiting = yield* Deferred.make<RuntimeConnection, RuntimeUnavailable>()
      const stateRef = yield* Ref.make<SlotState>({ _tag: "starting", waiting })

      // Forked into the RcMap entry's scope (idle stop / shutdown interrupts
      // it) AND registered in the FiberMap keyed by bot id, so process
      // teardown interrupts every supervisor it still owns. Rule 1: teardown
      // is by scope, never by hunting for a PID.
      const fiber = yield* Effect.forkScoped(
        supervise(botId, row.org_id, row.dir, allowedHosts, stateRef),
      )
      yield* FiberMap.set(fibers, botId, fiber)

      const connection: EveRuntime["connection"] = Ref.get(stateRef).pipe(
        Effect.flatMap((state) =>
          state._tag === "ready"
            ? Effect.succeed(state.conn)
            : state._tag === "unhealthy"
              ? Effect.fail(state.error)
              : Deferred.await(state.waiting),
        ),
      )

      // acquire resolves only once the first start settled, so callers never
      // dispatch into a runtime that was never there.
      yield* connection
      return { botId, connection } satisfies EveRuntime
    }),
  })

  const shape: SupervisorShape = {
    /**
     * A failed start is not a durable answer.
     *
     * The `RcMap` caches a lookup's outcome, failures included, which is right
     * for a runtime and wrong for the reason one could not be started. Those
     * reasons expire: the commonest is a bot whose `npm install` has not
     * finished, and "eve is not installed in the bot directory" stops being
     * true a few seconds later. Cached, it never stopped being true -- the
     * entry answered instantly and identically for the rest of the process, so
     * a bot that lost one race at creation was mute until the server
     * restarted, and every message to it was dropped with a log line.
     *
     * Dropping the entry on failure costs a fresh spawn attempt the next time
     * someone asks. Someone asking is exactly when it should be tried again:
     * `supervise` already refuses to spin on its own (three strikes, then
     * unhealthy), and this does not touch that -- it only stops a stale "no"
     * from outliving the thing that caused it.
     */
    acquire: (botId) =>
      RcMap.get(runtimes, botId).pipe(
        Effect.tapError(() =>
          RcMap.invalidate(runtimes, botId).pipe(
            Effect.andThen(FiberMap.remove(fibers, botId)),
            Effect.andThen(Effect.logDebug("Supervisor: dropped a failed start so the next try is fresh", { botId })),
          ),
        ),
      ),
    health: (botId) => Effect.sync(() => healthMap.get(botId) ?? { kind: "idle" }),
    invalidate: (botId) =>
      Effect.gen(function* () {
        yield* RcMap.invalidate(runtimes, botId)
        yield* FiberMap.remove(fibers, botId)
      }),
  }
  return shape
})

/** The bot row's sandbox config carries the allow-list the spawn env injects. */
const allowedHostsOf = (sandboxJson: string): ReadonlyArray<string> => {
  try {
    const parsed: unknown = JSON.parse(sandboxJson)
    if (typeof parsed !== "object" || parsed === null) return []
    const network = (parsed as Record<string, unknown>).network
    if (typeof network !== "object" || network === null) return []
    const allow = (network as Record<string, unknown>).allow
    return Array.isArray(allow) ? allow.filter((host): host is string => typeof host === "string") : []
  } catch {
    return []
  }
}

export class Supervisor extends Context.Service<Supervisor, SupervisorShape>()("Supervisor") {
  /**
   * Needs `EvieConfig`, `Db` (for `SqlClient`), `Secrets` (the spawn env's
   * stored half), a `ChildProcessSpawner`, and an `HttpClient`.
   */
  static readonly layer = Layer.effect(Supervisor, make)
}
