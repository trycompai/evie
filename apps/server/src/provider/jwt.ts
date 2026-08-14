import { createHmac } from "node:crypto"
import type { Actor } from "../domain/state.ts"

/**
 * The per-turn HS256 JWT Evie sends to a bot's eve runtime, naming the acting
 * organization member (05, "Carrying the member's identity"). The generated
 * `agent/channels/eve.ts` verifies it with eve's `verifyJwtHmac`, so member-
 * scoped connections resolve the caller's own credential.
 *
 * `node:crypto` only. Pulling in a JWT library for one sign call would add a
 * dependency to the most security-sensitive path in the server.
 */

/** Matches eve's `verifyJwtHmac` config in the generated channel: issuer + audience. */
export const JWT_ISSUER = "evie"

/**
 * Per-turn and short-lived. A dispatch happens immediately after minting, so a
 * leaked token is worth two minutes of one bot on loopback -- almost nothing.
 */
export const DEFAULT_TTL_SECONDS = 120

const base64url = (value: string): string => Buffer.from(value, "utf8").toString("base64url")

export interface MintTurnTokenInput {
  /** The audience: the runtime only accepts tokens minted for its own bot. */
  readonly botId: string
  /**
   * The runtime's spawn secret, exactly as it appears in the child's
   * `EVIE_RUNTIME_SECRET` env var. eve HMACs with the env string's bytes, so
   * the signer must use the same string -- never the raw bytes it encodes.
   */
  readonly secret: string
  /** The acting member. Resolved from the session, never from a payload. */
  readonly actor: Actor
  readonly ttlSeconds?: number
  /** Unix millis, injectable for tests. */
  readonly now?: number
}

export const mintTurnToken = (input: MintTurnTokenInput): string => {
  const issuedAt = Math.floor((input.now ?? Date.now()) / 1000)
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const payload = base64url(
    JSON.stringify({
      iss: JWT_ISSUER,
      aud: input.botId,
      sub: input.actor.userId,
      org: input.actor.orgId,
      role: input.actor.role,
      iat: issuedAt,
      exp: issuedAt + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS),
    }),
  )
  const signature = createHmac("sha256", input.secret)
    .update(`${header}.${payload}`)
    .digest("base64url")
  return `${header}.${payload}.${signature}`
}
