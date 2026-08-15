/**
 * End-to-end driver: a real server, a real socket, real commands.
 *
 * Speaks the same wire the app does -- MsgPack RPC over a WebSocket, a session
 * from a claim token -- so anything that would break the client breaks here.
 * The server is started by the caller; this only drives it.
 *
 * Two modes, because the interesting half of "does history survive" is what is
 * still there after a restart:
 *
 *   create  -- make agents, open threads, send messages, wait out provisioning
 *   verify  -- reconnect to an already-populated home and read it back
 *
 * Never point this at `~/.evie`. It writes.
 */
import type { Bot } from "@evie/contracts/bot"
import { EvieRpc } from "@evie/contracts/rpc"
import { CONTRACT_VERSION } from "@evie/contracts/version"
import { Effect, Fiber, Layer, Stream } from "effect"
import { RpcClient, RpcSerialization } from "effect/unstable/rpc"
import { Socket } from "effect/unstable/socket"

// `EVIE_PORT`, the same variable the server was started with -- one fewer
// thing to keep in sync, and already declared in `turbo.json`.
const PORT = Number(process.env["EVIE_PORT"] ?? 3199)
const BASE = `http://127.0.0.1:${PORT}`
const NAMES = ["Scout", "Archivist", "Ferry"]

const step = (message: string) => console.log(`\n▶ ${message}`)
const ok = (message: string) => console.log(`  ✓ ${message}`)
const note = (message: string) => console.log(`  · ${message}`)

/**
 * Mints a fresh claim through the launcher route -- the same door the desktop
 * shell uses. The boot-printed token is single-use and 60 seconds, so it is
 * gone by the second run.
 */
const mintClaim = async (launcherToken: string): Promise<string> => {
  const response = await fetch(`${BASE}/internal/launcher/claim`, {
    method: "POST",
    headers: { authorization: `Bearer ${launcherToken}` },
  })
  if (!response.ok) throw new Error(`launcher claim failed: ${response.status}`)
  const { url } = (await response.json()) as { url: string }
  const token = new URL(url).searchParams.get("claim")
  if (token === null) throw new Error("launcher returned no claim token")
  return token
}

const signIn = async (claim: string): Promise<string> => {
  const response = await fetch(`${BASE}/api/auth/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: claim }),
  })
  if (!response.ok) throw new Error(`claim failed: ${response.status} ${await response.text()}`)
  const cookie = response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ")
  if (cookie === "") throw new Error("claim returned no cookie")
  return cookie
}

const ProtocolLive = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(Socket.layerWebSocket(`ws://127.0.0.1:${PORT}/rpc`)),
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
  Layer.provide(RpcSerialization.layerMsgPack),
)

const run = (mode: "create" | "verify" | "wake", launcherToken: string) =>
  Effect.gen(function* () {
    const claim = yield* Effect.promise(() => mintClaim(launcherToken))
    const cookie = yield* Effect.promise(() => signIn(claim))
    ok("claim minted and redeemed, session cookie issued")

    const client = yield* RpcClient.make(EvieRpc)
    // The websocket protocol concatenates the handshake headers onto every
    // request and the client's own headers on top -- either reaches
    // `resolveActor`, so the cookie can ride here rather than on the upgrade.
    const call = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      RpcClient.withHeaders(effect, { cookie })

    step("handshake")
    const session = yield* call(client["session.hello"]({ contractVersion: CONTRACT_VERSION }))
    ok(`session.hello -> user ${session.userId}, org ${session.orgId}`)

    const listBots = () => call(client["bots.list"]({})) as Effect.Effect<ReadonlyArray<Bot>>

    if (mode === "create") {
      step("use case 1: create three agents in succession")
      for (const name of NAMES) {
        const receipt = yield* call(
          client.command({
            command: {
              _tag: "CreateBot",
              input: { name, model: "anthropic/claude-opus-4.8" },
            } as never,
          }),
        )
        // The version incrementing 1,2,3 is the org-aggregate fix: these used
        // to contend with every other event in the organization.
        ok(`CreateBot ${name} -> ${receipt.resourceId} (org v${receipt.aggregateVersion})`)
      }

      const created = yield* listBots()
      if (created.length !== NAMES.length) throw new Error(`expected ${NAMES.length} bots`)

      step("use case 1: open a thread per agent and send it a message")
      for (const [index, bot] of created.entries()) {
        const opened = yield* call(
          client.command({ command: { _tag: "OpenThread", participants: [bot.id] } as never }),
        )
        yield* call(
          client.command({
            command: {
              _tag: "SendMessage",
              threadId: opened.resourceId,
              text: `Hello ${bot.name}, this is end-to-end message ${index + 1}.`,
              mentions: [],
              attachments: [],
              idempotencyKey: `e2e-${bot.id}`,
            } as never,
          }),
        )
        ok(`${bot.name}: thread ${opened.resourceId} opened and messaged`)
      }

      step("use case 1: the sandbox is provisioned (git init + npm install)")
      // Provisioning is slow and runs behind the health chip, so this waits on
      // the chip rather than on a fixed delay.
      const settled = yield* waitForProvisioning(listBots)
      for (const bot of settled) {
        const detail = bot.health.kind === "unhealthy" ? ` (${bot.health.reason})` : ""
        note(`${bot.name}: ${bot.health.kind}${detail}`)
      }
    }

    step("use case 2: history reads back")
    const bots = yield* listBots()
    ok(`bots.list -> ${bots.length}: ${bots.map((b) => `${b.name}[${b.health.kind}]`).join(", ")}`)
    const threadPage = (yield* call(client["threads.list"]({} as never))) as {
      items: ReadonlyArray<{ id: string; participants: ReadonlyArray<{ botId: string }> }>
    }
    const threads = threadPage.items
    ok(`threads.list -> ${threads.length}`)

    let userMessages = 0
    for (const thread of threads) {
      const page = (yield* call(client["threads.timeline"]({ threadId: thread.id } as never))) as {
        items: ReadonlyArray<{ kind: string }>
      }
      const items = page.items
      const mine = items.filter((item) => item.kind === "user")
      userMessages += mine.length
      note(`thread ${thread.id}: ${items.length} item(s), ${mine.length} from me`)
    }
    // At least one per thread, and never fewer than were sent. `wake` runs add
    // messages on purpose, so the invariant is "nothing was lost", not a count.
    if (threads.length < NAMES.length || userMessages < NAMES.length) {
      throw new Error(
        `expected >= ${NAMES.length} threads and messages, found ${threads.length} / ${userMessages}`,
      )
    }
    ok(`all ${userMessages} messages across ${threads.length} threads are still in the log`)

    if (mode === "wake") {
      step("use case 3: an asleep agent wakes on the next message")
      const target = threads[0]!
      // The bot on *this* thread, not `bots[0]` -- naming the wrong one would
      // make the line below a lie, which is the whole point of the exercise.
      const targetBotId = target.participants[0]?.botId
      const before = bots.find((bot) => bot.id === targetBotId)!
      note(`${before.name} is ${before.health.kind} before the message`)
      yield* call(
        client.command({
          command: {
            _tag: "SendMessage",
            threadId: target.id,
            text: "Are you still there?",
            mentions: [],
            attachments: [],
            idempotencyKey: `e2e-wake-${Date.now()}`,
          } as never,
        }),
      )
      const isUp = (bot: Bot) => bot.health.kind === "ready" || bot.health.kind === "busy"
      const woken = yield* waitFor(listBots, (list) =>
        list.some((bot) => bot.id === targetBotId && isUp(bot)),
      )
      ok(`after the message: ${woken.map((b) => `${b.name}[${b.health.kind}]`).join(", ")}`)
      if (!woken.some((bot) => bot.id === targetBotId && isUp(bot))) {
        throw new Error(`${before.name}'s runtime did not come back up`)
      }
    }

    step("use case 3: a live subscription is what presence reads")
    const firstThread = threads[0]!
    const frames: Array<unknown> = []
    const fiber = yield* Effect.forkChild(
      call(
        Stream.runForEach(
          client["threads.subscribe"]({ threadId: firstThread.id } as never),
          (frame) => Effect.sync(() => frames.push(frame)),
        ),
      ).pipe(Effect.ignore),
    )
    yield* Effect.sleep("2 seconds")
    ok(`subscribed to ${firstThread.id}: ${frames.length} frame(s); the bot now counts as watched`)
    yield* Fiber.interrupt(fiber)

    return { bots: bots.length, threads: threads.length, userMessages }
  })

/**
 * Waits until no bot is still `starting`. Provisioning runs `npm install` in
 * the new bot's directory, which is minutes on a cold cache, so this polls the
 * read model rather than guessing a duration -- a live driver, not a unit test.
 */
const waitForProvisioning = (listBots: () => Effect.Effect<ReadonlyArray<Bot>>) =>
  waitFor(listBots, (bots) => !bots.some((bot) => bot.health.kind === "starting"))

/** Polls the read model until it says what we are waiting for, or time is up. */
const waitFor = (
  listBots: () => Effect.Effect<ReadonlyArray<Bot>>,
  done: (bots: ReadonlyArray<Bot>) => boolean,
) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 300_000
    while (true) {
      const bots = yield* listBots()
      if (done(bots)) return bots
      if (Date.now() > deadline) {
        note("gave up waiting after 5 minutes; reporting what it got to")
        return bots
      }
      yield* Effect.sleep("3 seconds")
    }
  })

const arg = process.argv[2]
const mode = arg === "verify" || arg === "wake" ? arg : "create"
const launcherToken = process.env["EVIE_LAUNCHER_TOKEN"]
if (launcherToken === undefined) {
  throw new Error("set EVIE_LAUNCHER_TOKEN to the value the server was started with")
}

Effect.runPromise(
  run(mode, launcherToken).pipe(Effect.scoped, Effect.provide(ProtocolLive)) as Effect.Effect<{
    bots: number
    threads: number
    userMessages: number
  }>,
)
  .then((result) => {
    console.log(
      `\n✅ ${mode}: ${result.bots} bots, ${result.threads} threads, ${result.userMessages} messages`,
    )
    process.exit(0)
  })
  .catch((error) => {
    console.error(`\n❌ ${mode} failed:`, error)
    process.exit(1)
  })
