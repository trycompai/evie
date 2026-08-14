import { describe, expect, it } from "vitest"
import { parseDeepLink } from "../src/desktop-bridge.ts"

/**
 * Deep links arrive from the operating system, which means the input is
 * whatever a user clicked in whatever wrote it -- a Slack message, a shell
 * script, a stale bookmark. `parseDeepLink` sits in front of the one path that
 * can change what the window is showing without the user touching the window,
 * so "never throws, and never guesses" is the whole specification.
 */

describe("parseDeepLink", () => {
  it("reads a thread link", () => {
    expect(parseDeepLink("evie://thread/01J8Z3XK2M4N5P6Q7R8S9T0V1W")).toEqual({
      kind: "thread",
      threadId: "01J8Z3XK2M4N5P6Q7R8S9T0V1W",
    })
  })

  it("reads a bot link", () => {
    expect(parseDeepLink("evie://bot/01J8Z3XK2M4N5P6Q7R8S9T0V1W")).toEqual({
      kind: "bot",
      botId: "01J8Z3XK2M4N5P6Q7R8S9T0V1W",
    })
  })

  /*
   * macOS hands back whichever spelling was written. `evie://thread/x` parses
   * with `thread` as the host; `evie:///thread/x` parses with an empty host and
   * `thread` as the first path segment. Both are the same link to a person.
   */
  it("accepts the triple-slash spelling", () => {
    expect(parseDeepLink("evie:///thread/abc")).toEqual({ kind: "thread", threadId: "abc" })
  })

  it("percent-decodes the id", () => {
    expect(parseDeepLink("evie://thread/a%20b")).toEqual({ kind: "thread", threadId: "a b" })
  })

  it.each([
    ["a kind with no id", "evie://thread"],
    ["a kind nobody has implemented", "evie://routine/abc"],
    ["nothing at all", "evie://"],
  ])("refuses to guess at %s", (_label, input) => {
    expect(parseDeepLink(input).kind).toBe("unknown")
  })

  it("survives a string that is not a URL", () => {
    expect(parseDeepLink("not a url at all")).toEqual({ kind: "unknown", url: "not a url at all" })
  })

  /*
   * The renderer only ever acts on `thread` and `bot`, so an off-origin link
   * has to fall through to `unknown` rather than being read for its path --
   * otherwise `https://evil.example/thread/x` would select a thread.
   */
  it("does not treat a foreign scheme as a link it knows", () => {
    expect(parseDeepLink("https://evil.example/thread/x")).toEqual({
      kind: "unknown",
      url: "https://evil.example/thread/x",
    })
  })
})
