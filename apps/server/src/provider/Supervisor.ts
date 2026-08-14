import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
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

const make = Effect.gen(function* () {
  const config = yield* EvieConfig
  const sql = yield* SqlClient.SqlClient
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const httpClient = yield* HttpClient.HttpClient
  const fibers = yield* FiberMap.make<BotId>()
  const healthMap = new Map<string, BotHealth>()

  const setHealth = (botId: BotId, health: BotHealth) =>
    Effect.sync(() => {
      healthMap.set(botId, health)
    })

  /**
   * One spawn attempt inside the caller-provided scope: fresh secret, fresh
   * ephemeral port, ready only after the health route answers. The scope's
   * finalizer kills the process group, so failure cleanup is closing a scope.
   */
  const spawnRuntime = Effect.fn("Supervisor.spawn")(function* (
    botId: BotId,
    dir: string,
    allowedHosts: ReadonlyArray<string>,
  ) {
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

    // Always `eve dev` for now (decision 012's local mode); `runtime_mode =
    // 'built'` (eve build + eve start) is a later phase of 06-roadmap.
    const handle = yield* spawner.spawn(
      ChildProcess.make(eveBin, ["dev", "--no-ui", "--host", "127.0.0.1", "--port", "0"], {
        cwd: dir,
        env: {
          EVIE_BOT_ID: botId,
          EVIE_RUNTIME_SECRET: secret,
          EVIE_ALLOWED_HOSTS: JSON.stringify(allowedHosts),
        },
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
            spawnRuntime(botId, dir, allowedHosts).pipe(Scope.provide(childScope)),
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
      const rows = yield* sql<{ dir: string; sandbox: string }>`
        select dir, sandbox from bot where id = ${botId} and archived_at is null`.pipe(
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
      const fiber = yield* Effect.forkScoped(supervise(botId, row.dir, allowedHosts, stateRef))
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
    acquire: (botId) => RcMap.get(runtimes, botId),
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
  /** Needs `EvieConfig`, `Db` (for `SqlClient`), a `ChildProcessSpawner`, and an `HttpClient`. */
  static readonly layer = Layer.effect(Supervisor, make)
}
