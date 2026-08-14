import {
  Forbidden,
  InvalidCommand,
  NotFound,
  StorageUnavailable,
  Unauthenticated,
} from "@evie/contracts/errors"
import {
  InvitationRevoked,
  MemberInvited,
  MemberRemoved,
  MemberRoleChanged,
  TeamCreated,
  TeamDeleted,
} from "@evie/contracts/events"
import { OrgId, TeamId } from "@evie/contracts/ids"
import { MemberRole, Permission, type Organization } from "@evie/contracts/org"
import { APIError } from "better-auth/api"
import { Effect, Layer, Schema } from "effect"
import type { Headers as EffectHeaders } from "effect/unstable/http/Headers"
import { Db } from "../db/Db.ts"
import type { Actor } from "../domain/state.ts"
import {
  Auth as GatewayAuth,
  type AuthShape as GatewayAuthShape,
  type OrgCommand,
  type OrgCommandResult,
} from "../gateway/middleware.ts"
import { Auth } from "./Auth.ts"
import { permissionsFor } from "./instance.ts"

/**
 * Adapts the auth module (`auth/Auth.ts`, which owns Better Auth) to the
 * `gateway/Auth` seam the RPC middleware and handlers consume. Written by
 * composition: the two halves were built in parallel against different
 * signatures, and this file is where they meet instead of either one bending.
 */

/** Effect's header record, as the fetch-shaped headers Better Auth reads. */
const toWebHeaders = (headers: EffectHeaders): Headers => new Headers(Object.entries(headers))

const decodeTeamId = Schema.decodeUnknownSync(TeamId)
const decodeOrgId = Schema.decodeUnknownSync(OrgId)
const decodeRole = Schema.decodeUnknownSync(MemberRole)
const isPermission = Schema.is(Permission)

/**
 * Better Auth's HTTP-shaped refusals, as the typed errors the org-command
 * channel declares. Anything that is not an `APIError` is a defect.
 */
const orgApiError = (
  error: unknown,
): Unauthenticated | Forbidden | NotFound | InvalidCommand | StorageUnavailable => {
  if (error instanceof APIError) {
    switch (error.status) {
      case "UNAUTHORIZED":
        return new Unauthenticated()
      case "FORBIDDEN":
        return new Forbidden({ permission: "member:manage" })
      case "NOT_FOUND":
        return new NotFound({ resource: "organization", id: "" })
      default:
        return new InvalidCommand({ reason: error.message })
    }
  }
  throw error
}

const make = Effect.gen(function* () {
  const impl = yield* Auth
  const db = yield* Db
  const api = impl.instance.api

  const resolveActor: GatewayAuthShape["resolveActor"] = (headers) =>
    impl.resolveActor(toWebHeaders(headers))

  const memberCount: GatewayAuthShape["memberCount"] = (orgId) =>
    db
      .execute(`select count(*) as n from "member" where "organizationId" = ?`, [orgId])
      .pipe(
        Effect.map((rows) => Number(rows[0]?.n ?? 0)),
        Effect.mapError((error) => new StorageUnavailable({ reason: error.message })),
      )

  const roleIn = Effect.fn("gatewayAuth.roleIn")(function* (orgId: string, userId: string) {
    const rows = yield* db
      .execute(`select "role" from "member" where "organizationId" = ? and "userId" = ?`, [
        orgId,
        userId,
      ])
      .pipe(Effect.mapError((error) => new StorageUnavailable({ reason: error.message })))
    const role = rows[0]?.role
    return typeof role === "string" ? decodeRole(role) : null
  })

  const sessionInfo: GatewayAuthShape["sessionInfo"] = Effect.fn("gatewayAuth.sessionInfo")(
    function* (headers) {
      const web = toWebHeaders(headers)
      const actor = yield* impl.resolveActor(web)
      const listed = yield* Effect.tryPromise({
        try: () => api.listOrganizations({ headers: web }),
        catch: (error) => new StorageUnavailable({ reason: String(error) }),
      })
      const counts = new Map<string, number>()
      if (listed.length > 0) {
        const placeholders = listed.map(() => "?").join(", ")
        const rows = yield* db
          .execute(
            `select "organizationId" as org_id, count(*) as n from "member"
             where "organizationId" in (${placeholders}) group by "organizationId"`,
            listed.map((org) => org.id),
          )
          .pipe(Effect.mapError((error) => new StorageUnavailable({ reason: error.message })))
        for (const row of rows) counts.set(String(row.org_id), Number(row.n))
      }
      const organizations = listed.map(
        (org): Organization => ({
          id: decodeOrgId(org.id),
          name: org.name,
          slug: org.slug ?? "",
          logo: org.logo ?? null,
          memberCount: counts.get(org.id) ?? 1,
        }),
      )
      return {
        userId: actor.userId,
        orgId: actor.orgId,
        role: actor.role,
        permissions: permissionsFor(actor.role),
        organizations,
      }
    },
  )

  const hasPermission: GatewayAuthShape["hasPermission"] = Effect.fn("gatewayAuth.hasPermission")(
    function* (headers, permission) {
      const actor = yield* resolveActor(headers)
      // An unknown permission string is a contract drift, not an authorization.
      if (!isPermission(permission)) return false
      return yield* impl.hasPermission(actor, permission)
    },
  )

  const memberIdOf = Effect.fn("gatewayAuth.memberIdOf")(function* (orgId: string, userId: string) {
    const rows = yield* db
      .execute(`select "id" from "member" where "organizationId" = ? and "userId" = ?`, [
        orgId,
        userId,
      ])
      .pipe(Effect.mapError((error) => new StorageUnavailable({ reason: error.message })))
    const id = rows[0]?.id
    if (typeof id !== "string") return yield* new NotFound({ resource: "member", id: userId })
    return id
  })

  const executeOrgCommand: GatewayAuthShape["executeOrgCommand"] = Effect.fn(
    "gatewayAuth.executeOrgCommand",
  )(function* (command: OrgCommand, headers: EffectHeaders) {
    const web = toWebHeaders(headers)
    const call = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: orgApiError })

    switch (command._tag) {
      case "InviteMember": {
        const invitation = yield* call(() =>
          api.createInvitation({
            headers: web,
            body: {
              email: command.email,
              role: command.role,
              ...(command.teamId !== undefined ? { teamId: command.teamId } : {}),
            },
          }),
        )
        return {
          event: MemberInvited.make({
            invitationId: invitation.id,
            email: command.email,
            role: command.role,
          }),
          resourceId: invitation.id,
        } satisfies OrgCommandResult
      }
      case "RevokeInvitation": {
        yield* call(() =>
          api.cancelInvitation({ headers: web, body: { invitationId: command.invitationId } }),
        )
        return { event: InvitationRevoked.make({ invitationId: command.invitationId }) }
      }
      case "SetMemberRole": {
        const actor = yield* resolveActor(headers)
        const memberId = yield* memberIdOf(actor.orgId, command.userId)
        yield* call(() =>
          api.updateMemberRole({ headers: web, body: { memberId, role: command.role } }),
        )
        return { event: MemberRoleChanged.make({ userId: command.userId, role: command.role }) }
      }
      case "RemoveMember": {
        const actor = yield* resolveActor(headers)
        const memberId = yield* memberIdOf(actor.orgId, command.userId)
        yield* call(() =>
          api.removeMember({ headers: web, body: { memberIdOrEmail: memberId } }),
        )
        return { event: MemberRemoved.make({ userId: command.userId }) }
      }
      case "CreateTeam": {
        const team = yield* call(() =>
          api.createTeam({ headers: web, body: { name: command.name } }),
        )
        return {
          event: TeamCreated.make({ teamId: decodeTeamId(team.id), name: command.name }),
          resourceId: team.id,
        }
      }
      case "DeleteTeam": {
        yield* call(() => api.removeTeam({ headers: web, body: { teamId: command.teamId } }))
        return { event: TeamDeleted.make({ teamId: command.teamId }) }
      }
      case "SetActiveOrg": {
        const before = yield* resolveActor(headers)
        const orgId = decodeOrgId(command.orgId)
        yield* impl.setActiveOrg(web, orgId)
        // Re-read the role directly: the session cookie cache can serve the
        // old active org for minutes, and the connection must switch now.
        const role = yield* roleIn(orgId, before.userId)
        if (role === null) return yield* new NotFound({ resource: "organization", id: orgId })
        const actor: Actor = { userId: before.userId, orgId, role }
        return { event: null, actor }
      }
    }
  })

  return {
    handler: impl.instance.handler,
    resolveActor,
    sessionInfo,
    hasPermission,
    memberCount,
    members: (headers) =>
      impl.members(toWebHeaders(headers)).pipe(
        Effect.mapError((error) =>
          error._tag === "Unauthenticated"
            ? error
            : new StorageUnavailable({ reason: error.reason }),
        ),
      ),
    executeOrgCommand,
  } satisfies GatewayAuthShape
})

/** The gateway's `Auth` seam, implemented over the auth module. */
export const GatewayAuthLive = Layer.effect(GatewayAuth, make)
