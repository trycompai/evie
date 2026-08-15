/* Temporary diagnostic: what the fleet stream actually tells a client. */
import WS from "../../node_modules/.bun/ws@8.21.3/node_modules/ws/index.js"
import { Deferred, Effect, Fiber, Layer, ManagedRuntime, Stream } from "effect"
import { RpcClient, RpcSerialization } from "effect/unstable/rpc"
import { Socket } from "effect/unstable/socket"
import { EvieRpc } from "@evie/contracts/rpc"
import { CONTRACT_VERSION } from "@evie/contracts/version"
import { readFileSync } from "node:fs"

const lock = JSON.parse(readFileSync("../../.evie/userdata/evie.lock", "utf8")) as {
  url: string
  launcherToken: string
}
const base = lock.url
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a)

const claim = await fetch(`${base}/internal/launcher/claim`, {
  method: "POST",
  headers: { authorization: `Bearer ${lock.launcherToken}` },
})
const { url } = (await claim.json()) as { url: string }
const exchange = await fetch(`${base}/api/auth/claim`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: new URL(url).searchParams.get("claim") }),
})
const cookie = (exchange.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ")

const wsUrl = new URL("/rpc", base)
wsUrl.protocol = "ws:"
const protocol = RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
  Layer.provideMerge(RpcSerialization.layerMsgPack),
  Layer.provideMerge(
    Socket.layerWebSocket(wsUrl.toString()).pipe(
      Layer.provide(
        Layer.succeed(Socket.WebSocketConstructor)(
          (u: string) => new WS(u, { headers: { cookie } }) as unknown as globalThis.WebSocket,
        ),
      ),
    ),
  ),
)
const runtime = ManagedRuntime.make(protocol)
const handle = Effect.runSync(Deferred.make<RpcClient.RpcClient<any, any>, never>())
const fiber = runtime.runFork(
  Effect.gen(function* () {
    yield* Deferred.succeed(handle, yield* RpcClient.make(EvieRpc))
    return yield* Effect.never
  }).pipe(Effect.scoped),
)
const withClient = <A>(f: (c: any) => Effect.Effect<A, unknown>) =>
  Deferred.await(handle).pipe(Effect.flatMap(f))

await runtime.runPromise(withClient((c) => c["session.hello"]({ contractVersion: CONTRACT_VERSION })))

let frames = 0
runtime.runFork(
  withClient((c) =>
    Stream.runForEach(c["fleet.subscribe"](), (frame: any) =>
      Effect.sync(() => {
        frames++
        if (frames === 1) {
          log("--- opening snapshot ---")
          for (const b of frame.bots ?? [])
            log(`  bot ${b.name.padEnd(16)} health=${JSON.stringify(b.health)} archived=${b.archivedAt}`)
          for (const t of frame.threads ?? [])
            log(
              `  thread ${t.id} participants=${JSON.stringify(t.participants.map((p: any) => p.botId))} status=${JSON.stringify(t.status)}`,
            )
        } else {
          log(
            "delta frame:",
            "bots=" + JSON.stringify((frame.bots ?? []).map((b: any) => b.name)),
            "threads=" +
              JSON.stringify(
                (frame.threads ?? []).map((t: any) => ({
                  id: t.id.slice(-6),
                  participants: t.participants.length,
                })),
              ),
          )
        }
      }),
    ).pipe(Effect.tapCause((c) => Effect.sync(() => log("FLEET DIED", String(c))))),
  ),
)

await new Promise((r) => setTimeout(r, Number(process.env.PROBE_SECONDS ?? 6) * 1000))
await Effect.runPromise(Fiber.interrupt(fiber))
await runtime.dispose()
process.exit(0)
