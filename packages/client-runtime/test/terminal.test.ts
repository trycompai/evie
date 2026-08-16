import { describe, expect, it } from "vitest"
import type { TimelineFrame, TimelineItem } from "@evie/contracts/timeline"
import type { BotId, ThreadId, TurnId } from "@evie/contracts/ids"
import { Timeline } from "../src/timeline.ts"

/**
 * The Terminal tab is a derivation over rows the timeline already holds, so
 * what needs asserting is the derivation itself -- which rows count as runs,
 * what one run reads as -- and its caching contract: the lines array must keep
 * its identity through frames that touch no bash row, or the tab re-renders on
 * every streamed word of an unrelated reply.
 */

const threadId = "01J000000000000000000THRD" as ThreadId
const botId = "01J0000000000000000000BOT" as BotId
const turnId = "01J000000000000000000TURN" as TurnId

const run = (
  id: string,
  seq: number,
  command: string,
  output?: unknown,
  state: "pending" | "running" | "ok" | "error" | "cancelled" = "ok",
): TimelineItem =>
  ({
    kind: "tool",
    id,
    threadId,
    seq,
    at: seq,
    botId,
    turnId,
    callId: id,
    name: "bash",
    state,
    input: { command },
    ...(output === undefined ? {} : { output }),
  }) as TimelineItem

const assistant = (id: string, seq: number, text: string): TimelineItem =>
  ({
    kind: "assistant",
    id,
    threadId,
    seq,
    at: seq,
    botId,
    turnId,
    parts: [{ type: "text", text }],
  }) as TimelineItem

const frame = (ops: TimelineFrame["ops"], seq: number): TimelineFrame => ({
  threadId,
  ops,
  seq,
  mode: "full",
})

const done = { exitCode: 0, stdout: "hello\n", stderr: "", truncated: false }

describe("the terminal transcript", () => {
  it("shows a run as its command and what it printed", () => {
    const timeline = new Timeline()
    timeline.hydrate([run("t1", 1, "echo hello", done)])

    expect(timeline.terminal()).toEqual(["$ echo hello", "hello"])
  })

  it("keeps stderr and a nonzero exit visible", () => {
    const timeline = new Timeline()
    timeline.hydrate([
      run("t1", 1, "ls /gone", { exitCode: 2, stdout: "", stderr: "ls: /gone: No such file or directory\n", truncated: false }),
    ])

    expect(timeline.terminal()).toEqual([
      "$ ls /gone",
      "ls: /gone: No such file or directory",
      "exit 2",
    ])
  })

  it("ignores every tool that is not bash, and every non-tool row", () => {
    const timeline = new Timeline()
    timeline.hydrate([
      assistant("a", 1, "let me look"),
      { ...run("t1", 2, "unused"), name: "read_file" } as TimelineItem,
      run("t2", 3, "pwd", { exitCode: 0, stdout: "/workspace\n", stderr: "", truncated: false }),
    ])

    expect(timeline.terminal()).toEqual(["$ pwd", "/workspace"])
  })

  it("separates runs and keeps thread order", () => {
    const timeline = new Timeline()
    timeline.hydrate([
      run("t2", 5, "second", done),
      run("t1", 1, "first", done),
    ])

    expect(timeline.terminal()).toEqual(["$ first", "hello", "", "$ second", "hello"])
  })

  it("says a run failed or was cancelled instead of reading as clean", () => {
    const timeline = new Timeline()
    timeline.hydrate([
      run("t1", 1, "sleep 999", undefined, "cancelled"),
      run("t2", 2, "broken", undefined, "error"),
    ])

    expect(timeline.terminal()).toEqual([
      "$ sleep 999",
      "(cancelled)",
      "",
      "$ broken",
      "(failed)",
    ])
  })

  it("shows a still-running command as a bare prompt line", () => {
    const timeline = new Timeline()
    timeline.apply(frame([{ op: "insert", item: run("t1", 1, "bun test", undefined, "running") }], 1))

    expect(timeline.terminal()).toEqual(["$ bun test"])
  })

  it("updates when the run's result replaces the row, and says so", () => {
    const timeline = new Timeline()
    timeline.apply(frame([{ op: "insert", item: run("t1", 1, "echo hello", undefined, "running") }], 1))

    // The result is a `replace` of a known id -- the exact frame the
    // thread-level channel is deaf to, and the reason the tab has its own.
    const result = timeline.apply(frame([{ op: "replace", item: run("t1", 1, "echo hello", done) }], 2))

    expect(result.terminalChanged).toBe(true)
    expect(timeline.terminal()).toEqual(["$ echo hello", "hello"])
  })

  it("keeps the lines referentially identical through frames that touch no run", () => {
    const timeline = new Timeline()
    timeline.apply(
      frame(
        [
          { op: "insert", item: run("t1", 1, "echo hello", done) },
          { op: "insert", item: assistant("a", 2, "") },
        ],
        2,
      ),
    )
    const before = timeline.terminal()

    // A streaming reply is twenty frames a second; if any of them rebuilds the
    // transcript, the Terminal tab re-renders for every word of prose.
    const result = timeline.apply(frame([{ op: "appendText", id: "a", partIndex: 0, chunk: "done" }], 3))

    expect(result.terminalChanged).toBe(false)
    expect(timeline.terminal()).toBe(before)
  })

  it("tolerates a clipped payload without dropping the run", () => {
    const timeline = new Timeline()
    // Over 8 KiB, the projector keeps head and tail of the JSON -- which no
    // longer parses, so it arrives as whatever survived. The run still shows.
    timeline.hydrate([{ ...run("t1", 1, "cat big-file"), input: 12345, output: undefined } as TimelineItem])

    expect(timeline.terminal()).toEqual(["$ …"])
  })
})
