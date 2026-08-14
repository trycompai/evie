import { createServer } from "node:http"
import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { EvieConfig } from "../config.ts"
import { HandlersLive } from "./handlers.ts"
import { HttpRoutesLive, StaticAssetsLive } from "./http.ts"
import { LauncherRoutesLive } from "./launcher.ts"
import { EvieRpcAuthed, RpcAuthLive } from "./middleware.ts"

/**
 * The gateway -- the only network-exposed surface.
 *
 * One port carries everything: `NodeHttpServer` wires both the `"request"` and
 * `"upgrade"` events of a single `http.Server`, and `RpcServer.layerHttp`
 * (websocket protocol) registers `GET /rpc` as the upgrade route on the same
 * router as the plain-HTTP routes. The standalone `SocketServer` transport
 * would open a second listener, which is exactly what "one exposed port"
 * exists to forbid.
 *
 * MsgPack framing on the socket: the timeline is the hot path and text deltas
 * plus tool payloads dominate the byte budget.
 *
 * Per-connection backpressure is layered: the RpcServer acks each stream chunk
 * before pulling the next, and while a slow client is not pulling, the hub
 * coalesces its pending deltas instead of queueing frames (see `hub.ts`).
 */

const RpcLive = RpcServer.layerHttp({ group: EvieRpcAuthed, path: "/rpc" }).pipe(
  Layer.provide(HandlersLive),
  Layer.provide(RpcAuthLive),
  Layer.provide(RpcSerialization.layerMsgPack),
)

/** Bind address and port come from config, so the layer resolves through it. */
const ServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* EvieConfig
    return NodeHttpServer.layer(() => createServer(), {
      port: config.port,
      host: config.bind,
    })
  }),
)

/**
 * The whole exposed surface as one layer. Still requires `EvieConfig`, `Db`,
 * `EventStore`, `Hub`, and `Auth` -- the process composition provides those,
 * and `Hub` deliberately stays outside so the ingestion path publishes into
 * the same instance the subscriptions read from.
 */
export const GatewayLive = HttpRouter.serve(
  Layer.mergeAll(RpcLive, HttpRoutesLive, LauncherRoutesLive, StaticAssetsLive),
  { disableLogger: true },
).pipe(Layer.provide(ServerLive))
