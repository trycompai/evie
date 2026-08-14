import type { Command } from "@evie/contracts/commands"
import { permissionOf } from "@evie/contracts/commands"
import {
  ContractMismatch,
  EvieError,
  type Forbidden as ForbiddenError,
  Forbidden,
  HandshakeRequired,
  type InvalidCommand,
  type NotFound,
  type PolicyViolation,
  type StorageUnavailable,
  type Unauthenticated,
} from "@evie/contracts/errors"
import type { EvieEvent } from "@evie/contracts/events"
import type { OrgId, ThreadId } from "@evie/contracts/ids"
import type { Invitation, Member, SessionInfo, Team } from "@evie/contracts/org"
import { EvieRpc } from "@evie/contracts/rpc"
import { CONTRACT_VERSION } from "@evie/contracts/version"
import { Context, Effect, Layer, Option } from "effect"
import type { Headers } from "effect/unstable/http/Headers"
import { RpcMiddleware } from "effect/unstable/rpc"
import type { Actor } from "../domain/state.ts"

/**
 * The connection-scoped middleware every RPC passes through. Three checks live
 * here and nowhere else -- the version handshake, actor resolution, and
 * `hasPermission` -- because retrofitting any of them under a dozen handlers
 * later is exactly the work this ordering exists to avoid.
 */

/* --- the Auth seam ---------------------------------------------------------
 * The gateway consumes Better Auth through this service; the auth module owns
 * the implementation (sessions, the organization plugin, permission checks).
 * Everything session-shaped resolves from headers -- the WebSocket upgrade
 * request's cookie / bearer header is prepended to every RPC request's
 * headers by the protocol layer, so the session travels with each call. */

/** The organization commands. They delegate to Better Auth, never the decider. */
export type OrgCommand = Extract<
  Command,
  {
    _tag:
      | "InviteMember"
      | "RevokeInvitation"
      | "SetMemberRole"
      | "RemoveMember"
      | "CreateTeam"
      | "DeleteTeam"
      | "SetActiveOrg"
  }
>

export interface OrgCommandResult {
  /** The product event recording what Better Auth did. Null when nothing belongs in the log (`SetActiveOrg`). */
  readonly event: EvieEvent | null
  /** The thing the command created, when the caller now needs to address it. */
  readonly resourceId?: string
  /** Present when the command changed the session's active organization. */
  readonly actor?: Actor
}

export interface AuthShape {
  /** Better Auth's fetch handler. The gateway mounts it at `/api/auth/*`. */
  readonly handler: (request: Request) => Promise<Response>
  /** The acting member -- user, ACTIVE org, role -- from the session. Never from a payload. */
  readonly resolveActor: (headers: Headers) => Effect.Effect<Actor, Unauthenticated>
  /** Everything `session.hello` returns except what the gateway owns (version, mode). */
  readonly sessionInfo: (
    headers: Headers,
  ) => Effect.Effect<Omit<SessionInfo, "contractVersion" | "mode">, Unauthenticated | StorageUnavailable>
  /** `auth.api.hasPermission` against the session's active organization. */
  readonly hasPermission: (
    headers: Headers,
    permission: string,
  ) => Effect.Effect<boolean, Unauthenticated | StorageUnavailable>
  /** Member count of an organization. The decider's `just-bash` policy reads it. */
  readonly memberCount: (orgId: OrgId) => Effect.Effect<number, StorageUnavailable>
  /** The `org.members` read model. */
  readonly members: (headers: Headers) => Effect.Effect<
    {
      readonly members: ReadonlyArray<Member>
      readonly invitations: ReadonlyArray<Invitation>
      readonly teams: ReadonlyArray<Team>
    },
    Unauthenticated | StorageUnavailable
  >
  /**
   * Performs one organization command against Better Auth and returns the
   * product event to append. Not idempotent -- the caller must run it exactly
   * once per command, outside any append retry.
   */
  readonly executeOrgCommand: (
    command: OrgCommand,
    headers: Headers,
  ) => Effect.Effect<
    OrgCommandResult,
    Unauthenticated | ForbiddenError | NotFound | InvalidCommand | PolicyViolation | StorageUnavailable
  >
}

/**
 * Keyed `gateway/Auth`, not `Auth`: the implementation service in
 * `auth/Auth.ts` already owns that key, and both live in the same context.
 * `auth/gateway-auth.ts` adapts one to the other.
 */
export class Auth extends Context.Service<Auth, AuthShape>()("gateway/Auth") {}

/* --- per-connection state --------------------------------------------------
 * Annotated onto the RpcServer's per-connection `ServerClient` at handshake,
 * so it lives exactly as long as the socket and is GC'd with it. */

export interface ConnectionStateShape {
  /** Mutable: `SetActiveOrg` swaps it for the rest of the connection. */
  actor: Actor
  /** `${threadId}/${itemId}` reasoning blocks this connection expanded. Read live by the hub. */
  readonly watchedReasoning: Set<string>
  /** From `presence.set`. What idle-stop and subscription lifecycle consult. */
  openThreads: ReadonlyArray<ThreadId>
}

export class ConnectionState extends Context.Service<ConnectionState, ConnectionStateShape>()(
  "gateway/ConnectionState",
) {}

/* --- the middleware -------------------------------------------------------- */

export class RpcAuth extends RpcMiddleware.Service<RpcAuth, { provides: ConnectionState }>()(
  "gateway/RpcAuth",
  { error: EvieError, requiredForClient: false },
) {}

/** `EvieRpc` with the middleware attached to every RPC, `session.hello` included. */
export const EvieRpcAuthed = EvieRpc.middleware(RpcAuth)

export const RpcAuthLive = Layer.effect(RpcAuth)(
  Effect.gen(function* () {
    const auth = yield* Auth

    const middleware: RpcMiddleware.RpcMiddleware<ConnectionState, EvieError, never> = (
      effect,
      options,
    ) =>
      Effect.gen(function* () {
        const existing = Context.getOption(options.client.annotations, ConnectionState)

        if (options.rpc._tag === "session.hello") {
          // The version check happens before auth: an outdated client gets
          // "update Evie", not a sign-in prompt it cannot get past.
          const { contractVersion } = options.payload as { contractVersion: number }
          if (contractVersion !== CONTRACT_VERSION) {
            return yield* new ContractMismatch({ client: contractVersion, server: CONTRACT_VERSION })
          }
          const actor = yield* auth.resolveActor(options.headers)
          const state = Option.match(existing, {
            // A repeated hello re-resolves the actor but keeps the watches.
            onNone: (): ConnectionStateShape => ({
              actor,
              watchedReasoning: new Set<string>(),
              openThreads: [],
            }),
            onSome: (state) => {
              state.actor = actor
              return state
            },
          })
          options.client.annotate(ConnectionState, state)
          return yield* Effect.provideService(effect, ConnectionState, state)
        }

        if (Option.isNone(existing)) return yield* new HandshakeRequired()
        const state = existing.value

        if (options.rpc._tag === "command") {
          const { command } = options.payload as { command: Command }
          const permission = permissionOf(command)
          /*
           * `null` means no permission in the CURRENT organization gates this
           * command -- today only `SetActiveOrg`, which targets a different
           * org, so asking `hasPermission` here would answer the wrong
           * question. The handler verifies membership of the target instead.
           * Handled explicitly rather than defaulted, so a future `null`
           * cannot slip through as "allowed" by accident.
           */
          if (permission !== null) {
            const allowed = yield* auth.hasPermission(options.headers, permission)
            if (!allowed) return yield* new Forbidden({ permission })
          }
        }

        return yield* Effect.provideService(effect, ConnectionState, state)
      })

    return middleware
  }),
)
