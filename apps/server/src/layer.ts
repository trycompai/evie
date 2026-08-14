import { NodeHttpClient, NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Auth } from "./auth/Auth.ts"
import { GatewayAuthLive } from "./auth/gateway-auth.ts"
import { EvieConfig } from "./config.ts"
import { Db } from "./db/Db.ts"
import { MigrationsLive } from "./db/migrations.ts"
import { GatewayLive } from "./gateway/Gateway.ts"
import { Hub } from "./gateway/hub.ts"
import { DeltaPumpLive } from "./gateway/pump.ts"
import { CheckpointSourcesLive, RuntimeControlLive, TurnDispatchLive } from "./provider/bridges.ts"
import { EveAdapter } from "./provider/EveAdapter.ts"
import { Scaffold } from "./provider/scaffold.ts"
import { Supervisor } from "./provider/Supervisor.ts"
import { CheckpointReactorLive } from "./reactors/checkpoint.ts"
import { Notifier, NotifyReactorLive } from "./reactors/notify.ts"
import { ProjectorReactorLive } from "./reactors/projector.ts"
import { RoutineReactorLive } from "./reactors/routine.ts"
import { ReactorWake } from "./reactors/runtime.ts"
import { ClientPresence, SupervisorReactorLive } from "./reactors/supervisor.ts"
import { TurnReactorLive } from "./reactors/turn.ts"
import { Scheduler } from "./scheduler/Scheduler.ts"
import { Secrets } from "./secrets/Secrets.ts"
import { EventStore } from "./store/EventStore.ts"

/**
 * The composed process. Boot order is part of the design (02, "Boot"):
 *
 *   home dirs -> Db -> Better Auth migrations -> Evie migrations
 *     -> reactors replay from their cursors -> the gateway accepts connections
 *
 * `Layer.provide` is the ordering tool: a provided layer finishes building
 * before its dependent starts, and the same layer reference is memoized, so
 * naming each stage once here pins the whole sequence without any runtime
 * flags. The gateway layer depends on the reactor layers for exactly this
 * reason -- `reactorLayer` returns only after catch-up, which is what makes
 * "replay before accept" true.
 */

/* --- storage: config, the one writer, both migration owners ------------------- */

const ConfigLive = EvieConfig.layer

/** `Db.make` creates the home dirs, so "home dirs before everything" rides here. */
const DbLive = Db.layer.pipe(Layer.provide(ConfigLive))

/** Better Auth's `getMigrations()` runs during this layer's construction. */
const AuthLive = Auth.layer.pipe(Layer.provide([DbLive, ConfigLive]))

/** Evie's own schema, pinned after Better Auth's by the explicit dependency. */
const SchemaLive = MigrationsLive.pipe(Layer.provide(DbLive), Layer.provide(AuthLive))

/** Seeds its seq counter from the event table, so it must follow the migrator. */
const EventStoreLive = EventStore.layer.pipe(Layer.provide(DbLive), Layer.provide(SchemaLive))

const WakeLive = ReactorWake.layer
const HubLive = Hub.layer.pipe(Layer.provide(DbLive))
const SecretsLive = Secrets.layer.pipe(Layer.provide([DbLive, ConfigLive]), Layer.provide(SchemaLive))

/* --- the provider: eve runtimes, the adapter, and the reactor-facing seams ---- */

const NodeLive = NodeServices.layer
const HttpClientLive = NodeHttpClient.layerUndici

const SupervisorLive = Supervisor.layer.pipe(
  Layer.provide([ConfigLive, DbLive, NodeLive, HttpClientLive]),
  Layer.provide(SchemaLive),
)

const ScaffoldLive = Scaffold.layer.pipe(Layer.provide([ConfigLive, NodeLive]))

const AdapterLive = EveAdapter.layer.pipe(
  Layer.provide([ConfigLive, DbLive, EventStoreLive, SupervisorLive, HttpClientLive, WakeLive]),
)

const TurnDispatchL = TurnDispatchLive.pipe(Layer.provide([AdapterLive, DbLive]))
const RuntimeControlL = RuntimeControlLive.pipe(Layer.provide(SupervisorLive))
const CheckpointSourcesL = CheckpointSourcesLive.pipe(Layer.provide(DbLive))

const SchedulerLive = Scheduler.layer.pipe(Layer.provide([DbLive, EventStoreLive, WakeLive]))

/* --- reactors: replay completes inside each layer's build --------------------- */

const ReactorsLive = Layer.mergeAll(
  ProjectorReactorLive.pipe(
    Layer.provide([DbLive, EventStoreLive, WakeLive, ConfigLive, HubLive, SchedulerLive]),
  ),
  TurnReactorLive.pipe(Layer.provide([DbLive, EventStoreLive, WakeLive, TurnDispatchL])),
  RoutineReactorLive.pipe(
    Layer.provide([DbLive, EventStoreLive, WakeLive, SchedulerLive, TurnDispatchL]),
  ),
  CheckpointReactorLive.pipe(
    Layer.provide([DbLive, EventStoreLive, WakeLive, CheckpointSourcesL, NodeLive]),
  ),
  NotifyReactorLive.pipe(Layer.provide([DbLive, EventStoreLive, WakeLive, Notifier.layerDefault])),
  // Scaffold lives here, not on the projector: provisioning a bot runs
  // `npm install` and belongs behind the health chip, not inside a projection.
  SupervisorReactorLive.pipe(
    Layer.provide([
      DbLive,
      EventStoreLive,
      WakeLive,
      RuntimeControlL,
      ClientPresence.layerNone,
      ConfigLive,
      ScaffoldLive,
    ]),
  ),
)

/* --- the gateway: last to build, so replay precedes the first connection ------- */

const GatewayReady = GatewayLive.pipe(
  Layer.provide(GatewayAuthLive.pipe(Layer.provide([AuthLive, DbLive]))),
  Layer.provide([ConfigLive, DbLive, EventStoreLive, HubLive, WakeLive, SecretsLive, AuthLive]),
  Layer.provide(ReactorsLive),
)

/** The adapter's projected deltas, diffed into wire frames for subscribers. */
const PumpLive = DeltaPumpLive.pipe(Layer.provide([AdapterLive, HubLive]))

/**
 * Local mode bootstraps its owner and prints the one-time claim URL once the
 * gateway is up (the token is single-use and 60 s; printing it before the
 * port listens would waste most of that window on a slow boot).
 */
const LocalClaimLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* EvieConfig
    if (config.mode !== "local") return
    const auth = yield* Auth
    const userId = yield* auth.claim.ensureLocalOwner
    const { token } = auth.claim.mint(userId)
    yield* Effect.log(`Evie is ready: http://127.0.0.1:${config.port}/?claim=${token}`)
  }),
).pipe(Layer.provide([ConfigLive, AuthLive]), Layer.provide(GatewayReady))

export const AppLive = Layer.mergeAll(GatewayReady, PumpLive, LocalClaimLive)
