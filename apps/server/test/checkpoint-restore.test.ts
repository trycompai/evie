import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"

/**
 * The git mechanics restore depends on.
 *
 * `CheckpointReactor` writes checkpoints as commits on a hidden per-thread ref
 * and restores them with `read-tree -u --reset` through a private index. Two
 * properties of that choice are load-bearing and neither is obvious:
 *
 *   1. restoring **removes** files created after the checkpoint. A `checkout`
 *      would leave them, which merges two states instead of restoring one --
 *      and a "restore" that leaves the agent's later files behind is the same
 *      lying label the feature was built to remove.
 *   2. it goes through `GIT_INDEX_FILE`, so the user's own index and staged
 *      work are never touched.
 *
 * Exercised against a real repository in a temp directory rather than mocked,
 * because what is being pinned is git's behaviour, not ours. Temp directory,
 * never `~/.evie` -- see rule 2 in AGENTS.md.
 */

const root = mkdtempSync(join(tmpdir(), "evie-checkpoint-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const IDENTITY = {
  GIT_AUTHOR_NAME: "Evie",
  GIT_AUTHOR_EMAIL: "checkpoints@evie.invalid",
  GIT_COMMITTER_NAME: "Evie",
  GIT_COMMITTER_EMAIL: "checkpoints@evie.invalid",
}

const git = (args: ReadonlyArray<string>, env: Record<string, string> = {}): string =>
  execFileSync("git", args as Array<string>, {
    env: { ...process.env, ...IDENTITY, ...env },
    encoding: "utf8",
  }).trim()

/** One bot directory: a git repo whose working tree is the bot's workspace. */
const makeBot = (name: string) => {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  git(["init", "-q", dir])
  const gitDir = join(dir, ".git")
  const index = join(gitDir, "evie-index-thread")
  const ref = "refs/evie/checkpoints/thread"

  /** Exactly what the reactor's write half does. */
  const checkpoint = (): string => {
    git(["--git-dir", gitDir, "--work-tree", dir, "add", "-A", "."], { GIT_INDEX_FILE: index })
    const tree = git(["--git-dir", gitDir, "write-tree"], { GIT_INDEX_FILE: index })
    const sha = git(["--git-dir", gitDir, "commit-tree", tree, "-m", "evie checkpoint"], {
      GIT_INDEX_FILE: index,
    })
    git(["--git-dir", gitDir, "update-ref", ref, sha])
    return sha
  }

  /** Exactly what the reactor's restore half does. */
  const restore = (sha: string): void => {
    // The index must first know what is on disk, or `--reset` treats anything
    // created since the checkpoint as untracked and leaves it behind.
    git(["--git-dir", gitDir, "--work-tree", dir, "add", "-A", "."], { GIT_INDEX_FILE: index })
    git(["--git-dir", gitDir, "--work-tree", dir, "read-tree", "-u", "--reset", sha], {
      GIT_INDEX_FILE: index,
    })
  }

  return { dir, gitDir, checkpoint, restore }
}

describe("checkpoint restore", () => {
  it("puts an edited file back and deletes one created since", () => {
    const bot = makeBot("restore")
    writeFileSync(join(bot.dir, "kept.txt"), "original\n")
    const sha = bot.checkpoint()

    // The agent then edits one file and creates another.
    writeFileSync(join(bot.dir, "kept.txt"), "the agent changed this\n")
    writeFileSync(join(bot.dir, "invented.txt"), "the agent made this up\n")

    bot.restore(sha)

    expect(readFileSync(join(bot.dir, "kept.txt"), "utf8")).toBe("original\n")
    // The one that would be wrong with `checkout` instead of `read-tree --reset`.
    expect(() => readFileSync(join(bot.dir, "invented.txt"), "utf8")).toThrow()
  })

  it("restores a file the agent deleted", () => {
    const bot = makeBot("deleted")
    writeFileSync(join(bot.dir, "important.txt"), "do not lose me\n")
    const sha = bot.checkpoint()

    rmSync(join(bot.dir, "important.txt"))
    bot.restore(sha)

    expect(readFileSync(join(bot.dir, "important.txt"), "utf8")).toBe("do not lose me\n")
  })

  /*
   * The private index is what lets two threads of one bot checkpoint at the
   * same time without corrupting each other, and it is why a restore cannot
   * disturb whatever the user had staged in their own repository.
   */
  it("never touches the repository's real index", () => {
    const bot = makeBot("index")
    writeFileSync(join(bot.dir, "a.txt"), "one\n")
    const sha = bot.checkpoint()

    // The user stages something of their own, through the default index.
    writeFileSync(join(bot.dir, "mine.txt"), "staged by a person\n")
    git(["-C", bot.dir, "add", "mine.txt"])
    const stagedBefore = git(["-C", bot.dir, "diff", "--cached", "--name-only"])
    expect(stagedBefore).toBe("mine.txt")

    bot.restore(sha)

    expect(git(["-C", bot.dir, "diff", "--cached", "--name-only"])).toBe("mine.txt")
  })
})

describe("the per-turn file summary", () => {
  /*
   * `--numstat` is unlocalised and machine-readable, and reports `-` for both
   * counts on a binary file -- which is the case that would otherwise produce
   * `NaN` and render as "+NaN -NaN" in the timeline.
   */
  const parse = (out: string) => {
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
  }

  it("adds up a real numstat", () => {
    expect(parse("3\t1\tsrc/a.ts\n10\t0\tsrc/b.ts")).toEqual({
      files: 2,
      insertions: 13,
      deletions: 1,
    })
  })

  it("counts a binary file without producing NaN", () => {
    expect(parse("-\t-\tlogo.png\n2\t0\tsrc/a.ts")).toEqual({
      files: 2,
      insertions: 2,
      deletions: 0,
    })
  })

  it("reads an empty diff as no changes", () => {
    expect(parse("")).toEqual({ files: 0, insertions: 0, deletions: 0 })
  })
})
