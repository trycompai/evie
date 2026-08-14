import { Schema } from "effect"
import { Millis, OrgId, TeamId, UserId } from "./ids.ts"

/**
 * Organizations, members, and teams -- the read models over Better Auth's
 * tables. Evie is multi-tenant from the first migration; `local` mode is an
 * ordinary organization with one member, which is why turning teams on later
 * is a UI change rather than a migration.
 */

/**
 * Three roles, deliberately. Custom roles via `dynamicAccessControl` stay off:
 * "a few people share an Evie box" is covered, and every extra role is another
 * way to get the sandbox threat model wrong.
 */
export const MemberRole = Schema.Literals(["owner", "admin", "member"])
export type MemberRole = typeof MemberRole.Type

/**
 * Evie's permission statements, layered on Better Auth's defaults. Checks run
 * server-side in RPC middleware through `auth.api.hasPermission`, before the
 * command reaches the decider. The client-side equivalent greys out a control
 * and is never the gate.
 */
export const Permission = Schema.Literals([
  "bot:create",
  "bot:read",
  "bot:update",
  "bot:delete",
  "thread:read",
  "thread:write",
  "routine:manage",
  "connection:manage",
  /** Authorize your own member-scoped credential. The one write a member holds. */
  "connection:link",
  "secret:manage",
  "settings:manage",
  "member:manage",
  "org:delete",
])
export type Permission = typeof Permission.Type

export const Member = Schema.Struct({
  userId: UserId,
  name: Schema.String,
  email: Schema.String,
  image: Schema.NullOr(Schema.String),
  role: MemberRole,
  teamIds: Schema.Array(TeamId),
  joinedAt: Millis,
})
export type Member = typeof Member.Type

export const Team = Schema.Struct({
  id: TeamId,
  name: Schema.String,
  createdAt: Millis,
})
export type Team = typeof Team.Type

export const Invitation = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  role: MemberRole,
  teamId: Schema.NullOr(TeamId),
  status: Schema.Literals(["pending", "accepted", "rejected", "canceled"]),
  expiresAt: Millis,
  invitedBy: UserId,
})
export type Invitation = typeof Invitation.Type

export const Organization = Schema.Struct({
  id: OrgId,
  name: Schema.String,
  slug: Schema.String,
  logo: Schema.NullOr(Schema.String),
  memberCount: Schema.Int,
})
export type Organization = typeof Organization.Type

/**
 * How the server is bound. A property of the process, not a setting a user can
 * get wrong -- and the thing that decides whether passkeys are even offered.
 */
export const ConnectionMode = Schema.Literals(["local", "lan", "tunnel"])
export type ConnectionMode = typeof ConnectionMode.Type

/**
 * What `session.hello` returns. Everything the client needs before its first
 * render: who it is, where it is, and what it is allowed to draw.
 */
export const SessionInfo = Schema.Struct({
  contractVersion: Schema.Number,
  userId: UserId,
  orgId: OrgId,
  role: MemberRole,
  permissions: Schema.Array(Permission),
  mode: ConnectionMode,
  /**
   * The rail hides the org switcher entirely at one organization, which is the
   * common case and should not cost a control.
   */
  organizations: Schema.Array(Organization),
})
export type SessionInfo = typeof SessionInfo.Type
