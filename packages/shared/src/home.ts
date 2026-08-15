import { homedir } from "node:os"
import { join, resolve } from "node:path"

/**
 * Evie home.
 *
 * ```
 * ~/.evie/                    or $EVIE_HOME
 *   userdata/
 *     state.sqlite            control plane + Better Auth tables (WAL)
 *     secrets.key             0600, AES-256-GCM key (desktop: OS keychain)
 *     blobs/                  content-addressed
 *     orgs/<orgId>/bots/<botId>/   a complete eve project
 *     msb/<version>/          microsandbox home (MSB_HOME), keyed by msb version
 *     settings.json
 *     desktop.log                 written by the Electron shell, not the server
 * ```
 *
 * `AGENTS.md` rule 2: `~/.evie/userdata` is the developer's real database, in
 * use while you work. A dev server started from a worktree writes to
 * `<worktree>/.evie`, never `~/.evie`. That is enforced by `EVIE_HOME` being
 * set in the worktree's dev script, and by `assertNotLiveInstall` below, which
 * is cheap insurance against the one mistake that costs someone their data.
 */

export interface EvieHome {
  readonly root: string
  readonly userdata: string
  readonly statePath: string
  readonly secretsKeyPath: string
  readonly blobsDir: string
  readonly orgsDir: string
  readonly settingsPath: string
}

export const resolveHome = (env: NodeJS.ProcessEnv = process.env): EvieHome => {
  const root = env.EVIE_HOME ? resolve(env.EVIE_HOME) : join(homedir(), ".evie")
  const userdata = join(root, "userdata")
  return {
    root,
    userdata,
    statePath: join(userdata, "state.sqlite"),
    secretsKeyPath: join(userdata, "secrets.key"),
    blobsDir: join(userdata, "blobs"),
    orgsDir: join(userdata, "orgs"),
    settingsPath: join(userdata, "settings.json"),
  }
}

export const orgDir = (home: EvieHome, orgId: string): string => join(home.orgsDir, orgId)

export const botDir = (home: EvieHome, orgId: string, botId: string): string =>
  join(orgDir(home, orgId), "bots", botId)

/**
 * Where a bot runtime's microsandbox keeps its VM database, image cache and
 * sockets (`MSB_HOME`). Evie-owned rather than the machine-global
 * `~/.microsandbox`, which anything else on the box may have migrated to a
 * schema this environment's msb refuses to open. Keyed by msb version for the
 * same reason one directory in: msb aborts on a database migrated by a
 * different version, so a version bump gets a fresh home instead of a corrupt
 * shared one. Kept short -- msb creates unix sockets under it, and
 * `sun_path` caps the whole socket path at ~104 bytes on macOS.
 */
export const msbHome = (home: EvieHome, msbVersion: string): string =>
  join(home.userdata, "msb", msbVersion)

/** Content-addressed: `blobs/ab/cd/abcd…`. Two levels keeps any one dir small. */
export const blobPath = (home: EvieHome, hash: string): string =>
  join(home.blobsDir, hash.slice(0, 2), hash.slice(2, 4), hash)

/**
 * Refuses to open the developer's real install from a worktree.
 *
 * A second server against `~/.evie/userdata` is not a slow test, it is a
 * corrupted database and a stranger's agent process attached to somebody's
 * live threads. `EVIE_ALLOW_LIVE_HOME` exists so the shipped app -- which *is*
 * the live install -- can say so explicitly.
 */
export const assertNotLiveInstall = (home: EvieHome, env: NodeJS.ProcessEnv = process.env): void => {
  if (env.EVIE_ALLOW_LIVE_HOME === "1") return
  const live = join(homedir(), ".evie")
  if (home.root === live) {
    throw new Error(
      `Refusing to start against the live install at ${live}. ` +
        `Set EVIE_HOME to a worktree-local directory, or EVIE_ALLOW_LIVE_HOME=1 if this is the shipped app.`,
    )
  }
}
