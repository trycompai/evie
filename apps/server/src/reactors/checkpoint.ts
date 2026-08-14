import { execFile } from "node:child_process"
import { rmSync } from "node:fs"
import { join } from "node:path"
import type { RuntimeUnavailable } from "@evie/contracts/errors"
import { CheckpointWritten, type StoredEvent } from "@evie/contracts/events"
import type { BotId, ThreadId } from "@evie/contracts/ids"
import { Context, Effect, Option, Schema } from "effect"
import type { SqlError } from "effect/unstable/sql/SqlError"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { EventStore } from "../store/EventStore.ts"
import { deriveUlid, reactorLayer, type Commit } from "./runtime.ts"

/**
 * CheckpointReactor (Phase 2): at `TurnSettled`, commit the sandbox's
 * `/workspace` onto the hidden ref `refs/evie/checkpoints/<threadId>` in the
 * bot's directory (a git repo since `git init` at bot creation) and record the
 * sha. Per-turn diff and restore fall out of the ref history.
 *
 * All plumbing, no porcelain: a private temporary index, `write-tree`,
 * `commit-tree`, `update-ref`. The user's HEAD, branches, and real index are
 * never touched, and eve's `.eve/` state is never involved.
 *
 * Skipped when the backend is `just-bash` -- no real git in that sandbox.
 */

/**
 * The one thing this reactor needs from the provider side, defined here
 * because Supervisor/EveAdapter are being written concurrently: the host path
 * of the live `/workspace` for a (bot, thread) session. Null means nothing is
 * materialized on the host (runtime never started, or the backend keeps the
 * workspace where the host cannot see it) -- the checkpoint is skipped, not
 * failed.
 */
export interface CheckpointSourcesShape {
  readonly workspacePath: (
    botId: BotId,
    threadId: ThreadId,
  ) => Effect.Effect<string | null, RuntimeUnavailable>
}

export class CheckpointSources extends Context.Service<CheckpointSources, CheckpointSourcesShape>()(
  "provider/CheckpointSources",
) {}

export class GitFailure extends Schema.TaggedError<GitFailure>()("GitFailure", {
  args: Schema.Array(Schema.String),
  stderr: Schema.String,
}) {}

/** Checkpoint commits need an identity but must never borrow the user's. */
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Evie",
  GIT_AUTHOR_EMAIL: "checkpoints@evie.invalid",
  GIT_COMMITTER_NAME: "Evie",
  GIT_COMMITTER_EMAIL: "checkpoints@evie.invalid",
}

const git = (
  args: ReadonlyArray<string>,
  env?: Record<string, string>,
): Effect.Effect<string, GitFailure> =>
  Effect.callback((resume) => {
    execFile(
      "git",
      args as Array<string>,
      { env: { ...process.env, ...GIT_IDENTITY, ...env } },
      (error, stdout, stderr) => {
        if (error !== null) {
          resume(Effect.fail(new GitFailure({ args, stderr: String(stderr) })))
        } else {
          resume(Effect.succeed(String(stdout).trim()))
        }
      },
    )
  })

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const store = yield* EventStore
  const sources = yield* CheckpointSources

  const handleSettled = (
    event: StoredEvent,
    data: Extract<StoredEvent["data"], { _tag: "TurnSettled" }>,
  ) =>
    Effect.gen(function* () {
      // Cancelled and failed turns checkpoint too: partial work is exactly
      // what a user wants to diff or restore after an interruption.
      const bots = yield* sql<{ dir: string; sandbox: string }>`
        select dir, sandbox from bot where id = ${data.botId}`
      const bot = bots[0]
      if (bot === undefined) return
      const sandbox = JSON.parse(bot.sandbox) as { backend?: string }
      if (sandbox.backend === "just-bash") return

      const workspace = yield* sources.workspacePath(data.botId, data.threadId)
      if (workspace === null) return

      const gitDir = join(bot.dir, ".git")
      const ref = `refs/evie/checkpoints/${data.threadId}`
      // A private index per thread: concurrent settles on other threads of the
      // same bot cannot corrupt each other, and the user's real index is never touched.
      const indexFile = join(gitDir, `evie-index-${data.threadId}`)
      const indexEnv = { GIT_INDEX_FILE: indexFile }

      const sha = yield* Effect.gen(function* () {
        yield* git(["--git-dir", gitDir, "--work-tree", workspace, "add", "-A", "."], indexEnv)
        const tree = yield* git(["--git-dir", gitDir, "write-tree"], indexEnv)
        const parent = yield* git(["--git-dir", gitDir, "rev-parse", "-q", "--verify", ref]).pipe(
          Effect.option,
        )
        if (Option.isSome(parent)) {
          const parentTree = yield* git(["--git-dir", gitDir, "rev-parse", `${parent.value}^{tree}`])
          // Nothing changed this turn: no empty checkpoint, ref stays put.
          if (parentTree === tree) return null
        }
        const commitSha = yield* git([
          "--git-dir",
          gitDir,
          "commit-tree",
          tree,
          ...(Option.isSome(parent) ? ["-p", parent.value] : []),
          "-m",
          `evie checkpoint: turn ${data.turnId} (${data.outcome})`,
        ])
        yield* git(["--git-dir", gitDir, "update-ref", ref, commitSha])
        return commitSha
      }).pipe(
        Effect.ensuring(Effect.sync(() => rmSync(indexFile, { force: true }))),
      )
      if (sha === null) return

      const commit: Commit = Effect.gen(function* () {
        yield* sql`
          insert into checkpoint (id, thread_id, turn_id, sha, created_at)
          values (${deriveUlid(event.id, "checkpoint")}, ${data.threadId}, ${data.turnId}, ${sha}, ${Date.now()})
          on conflict (id) do nothing`
        yield* store.append(
          [
            {
              id: deriveUlid(event.id, "checkpoint-written"),
              data: CheckpointWritten.make({
                threadId: data.threadId,
                turnId: data.turnId,
                sha,
              }),
              orgId: event.orgId,
              threadId: data.threadId,
              botId: data.botId,
            },
          ],
          { aggregate: { kind: "thread", id: data.threadId } },
        )
      })
      return commit
    })

  return {
    name: "checkpoint" as const,
    handle: (
      event: StoredEvent,
    ): Effect.Effect<Commit | void, SqlError | RuntimeUnavailable | GitFailure> => {
      const data = event.data
      // CheckpointRestoreRequested is Phase 2's restore half; the write half
      // ships now because the seam is worse than the feature. Restore lands
      // with the sandbox reattach work in the same phase.
      if (data._tag !== "TurnSettled") return Effect.void
      return handleSettled(event, data)
    },
  }
})

/** Provide `CheckpointSources` (the provider's slice) plus `Db.layer` / `EventStore.layer`. */
export const CheckpointReactorLive = reactorLayer(make)
