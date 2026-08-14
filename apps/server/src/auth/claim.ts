import { randomBytes, timingSafeEqual } from "node:crypto"
import { userInfo } from "node:os"
import type { BetterAuthPlugin } from "better-auth"
import { APIError, createAuthEndpoint } from "better-auth/api"
import { setSessionCookie } from "better-auth/cookies"
import * as z from "zod"
import type { EvieAuth } from "./instance.ts"

/**
 * Local mode's login: a one-time claim token instead of a password prompt.
 *
 * Why not just hand a session cookie to the first loopback request? Because
 * "first request wins" is a race anyone on the machine can enter: every other
 * process on the box can reach 127.0.0.1, and so can a page in the user's
 * browser -- any site the user happens to be visiting can fire requests at
 * localhost and beat the real client to that cookie. What the cookie guards is
 * an agent with a shell in the user's home directory, which makes it the
 * highest-value cookie on the machine. A one-time token in the URL that the
 * launcher itself opens closes the race for one line of UX -- the pattern
 * Jupyter and VS Code tunnels settled on for exactly this reason.
 *
 * The token is single-use, expires in 60 seconds, and lives only in this
 * process's memory: a restart mints a fresh one and the launcher opens
 * `http://127.0.0.1:<port>/?claim=<token>` again.
 */

const CLAIM_TTL_MS = 60_000

export interface ClaimTokens {
  /** Replaces any outstanding token. One slot: two launchers cannot both win. */
  readonly mint: (userId: string) => { token: string; expiresAt: number }
  /** Single-use: a hit clears the slot whether or not the caller keeps the cookie. */
  readonly redeem: (token: string) => string | null
}

const tokenMatches = (a: string, b: string): boolean => {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export const makeClaimTokens = (): ClaimTokens => {
  let slot: { token: string; userId: string; expiresAt: number } | null = null
  return {
    mint: (userId) => {
      slot = {
        token: randomBytes(32).toString("base64url"),
        userId,
        expiresAt: Date.now() + CLAIM_TTL_MS,
      }
      return { token: slot.token, expiresAt: slot.expiresAt }
    },
    redeem: (token) => {
      const current = slot
      slot = null
      if (current === null) return null
      if (Date.now() > current.expiresAt) return null
      return tokenMatches(token, current.token) ? current.userId : null
    },
  }
}

/**
 * `POST /api/auth/claim { token }` exchanges a live claim token for a session
 * cookie. Runs as a Better Auth plugin endpoint so the session row and cookie
 * are minted by Better Auth's own machinery, not a reimplementation of it.
 */
export const claimPlugin = (tokens: ClaimTokens) =>
  ({
    id: "evie-claim",
    endpoints: {
      claimSession: createAuthEndpoint(
        "/claim",
        { method: "POST", body: z.object({ token: z.string() }) },
        async (ctx) => {
          const userId = tokens.redeem(ctx.body.token)
          if (userId === null) {
            throw new APIError("UNAUTHORIZED", {
              message: "Claim token is invalid, expired, or already used",
            })
          }
          const user = await ctx.context.internalAdapter.findUserById(userId)
          if (!user) {
            throw new APIError("UNAUTHORIZED", { message: "Claimed user no longer exists" })
          }
          // The claimed session lands with its organization already active, so
          // the client's first `session.hello` needs no follow-up switch.
          const membership = await ctx.context.adapter.findOne<{ organizationId: string }>({
            model: "member",
            where: [{ field: "userId", value: userId }],
          })
          const session = await ctx.context.internalAdapter.createSession(userId, undefined, {
            activeOrganizationId: membership?.organizationId ?? null,
          })
          await setSessionCookie(ctx, { session, user })
          return ctx.json({ userId })
        },
      ),
    },
  }) satisfies BetterAuthPlugin

export type ClaimPlugin = ReturnType<typeof claimPlugin>

export interface OwnerBootstrapDeps {
  /** Earliest-created user id, or null when no one has ever existed here. */
  readonly firstUserId: () => Promise<string | null>
}

/**
 * First boot of a local-mode server: create the owner and their personal
 * organization, and return the user id a claim token should be minted for.
 * Every later boot finds the existing user and creates nothing.
 *
 * The generated password is thrown away -- local mode logs in by claim token,
 * and 05's first hard refusal keeps the server loopback-only until a real
 * credential replaces it. The personal organization is an ordinary org with
 * one owner, not a schema special case.
 */
export const ensureLocalOwner = async (
  auth: EvieAuth,
  deps: OwnerBootstrapDeps,
): Promise<string> => {
  const existing = await deps.firstUserId()
  if (existing !== null) return existing

  const signedUp = await auth.api.signUpEmail({
    body: {
      email: "owner@evie.local",
      password: randomBytes(24).toString("base64url"),
      name: userInfo().username || "Owner",
    },
  })
  const userId = signedUp.user.id
  // `userId` in the body is the server-only calling convention: no session
  // exists yet to attribute this to. The org hooks provision userdata/orgs/<id>.
  await auth.api.createOrganization({
    body: { name: "Personal", slug: "personal", userId },
  })
  return userId
}
