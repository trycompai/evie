import type { RuntimeUnavailable } from "@evie/contracts/errors"
import {
  BotProvisioned,
  BotProvisionFailed,
  RuntimeReady,
  RuntimeStopped,
  type StoredEvent,
} from "@evie/contracts/events"
import type { BotId, ThreadId } from "@evie/contracts/ids"
import { Context, Effect, FiberMap, Layer, Result } from "effect"
import type { SqlError } from "effect/unstable/sql/SqlError"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { EvieConfig } from "../config.ts"
import { Hub } from "../gateway/hub.ts"
import { Scaffold } from "../provider/scaffold.ts"
import { EventStore } from "../store/EventStore.ts"
import { deriveUlid, ReactorWake, reactorLayer, type Commit } from "./runtime.ts"

/**
 * SupervisorReactor: bot activity warms an eve runtime, the idle timer stops
 * one. `RuntimeReady` lands when an acquire actually started a runtime;
 * `RuntimeStopped` when the idle window elapsed with no active turn and no
 * attached client.
 *
 * It also owns **provisioning**: writing a new bot's eve project and running
 * `npm install` in it. That is slow -- minutes on a cold cache -- and it lived
 * in the projector once, which meant the bot row did not exist until the
 * install finished. Here it runs behind the bot's health chip, which is what a
 * health chip is for.
 *
 * Replayed events never warm anything: runtimes do not survive a restart, so
 * activity older than this reactor's start time is history, not demand. The
 * cursor advances over it silently. Provisioning is the one exception -- see
 * `handle`.
 */

/**
 * The narrow slice of the provider `Supervisor` this reactor needs, defined
 * here because that service is being written concurrently. `acquire` must be
 * lazy and joining: return the running runtime when there is one, start one
 * otherwise, and join concurrent callers to the same start. `fresh` is true
 * only when this call started the runtime -- that is what gates the
 * `RuntimeReady` receipt to one per actual start.
 */
export interface RuntimeControlShape {
  readonly acquire: (
    botId: BotId,
  ) => Effect.Effect<{ readonly port: number; readonly fresh: boolean }, RuntimeUnavailable>
  /** `reload` is a config change the running process cannot see; acquire is lazy, so stopping is the fix. */
  readonly stop: (botId: BotId, reason: "idle" | "shutdown" | "reload") => Effect.Effect<void>
}

export class RuntimeControl extends Context.Service<RuntimeControl, RuntimeControlShape>()(
  "provider/RuntimeControl",
) {}

const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"])

/** Last few lines of a failing step's output. The chip shows a cause, not a log. */
const tail = (detail: string, lines = 12): ReadonlyArray<string> =>
  detail.split("\n").filter((line) => line.trim().length > 0).slice(-lines)

/**
 * Whether any client currently subscribes to one of the bot's threads. Gateway
 * state, not event state, so it arrives as its own narrow service.
 */
export interface ClientPresenceShape {
  readonly isAttached: (botId: BotId) => Effect.Effect<boolean>
}

export class ClientPresence extends Context.Service<ClientPresence, ClientPresenceShape>()(
  "ClientPresence",
) {
  /**
   * Nobody is ever watching. For tests that are not about presence, and for a
   * headless boot with no gateway; idle-stop then depends on turns alone.
   *
   * Not for the real server. Wired here, this layer is the whole of the "my
   * agent stops working if I leave it open" bug: `isAttached` answers false
   * while the user is looking straight at the thread, so the idle timer fires
   * on a conversation in active use and the next message pays a cold start --
   * or, before `Supervisor.acquire` stopped caching failed starts, never
   * arrived at all.
   */
  static readonly layerNone = Layer.succeed(ClientPresence, {
    isAttached: () => Effect.succeed(false),
  })

  /**
   * The real one: a bot is attached when a client is subscribed to any thread
   * it participates in.
   *
   * Read straight from the hub's live subscriber set rather than from a
   * presence table, so it cannot disagree with who the server is actually
   * streaming to, and so a client that vanishes without saying goodbye stops
   * counting the moment its stream unwinds. Costs one indexed query per bot
   * per idle window -- the loop runs every `idleStopMinutes`, not on any hot
   * path.
   */
  static readonly layerHub = Layer.effect(ClientPresence)(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const hub = yield* Hub
      return {
        isAttached: (botId) =>
          Effect.gen(function* () {
            const watched = hub.watchedThreads()
            if (watched.size === 0) return false
            const rows = yield* sql<{ thread_id: string }>`
              select thread_id from thread_participant where bot_id = ${botId}`
            return rows.some((row) => watched.has(row.thread_id))
          }).pipe(
            // Presence is an optimisation, not a decision the log depends on.
            // A failed read must not wedge the idle loop; "nobody is watching"
            // is the same answer this returned for the whole of its life so far.
            Effect.catchCause((cause) =>
              Effect.logWarning("ClientPresence: attachment lookup failed", { botId }, cause).pipe(
                Effect.as(false),
              ),
            ),
          ),
      }
    }),
  )
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const store = yield* EventStore
  const wake = yield* ReactorWake
  const control = yield* RuntimeControl
  const presence = yield* ClientPresence
  const config = yield* EvieConfig
  const scaffold = yield* Scaffold
  const timers = yield* FiberMap.make<BotId>()
  const startedAt = Date.now()
  const idleMillis = config.idleStopMinutes * 60_000

  /**
   * Nothing is running yet, whatever the log last said.
   *
   * Runtime health is projected from `RuntimeReady` / `RuntimeStopped`, and
   * runtimes do not survive the process -- so a server that stops while a bot
   * is warm leaves `ready` as the last word on it forever. On the next boot
   * every bot that was ever used claims to be up, with no runtime behind any of
   * them. That is the stale label `AGENTS.md` warns about, and it is worst
   * exactly where it is most visible: the status dot beside the bot's name goes
   * green on a bot that is not there.
   *
   * The honest repair is an event, not a patched column: the runtime *did*
   * stop, when this process's predecessor did, and `shutdown` is the reason.
   * Saying so through the log means the projection, the rail and the dot all
   * learn it the same way they learn everything else.
   *
   * A fresh id per boot on purpose. This runs once per process rather than per
   * event, so it is never replayed -- and a derived id would be swallowed as a
   * duplicate on the second restart, which is precisely when it would be
   * needed again.
   */
  const runningKinds = new Set(["ready", "busy", "starting", "restarting"])
  yield* Effect.gen(function* () {
    const bots = yield* sql<{ id: string; org_id: string; health: string }>`
      select id, org_id, health from bot where archived_at is null`
    let cleared = 0
    for (const row of bots) {
      // The column predates the first health write, so it can still be the
      // migration's bare 'idle' rather than JSON.
      const kind = row.health.startsWith("{")
        ? ((JSON.parse(row.health) as { kind?: string }).kind ?? "idle")
        : row.health
      // `unhealthy` is left alone: a bot whose project never installed is
      // still broken after a restart, and its reason is still the reason.
      if (!runningKinds.has(kind)) continue
      yield* store.append(
        [
          {
            data: RuntimeStopped.make({ botId: row.id as BotId, reason: "shutdown" }),
            orgId: row.org_id,
            botId: row.id,
          },
        ],
        { aggregate: { kind: "bot", id: row.id } },
      )
      cleared += 1
    }
    if (cleared === 0) return
    yield* Effect.logInfo("SupervisorReactor: cleared runtime health left over by a previous process", {
      bots: cleared,
    })
    yield* wake.notify
  }).pipe(
    // A boot that cannot tidy the last one's labels is still a boot worth
    // having. The cost of failing here is a stale chip; the cost of failing
    // the layer is no server.
    Effect.catchCause((cause) =>
      Effect.logError("SupervisorReactor: could not clear stale runtime health", cause),
    ),
  )

  const activeTurnCount = Effect.fn("SupervisorReactor.activeTurnCount")(function* (
    botId: BotId,
  ) {
    const rows = yield* sql<{ n: number | bigint }>`
      select count(*) as n from event
      where session_id = '' and type = 'TurnDispatched' and bot_id = ${botId}
        and json_extract(data, '$.turnId') not in (
          select json_extract(data, '$.turnId') from event
          where session_id = '' and type = 'TurnSettled' and bot_id = ${botId})`
    return Number(rows[0]?.n ?? 0)
  })

  const idleLoop = (botId: BotId, orgId: string) =>
    Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(idleMillis)
        // A turn dispatched while we slept re-arms via its own TurnSettled.
        if ((yield* activeTurnCount(botId)) > 0) return
        // Someone is watching: keep the runtime warm, check again next window.
        if (yield* presence.isAttached(botId)) continue
        yield* control.stop(botId, "idle")
        yield* store.append(
          [
            {
              data: RuntimeStopped.make({ botId, reason: "idle" }),
              orgId,
              botId,
            },
          ],
          { aggregate: { kind: "bot", id: botId } },
        )
        yield* wake.notify
        return
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("SupervisorReactor: idle stop failed", { botId }, cause),
      ),
    )

  /** Replaces any existing timer for the bot: activity resets the clock. */
  const armIdle = (botId: BotId, orgId: string) => FiberMap.run(timers, botId, idleLoop(botId, orgId))
  const cancelIdle = (botId: BotId) => FiberMap.remove(timers, botId)

  const threadBots = Effect.fn("SupervisorReactor.threadBots")(function* (threadId: ThreadId) {
    const rows = yield* sql<{ bot_id: string }>`
      select bot_id from thread_participant where thread_id = ${threadId}
      order by is_default desc, bot_id asc`
    return rows.map((row) => row.bot_id as BotId)
  })

  const warm = (event: StoredEvent, bots: ReadonlyArray<BotId>) =>
    Effect.gen(function* () {
      const commits: Array<Commit> = []
      for (const botId of bots) {
        yield* cancelIdle(botId)
        const runtime = yield* control.acquire(botId)
        if (runtime.fresh) {
          commits.push(
            store.append(
              [
                {
                  id: deriveUlid(event.id, botId, "ready"),
                  data: RuntimeReady.make({ botId, port: runtime.port }),
                  orgId: event.orgId,
                  botId,
                },
              ],
              { aggregate: { kind: "bot", id: botId } },
            ),
          )
        }
      }
      if (commits.length === 0) return
      const commit: Commit = Effect.all(commits)
      return commit
    })

  /**
   * Writes the bot's eve project, installs it, boots its runtime, then settles
   * the health chip. `BotProvisioned` means the runtime answered its health
   * route -- not merely "files on disk" -- because the chip's `starting` is the
   * creation screen's gate, and a gate that drops while the first message
   * would still wait 30-plus seconds for a cold boot is a gate that lies.
   *
   * This is slow -- `git init` plus `npm install` plus an eve boot, because eve
   * is pinned per bot (decision 014) -- which is precisely why it is here and
   * not in the projector. The bot row already exists at `starting`; one of
   * these two receipts moves it on.
   *
   * A failure is reported, not retried into oblivion: a bot whose project never
   * installed will never answer, and a chip that says why beats a bot that
   * looks fine and silently does nothing on the first message.
   */
  const provision = (event: StoredEvent, botId: BotId, name: string, model: string) =>
    Effect.gen(function* () {
      /*
       * Replayed `BotCreated` events land here on every boot (see `handle`).
       * The success receipt makes them cheap -- and keeps a restart from
       * booting every bot's runtime just to prove what the log already says.
       * A *failed* provision deliberately has no such receipt, so it retries:
       * a transient npm failure heals on the next boot.
       */
      const settled = yield* sql<{ n: number | bigint }>`
        select count(*) as n from event
        where session_id = '' and type = 'BotProvisioned' and bot_id = ${botId}`
      if (Number(settled[0]?.n ?? 0) > 0) return

      const outcome = yield* scaffold
        .create({
          orgId: event.orgId as Parameters<typeof scaffold.create>[0]["orgId"],
          botId,
          name,
          model,
        })
        .pipe(
          // The boot is part of the proof. `acquire` waits for eve's health
          // route, so success here means the bot can actually take a message.
          Effect.andThen(
            control.acquire(botId).pipe(
              Effect.mapError((error) => ({
                step: "runtime",
                detail: [error.reason, ...(error.stderr ?? [])].join("\n"),
              })),
            ),
          ),
          Effect.result,
        )

      if (Result.isFailure(outcome)) {
        const failure = outcome.failure
        yield* Effect.logError("SupervisorReactor: provisioning failed", { botId }, failure)
        return store.append(
          [
            {
              id: deriveUlid(event.id, botId, "provision-failed"),
              data: BotProvisionFailed.make({
                botId,
                reason: failure.step,
                stderr: tail(failure.detail),
              }),
              orgId: event.orgId,
              botId,
            },
          ],
          { aggregate: { kind: "bot", id: botId } },
        ) as Commit
      }

      // The runtime is up with no turn to settle and maybe nobody watching;
      // arm the idle clock so a bot created and abandoned still goes to sleep.
      yield* armIdle(botId, event.orgId)

      const runtime = outcome.success
      return store.append(
        [
          {
            id: deriveUlid(event.id, botId, "provisioned"),
            data: BotProvisioned.make({ botId }),
            orgId: event.orgId,
            botId,
          },
          // Same rule as `warm`: only the call that started the runtime says so.
          ...(runtime.fresh
            ? [
                {
                  id: deriveUlid(event.id, botId, "ready"),
                  data: RuntimeReady.make({ botId, port: runtime.port }),
                  orgId: event.orgId,
                  botId,
                },
              ]
            : []),
        ],
        { aggregate: { kind: "bot", id: botId } },
      ) as Commit
    })

  /**
   * `eve set --model … --reasoning …` in the bot directory, reusing eve's own
   * validated source editor rather than rewriting `agent.ts` -- so a model
   * defined with `defineDynamic` is not silently clobbered.
   *
   * Failure is logged and not surfaced as unhealthy: the bot still runs, it
   * just runs the previous model, and the read model already shows the new one.
   */
  const retune = (
    event: StoredEvent,
    data: { readonly botId: BotId; readonly model: string; readonly reasoning: string | null },
  ) =>
    scaffold
      .setModel({
        orgId: event.orgId as Parameters<typeof scaffold.setModel>[0]["orgId"],
        botId: data.botId,
        model: data.model,
        ...(data.reasoning !== null && REASONING_EFFORTS.has(data.reasoning)
          ? {
              reasoning: data.reasoning as NonNullable<
                Parameters<typeof scaffold.setModel>[0]["reasoning"]
              >,
            }
          : {}),
      })
      .pipe(
        Effect.catch((failure) =>
          Effect.logError("SupervisorReactor: eve set failed", { botId: data.botId }, failure),
        ),
      )

  return {
    name: "supervisor" as const,
    handle: (
      event: StoredEvent,
    ): Effect.Effect<Commit | void, SqlError | RuntimeUnavailable> => {
      const data = event.data

      /*
       * Provisioning is checked BEFORE the staleness guard below. A bot
       * created moments before a crash still needs its project on disk, so
       * this is exactly the replay the guard must not swallow -- unlike
       * activity, which is history rather than demand.
       */
      if (data._tag === "BotCreated") return provision(event, data.botId, data.name, data.model)
      if (data._tag === "ModelChanged") return retune(event, data)

      // Stale activity is history, not demand. See the module comment.
      if (event.at < startedAt) return Effect.void
      switch (data._tag) {
        case "MessageSent":
          return Effect.gen(function* () {
            const bots = yield* threadBots(data.threadId)
            const recipients = data.mentions.length > 0 ? data.mentions : bots.slice(0, 1)
            return yield* warm(event, recipients)
          })
        case "RoutineFired":
        case "TurnDispatched":
          return warm(event, [data.botId])
        case "InputAnswered":
          // The answer's dispatch acquires through the adapter; here it only
          // counts as liveness for every bot in the thread.
          return Effect.gen(function* () {
            const bots = yield* threadBots(data.threadId)
            for (const botId of bots) yield* cancelIdle(botId)
          })
        case "EveMirrored":
          // A streaming turn is alive by definition; keep its runtime out of
          // the idle window without touching acquire on the hot path.
          return cancelIdle(data.botId)
        case "ServiceConnected":
        case "ServiceDisconnected":
        case "GrantLinked":
        case "GrantRevoked":
          /*
           * Connections are files, and `eve dev` reads them at boot. Adding one
           * therefore does nothing to a runtime that is already up -- the tools
           * simply never appear, and the bot says it has no way to reach the
           * service it was just given.
           *
           * Disconnecting is the direction that matters: leaving the old
           * runtime alive keeps a revoked integration working, which is the
           * worst way for this to fail. Stopping is the whole fix, because
           * acquire is lazy -- the next message starts a runtime that
           * reconciles `agent/connections/` and picks up the new token.
           */
          return control.stop(data.botId, "reload")
        case "TurnSettled":
          return Effect.gen(function* () {
            if ((yield* activeTurnCount(data.botId)) > 0) return
            yield* armIdle(data.botId, event.orgId)
          })
        default:
          return Effect.void
      }
    },
  }
})

/**
 * Provide `RuntimeControl` (the provider's slice), `ClientPresence` (or
 * `.layerNone`), `EvieConfig.layer`, plus `Db.layer` / `EventStore.layer`.
 */
export const SupervisorReactorLive = reactorLayer(make)
