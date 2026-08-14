import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { existsSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { Effect, Layer } from "effect"
import type { PlatformError } from "effect/PlatformError"
import type { FileSystem } from "effect/FileSystem"
import type { Path } from "effect/Path"
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpStaticServer,
  type HttpPlatform,
} from "effect/unstable/http"
import { EvieConfig } from "../config.ts"
import { Db } from "../db/Db.ts"
import { Auth } from "./middleware.ts"

/**
 * The plain-HTTP routes on the one exposed port: Better Auth, blob fetches,
 * liveness, and (packaged builds) the web app's static assets. Everything else
 * is the `/rpc` WebSocket, mounted by `Gateway.ts` on the same router.
 */

/* --- blob grants -------------------------------------------------------------
 * `blobs.grant` mints a short-lived HMAC token binding (blobId, orgId, expiry);
 * `GET /blob/:id` verifies it and re-checks `blob_ref` for that organization.
 * A content hash is guessable, so knowing the id is never the authorization --
 * the org identity was established over the authenticated RPC socket at grant
 * time and travels inside the signature, which is what keeps the fetch working
 * for clients whose image loads carry no cookie (desktop bearer flows).
 *
 * The key is per-process: a grant is a 60-second pointer, not a durable
 * credential, so grants dying with the process is correct. */

const blobTokenKey = randomBytes(32)

export const BLOB_TOKEN_TTL_MILLIS = 60_000

const blobSignature = (blobId: string, orgId: string, expiresAt: number): string =>
  createHmac("sha256", blobTokenKey).update(`${blobId}\n${orgId}\n${expiresAt}`).digest("base64url")

/** Mints the signed URL `blobs.grant` returns. Relative, so it works on every surface. */
export const grantBlobUrl = (
  blobId: string,
  orgId: string,
): { readonly url: string; readonly expiresAt: number } => {
  const expiresAt = Date.now() + BLOB_TOKEN_TTL_MILLIS
  const sig = blobSignature(blobId, orgId, expiresAt)
  const url = `/blob/${encodeURIComponent(blobId)}?org=${encodeURIComponent(orgId)}&exp=${expiresAt}&sig=${sig}`
  return { url, expiresAt }
}

const verifyBlobToken = (blobId: string, orgId: string, expiresAt: number, sig: string): boolean => {
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false
  const expected = Buffer.from(blobSignature(blobId, orgId, expiresAt))
  const received = Buffer.from(sig)
  return expected.length === received.length && timingSafeEqual(expected, received)
}

/* --- routes ------------------------------------------------------------------ */

export const HttpRoutesLive = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const auth = yield* Auth
    const db = yield* Db
    const config = yield* EvieConfig
    const sql = db.sql

    yield* router.add("GET", "/health", HttpServerResponse.json({ status: "ok" }))

    // Better Auth speaks fetch; convert the server request both ways around it.
    yield* router.add("*", "/api/auth/*", (request) =>
      Effect.gen(function* () {
        const webRequest = yield* HttpServerRequest.toWeb(request)
        const webResponse = yield* Effect.tryPromise(() => auth.handler(webRequest))
        return HttpServerResponse.fromWeb(webResponse)
      }).pipe(
        // A body that cannot convert is the caller's fault; a rejecting
        // handler is ours. Neither is allowed to take the route down.
        Effect.catch((error) =>
          Effect.succeed(
            HttpServerResponse.empty({ status: error._tag === "UnknownError" ? 500 : 400 }),
          ),
        ),
      ),
    )

    yield* router.add(
      "GET",
      "/blob/:id",
      Effect.gen(function* () {
        const params = yield* HttpRouter.params
        const request = yield* HttpServerRequest.HttpServerRequest
        const id = params["id"]
        const query = new URL(request.url, "http://evie.invalid").searchParams
        const orgId = query.get("org")
        const expiresAt = Number(query.get("exp"))
        const sig = query.get("sig")
        if (id === undefined || orgId === null || sig === null || !verifyBlobToken(id, orgId, expiresAt, sig)) {
          return HttpServerResponse.empty({ status: 403 })
        }
        // The signature is necessary, the `blob_ref` row is sufficient: a
        // reference dropped since the grant revokes the fetch too.
        const rows = yield* sql<{ path: string; media_type: string }>`
          select b.path, b.media_type from blob b
          join blob_ref r on r.blob_id = b.id
          where b.id = ${id} and r.org_id = ${orgId}`
        const row = rows[0]
        if (row === undefined) return HttpServerResponse.empty({ status: 404 })
        const path = isAbsolute(row.path) ? row.path : join(config.home.userdata, row.path)
        return yield* HttpServerResponse.file(path, {
          contentType: row.media_type,
          headers: { "cache-control": "private, max-age=60" },
        })
      }).pipe(
        // A busy database is a 503; a blob row pointing at a missing file is
        // a 404. Neither is allowed to crash the route.
        Effect.catch((error) =>
          Effect.succeed(
            HttpServerResponse.empty({ status: error._tag === "SqlError" ? 503 : 404 }),
          ),
        ),
      ),
    )
  }),
)

/**
 * Static assets for packaged builds: the desktop app and `npx evie` point
 * `EVIE_WEB_DIST` at the built web app and get an SPA fallback. A dev worktree
 * has no dist and mounts nothing -- Vite owns the assets there.
 */
export const StaticAssetsLive: Layer.Layer<
  never,
  PlatformError,
  HttpRouter.HttpRouter | FileSystem | Path | HttpPlatform.HttpPlatform
> = Layer.unwrap(
  Effect.sync(() => {
    const dist = process.env["EVIE_WEB_DIST"]
    return dist !== undefined && existsSync(dist)
      ? HttpStaticServer.layer({ root: dist, spa: true })
      : Layer.empty
  }),
)
