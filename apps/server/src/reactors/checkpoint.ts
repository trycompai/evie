import { execFile } from "node:child_process"
import { rmSync } from "node:fs"
import { join } from "node:path"
import type { RuntimeUnavailable } from "@evie/contracts/errors"
import { CheckpointRestored, CheckpointWritten, type StoredEvent } from "@evie/contracts/events"
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

/**
 * Git's own name for "nothing", so a first checkpoint diffs against an empty
 * tree instead of being special-cased.
 */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

/**
 * `N files changed, +X -Y` for one checkpoint commit.
 *
 * `--numstat` rather than `--shortstat` because it is machine-readable and
 * unlocalised, and binary files report `-` for both counts, which parse to
 * zero without special handling. A failure here is not a failed checkpoint --
 * the commit is already written and the numbers are recoverable from git
 * later, so this degrades to zeroes rather than losing the turn's work.
 */
const summarize = (
  gitDir: string,
  sha: string,
): Effect.Effect<{ files: number; insertions: number; deletions: number }> =>
  git(["--git-dir", gitDir, "diff", "--numstat", `${sha}^`, sha]).pipe(
    // No parent means the first checkpoint on this thread; diff against nothing.
    Effect.catch(() => git(["--git-dir", gitDir, "diff", "--numstat", EMPTY_TREE, sha])),
    Effect.map((out: string) => {
      let files = 0
      let insertions = 0
      let deletions = 0
      for (const line of out.split("\n")) {
        if (line.trim() === "") continue
        const [added, removed] = line.split("\t")
        files += 1
        insertions += Number(added) || 0
        deletions += Number(removed) || 0
      }
      return { files, insertions, deletions }
    }),
    Effect.catch(() => Effect.succeed({ files: 0, insertions: 0, deletions: 0 })),
  )

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

      const stats = yield* summarize(gitDir, sha)

      const commit: Commit = Effect.gen(function* () {
        yield* sql`
          insert into checkpoint (id, thread_id, turn_id, sha, created_at, files, insertions, deletions)
          values (${deriveUlid(event.id, "checkpoint")}, ${data.threadId}, ${data.turnId}, ${sha}, ${Date.now()},
                  ${stats.files}, ${stats.insertions}, ${stats.deletions})
          on conflict (id) do nothing`
        yield* store.append(
          [
            {
              id: deriveUlid(event.id, "checkpoint-written"),
              data: CheckpointWritten.make({
                threadId: data.threadId,
                turnId: data.turnId,
                sha,
                ...stats,
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

  /**
   * Puts the files back.
   *
   * `add -A` then `read-tree -u --reset`, rather than a checkout: together they
   * update the working tree *and* remove files the checkpoint does not have,
   * which is the difference between restoring a state and merging into one.
   * Through the same private per-thread index the write half uses, so the
   * user's real index is never touched and two threads cannot corrupt each
   * other. `checkpoint-restore.test.ts` pins both halves.
   *
   * What this deliberately does not do is rewind the agent's memory. eve owns
   * the session and has no "forget back to turn N"; pretending otherwise would
   * leave the bot certain it made edits that no longer exist. The timeline row
   * says the files were restored, and says only that.
   */
  const handleRestore = (
    event: StoredEvent,
    data: Extract<StoredEvent["data"], { _tag: "CheckpointRestoreRequested" }>,
  ) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ sha: string; thread_id: string }>`
        select sha, thread_id from checkpoint where id = ${data.checkpointId} limit 1`
      const checkpoint = rows[0]
      // A checkpoint id that names nothing is a stale client, not a failure.
      if (checkpoint === undefined || checkpoint.thread_id !== data.threadId) return

      const bots = yield* sql<{ bot_id: string }>`
        select bot_id from thread_participant
        where thread_id = ${data.threadId} and is_default = 1 limit 1`
      const botId = bots[0]?.bot_id as BotId | undefined
      if (botId === undefined) return

      const botRows = yield* sql<{ dir: string; sandbox: string }>`
        select dir, sandbox from bot where id = ${botId}`
      const bot = botRows[0]
      if (bot === undefined) return
      const sandbox = JSON.parse(bot.sandbox) as { backend?: string }
      // Same exclusion as the write half: no real git in that sandbox, so
      // there is nothing to restore from.
      if (sandbox.backend === "just-bash") return

      const workspace = yield* sources.workspacePath(botId, data.threadId)
      if (workspace === null) return

      const gitDir = join(bot.dir, ".git")
      const indexFile = join(gitDir, `evie-index-${data.threadId}`)
      const indexEnv = { GIT_INDEX_FILE: indexFile }
      yield* Effect.gen(function* () {
        /*
         * The index has to be told what is on disk before it is reset, or
         * `--reset` treats everything the agent created since the checkpoint
         * as untracked and leaves it behind -- which merges two states instead
         * of restoring one, and is exactly the lying label this replaced.
         */
        yield* git(["--git-dir", gitDir, "--work-tree", workspace, "add", "-A", "."], indexEnv)
        yield* git(
          ["--git-dir", gitDir, "--work-tree", workspace, "read-tree", "-u", "--reset", checkpoint.sha],
          indexEnv,
        )
      }).pipe(Effect.ensuring(Effect.sync(() => rmSync(indexFile, { force: true }))))

      const commit: Commit = store.append(
        [
          {
            id: deriveUlid(event.id, "checkpoint-restored"),
            data: CheckpointRestored.make({
              threadId: data.threadId,
              checkpointId: data.checkpointId,
              sha: checkpoint.sha,
            }),
            orgId: event.orgId,
            threadId: data.threadId,
            botId,
            actorUserId: event.actorUserId,
          },
        ],
        { aggregate: { kind: "thread", id: data.threadId } },
      )
      return commit
    })

  return {
    name: "checkpoint" as const,
    handle: (
      event: StoredEvent,
    ): Effect.Effect<Commit | void, SqlError | RuntimeUnavailable | GitFailure> => {
      const data = event.data
      if (data._tag === "TurnSettled") return handleSettled(event, data)
      if (data._tag === "CheckpointRestoreRequested") return handleRestore(event, data)
      return Effect.void
    },
  }
})

/** Provide `CheckpointSources` (the provider's slice) plus `Db.layer` / `EventStore.layer`. */
export const CheckpointReactorLive = reactorLayer(make)
