/* Temporary diagnostic: send to a cold bot's thread and watch what comes back. */
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
const threadId = process.argv[2]!
const text = process.argv[3]!
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
const runtime = ManagedRuntime.make(
  RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
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
  ),
)
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
const page = (await runtime.runPromise(
  withClient((c) => c["threads.timeline"]({ threadId, limit: 3 })),
)) as { items: Array<{ seq: number; kind: string }> }
const since = page.items.reduce((m, i) => Math.max(m, i.seq), 0)
runtime.runFork(
  withClient((c) =>
    Stream.runForEach(c["threads.subscribe"]({ threadId, since }), (frame: any) =>
      Effect.sync(() => {
        const ops = frame.ops.map((o: any) =>
          o.op === "insert" || o.op === "replace" ? `${o.op}:${o.item.kind}` : o.op,
        )
        if (ops.length > 0 || frame.status !== undefined)
          log("frame", JSON.stringify(ops), "status=" + JSON.stringify(frame.status))
      }),
    ).pipe(Effect.tapCause((c) => Effect.sync(() => log("STREAM DIED", String(c))))),
  ),
)
await new Promise((r) => setTimeout(r, 1000))
log("sending:", text)
const outcome = await runtime
  .runPromise(
    withClient((c) =>
      c["command"]({
        command: {
          _tag: "SendMessage",
          threadId,
          text,
          mentions: [],
          attachments: [],
          idempotencyKey: `probe-${Date.now()}`,
        },
      }),
    ),
  )
  .then((r) => `accepted ${JSON.stringify(r)}`)
  .catch((e: unknown) => `REFUSED ${String(e)}`)
log(outcome)
await new Promise((r) => setTimeout(r, Number(process.env.PROBE_SECONDS ?? 90) * 1000))
await Effect.runPromise(Fiber.interrupt(fiber))
await runtime.dispose()
process.exit(0)
