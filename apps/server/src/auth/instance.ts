import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"
import { passkey } from "@better-auth/passkey"
import type { Permission } from "@evie/contracts/org"
import { Permission as PermissionSchema } from "@evie/contracts/org"
import type { MemberRole } from "@evie/contracts/org"
import { type EvieHome, orgDir } from "@evie/shared/home"
import { betterAuth } from "better-auth"
import { createAccessControl } from "better-auth/plugins/access"
import { bearer } from "better-auth/plugins/bearer"
import { organization } from "better-auth/plugins/organization"
import { adminAc, defaultStatements, memberAc, ownerAc } from "better-auth/plugins/organization/access"
import type { EvieConfigShape } from "../config.ts"
import type { EvieKyselyDialect } from "../db/kysely-dialect.ts"
import { claimPlugin, type ClaimTokens } from "./claim.ts"

/**
 * The `betterAuth()` instance and everything pure around it: Evie's access
 * control, the derived URLs, the generated server secret, and the org-home
 * filesystem hooks. The Effect wiring lives in `Auth.ts`; this module has no
 * Effect in it so the access-control tables stay importable by tests.
 *
 * (Named `instance.ts` rather than the spec's `auth.ts` because this repo is
 * developed on case-insensitive filesystems, where `auth.ts` and `Auth.ts`
 * are the same file.)
 */

/* --- access control -------------------------------------------------------- */

/**
 * Evie's permission statements layered on Better Auth's organization defaults.
 * The strings in `@evie/contracts/org`'s `Permission` are `resource:action`
 * over exactly these resources; `permissionStatement` is the bridge.
 *
 * `member` extends Better Auth's own `member` resource rather than replacing
 * it -- clobbering it would silently strip invite/remove rights from the
 * default role statements.
 */
const statement = {
  ...defaultStatements,
  member: [...defaultStatements.member, "manage"],
  bot: ["create", "read", "update", "delete"],
  thread: ["read", "write"],
  routine: ["manage"],
  connection: ["manage", "link"],
  secret: ["manage"],
  settings: ["manage"],
  org: ["delete"],
} as const

export const ac = createAccessControl(statement)

/** The 05 permission table, one row per role. Owner alone may delete the org. */
export const owner = ac.newRole({
  ...ownerAc.statements,
  member: ["create", "update", "delete", "manage"],
  bot: ["create", "read", "update", "delete"],
  thread: ["read", "write"],
  routine: ["manage"],
  connection: ["manage", "link"],
  secret: ["manage"],
  settings: ["manage"],
  org: ["delete"],
})

export const admin = ac.newRole({
  ...adminAc.statements,
  member: ["create", "update", "delete", "manage"],
  bot: ["create", "read", "update", "delete"],
  thread: ["read", "write"],
  routine: ["manage"],
  connection: ["manage", "link"],
  secret: ["manage"],
  settings: ["manage"],
})

export const member = ac.newRole({
  ...memberAc.statements,
  bot: ["read"],
  thread: ["read", "write"],
  connection: ["link"],
})

export const roles = { owner, admin, member }

/** `"bot:create"` -> `{ bot: ["create"] }`, the shape Better Auth authorizes. */
export const permissionStatement = (permission: Permission) => {
  const at = permission.indexOf(":")
  return { [permission.slice(0, at)]: [permission.slice(at + 1)] }
}

/**
 * The server-side gate, on the same role objects the `organization()` plugin
 * is configured with -- the RPC middleware and the HTTP endpoints cannot
 * disagree. Pure because custom roles (`dynamicAccessControl`) are
 * deliberately off; turning them on would move this behind a database read.
 */
export const roleHasPermission = (role: MemberRole, permission: Permission): boolean =>
  roles[role].authorize(permissionStatement(permission)).success

/** `SessionInfo.permissions` for a role, derived from the role statements above. */
export const permissionsFor = (role: MemberRole): ReadonlyArray<Permission> =>
  PermissionSchema.literals.filter((permission) => roleHasPermission(role, permission))

/* --- derived config -------------------------------------------------------- */

/**
 * `BETTER_AUTH_URL` equivalents, derived from the bind and mode rather than
 * asked for. `lan` uses the mDNS name because that is the URL a phone on the
 * same network actually types; `tunnel` treats the explicit bind host as the
 * name the tunnel fronts, where TLS terminates.
 */
export const deriveBaseURL = (config: EvieConfigShape): string => {
  switch (config.mode) {
    case "local":
      return `http://127.0.0.1:${config.port}`
    case "lan": {
      // macOS hostname() already ends in ".local"; append only when it doesn't.
      const host = hostname().replace(/\.local$/, "")
      return `http://${host}.local:${config.port}`
    }
    case "tunnel":
      return `https://${config.bind}`
  }
}

export const deriveTrustedOrigins = (config: EvieConfigShape): Array<string> => {
  const loopback = [`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`]
  return config.mode === "local" ? loopback : [...loopback, deriveBaseURL(config)]
}

/* --- server secret ---------------------------------------------------------- */

/**
 * `BETTER_AUTH_SECRET` is generated, not demanded: asking a desktop user to
 * set an env var would be absurd. First boot writes 32 random bytes to Evie
 * home at 0600; every boot after that reads them back. The `wx` flag makes
 * creation race-safe -- a concurrent second creator loses and reads instead.
 */
export const loadOrCreateAuthSecret = (home: EvieHome): string => {
  const path = join(home.userdata, "auth.secret")
  mkdirSync(home.userdata, { recursive: true })
  try {
    writeFileSync(path, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  return readFileSync(path, "utf8").trim()
}

/* --- org home hooks ---------------------------------------------------------- */

export const provisionOrgHome = (home: EvieHome, orgId: string): void => {
  mkdirSync(join(orgDir(home, orgId), "bots"), { recursive: true })
}

/**
 * Deleting an organization archives its directory -- bots, checkpoints, all of
 * it -- by rename, never a silent `rm -rf` of someone's agents. Restoring is a
 * rename back; cleanup is a human decision.
 */
export const archiveOrgHome = (home: EvieHome, orgId: string): void => {
  const dir = orgDir(home, orgId)
  if (!existsSync(dir)) return
  renameSync(dir, `${dir}.archived-${Date.now()}`)
}

/* --- the instance ------------------------------------------------------------ */

export interface EvieAuthDeps {
  readonly config: EvieConfigShape
  /** Executes through the one connection `Db` owns. See `db/kysely-dialect.ts`. */
  readonly dialect: EvieKyselyDialect
  readonly secret: string
  /** Local mode's one-time claim tokens. The plugin mounts `/api/auth/claim`. */
  readonly claimTokens: ClaimTokens
}

export const createEvieAuth = (deps: EvieAuthDeps) => {
  const { config } = deps
  return betterAuth({
    appName: "Evie",
    baseURL: deriveBaseURL(config),
    secret: deps.secret,
    trustedOrigins: deriveTrustedOrigins(config),
    // NOT `new DatabaseSync(statePath)` -- that would be a second writer on
    // state.sqlite. `transaction: false` is load-bearing: the shared dialect
    // refuses transactions (see kysely-dialect.ts).
    database: { dialect: deps.dialect, type: "sqlite", transaction: false },
    emailAndPassword: { enabled: true },
    session: {
      // Local mode is the owner's own machine; 30 days. Anything reachable
      // over a network re-authenticates weekly.
      expiresIn: config.mode === "local" ? 60 * 60 * 24 * 30 : 60 * 60 * 24 * 7,
      cookieCache: { enabled: true },
    },
    advanced: {
      // Only the tunnel mode has TLS in front of it. `lan` is plain http on
      // a trusted network; secure cookies there would just never be sent.
      useSecureCookies: config.mode === "tunnel",
    },
    plugins: [
      organization({
        ac,
        roles,
        teams: { enabled: true, maximumTeams: 20 },
        allowUserToCreateOrganization: true,
        // No SMTP in a self-hosted environment: invitations are share links
        // built from `createInvitation`'s id, so no `sendInvitationEmail`.
        invitationExpiresIn: 60 * 60 * 24 * 7,
        cancelPendingInvitationsOnReInvite: true,
        organizationHooks: {
          afterCreateOrganization: async ({ organization: org }) => {
            provisionOrgHome(config.home, org.id)
          },
          beforeDeleteOrganization: async ({ organization: org }) => {
            archiveOrgHome(config.home, org.id)
          },
        },
      }),
      bearer(),
      // Present in every mode; the UI offers passkeys only where WebAuthn can
      // exist (local and tunnel -- browsers exempt localhost, nothing else).
      passkey({ rpName: "Evie" }),
      claimPlugin(deps.claimTokens),
    ],
  })
}

export type EvieAuth = ReturnType<typeof createEvieAuth>
