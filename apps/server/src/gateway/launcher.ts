import { timingSafeEqual } from "node:crypto"
import { Effect, Option } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Auth } from "../auth/Auth.ts"
import { EvieConfig } from "../config.ts"

/**
 * `POST /internal/launcher/claim` -- a fresh sign-in URL for the process that
 * started this server.
 *
 * The boot-printed claim token is single-use and lives 60 seconds, which is
 * exactly right for opening the first window and useless for opening the
 * second. Without this route a desktop shell whose window outlives its cookie
 * has one way back in: kill the server and every agent running under it. That
 * is a bad trade for a session.
 *
 * Three things gate it, and it is mounted only when all of them can hold:
 *
 *   1. `EVIE_LAUNCHER_TOKEN`, 32 random bytes the launcher generated and passed
 *      down at spawn. No env var, no route -- so a hand-started server has no
 *      such surface at all.
 *   2. Local mode only. The token travels in a header over loopback; the moment
 *      the server is reachable from a network this stops being a safe shape,
 *      and remote clients have real credentials anyway.
 *   3. Loopback peers only, checked per request, so a bind widened after boot
 *      cannot leave this route behind.
 *
 * Constant-time compare because the response is a session cookie for a user
 * with a shell in their own home directory -- the highest-value credential this
 * process can mint.
 */

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])

const tokenMatches = (a: string, b: string): boolean => {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

const isLoopback = (request: HttpServerRequest.HttpServerRequest): boolean => {
  const address = request.remoteAddress
  // A peer we cannot identify is not a peer we trust.
  if (address === undefined || Option.isNone(address)) return false
  return LOOPBACK.has(address.value)
}

export const LauncherRoutesLive = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const config = yield* EvieConfig
    const expected = process.env["EVIE_LAUNCHER_TOKEN"]
    if (expected === undefined || expected.length === 0 || config.mode !== "local") return

    const auth = yield* Auth

    yield* router.add(
      "POST",
      "/internal/launcher/claim",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const header = request.headers["authorization"] ?? ""
        const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : ""
        if (!isLoopback(request) || !tokenMatches(presented, expected)) {
          return HttpServerResponse.empty({ status: 404 })
        }
        const userId = yield* auth.claim.ensureLocalOwner
        const { token, expiresAt } = auth.claim.mint(userId)
        return yield* HttpServerResponse.json({
          url: `http://127.0.0.1:${config.port}/?claim=${token}`,
          expiresAt,
        })
      }).pipe(
        // The launcher falls back to loading the bare origin, so a database
        // hiccup here costs a sign-in prompt, never the window.
        Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 503 }))),
      ),
    )
  }),
)
