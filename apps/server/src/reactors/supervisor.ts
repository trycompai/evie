import type { RuntimeUnavailable } from "@evie/contracts/errors"
import {
  BotProvisioned,
  BotProvisionFailed,
  RuntimeReady,
  RuntimeStopped,
  type StoredEvent,
} from "@evie/contracts/events"
import type { BotId, ThreadId } from "@evie/contracts/ids"
import { Context, Effect, FiberMap, Layer } from "effect"
import type { SqlError } from "effect/unstable/sql/SqlError"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { EvieConfig } from "../config.ts"
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
  readonly stop: (botId: BotId, reason: "idle" | "shutdown") => Effect.Effect<void>
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
 * state, not event state, so it arrives as its own narrow service. Until the
 * gateway lands, `layerNone` makes idle-stop depend on turns alone.
 */
export interface ClientPresenceShape {
  readonly isAttached: (botId: BotId) => Effect.Effect<boolean>
}

export class ClientPresence extends Context.Service<ClientPresence, ClientPresenceShape>()(
  "ClientPresence",
) {
  static readonly layerNone = Layer.succeed(ClientPresence, {
    isAttached: () => Effect.succeed(false),
  })
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
   * Writes the bot's eve project and installs it, then settles the health chip.
   *
   * This is slow -- `git init` plus `npm install` in the bot directory, because
   * eve is pinned per bot (decision 014) -- which is precisely why it is here
   * and not in the projector. The bot row already exists at `starting`; one of
   * these two receipts moves it to `idle` or `unhealthy`.
   *
   * A failure is reported, not retried into oblivion: a bot whose project never
   * installed will never answer, and a chip that says why beats a bot that
   * looks fine and silently does nothing on the first message.
   */
  const provision = (event: StoredEvent, botId: BotId, name: string, model: string) =>
    scaffold
      .create({
        orgId: event.orgId as Parameters<typeof scaffold.create>[0]["orgId"],
        botId,
        name,
        model,
      })
      .pipe(
        Effect.as(
          store.append(
            [
              {
                id: deriveUlid(event.id, botId, "provisioned"),
                data: BotProvisioned.make({ botId }),
                orgId: event.orgId,
                botId,
              },
            ],
            { aggregate: { kind: "bot", id: botId } },
          ) as Commit,
        ),
        Effect.catch((failure) =>
          Effect.logError("SupervisorReactor: provisioning failed", { botId }, failure).pipe(
            Effect.as(
              store.append(
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
              ) as Commit,
            ),
          ),
        ),
      )

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
