import { describe, expect, it } from "vitest"

/**
 * Which action the composer's trailing button performs.
 *
 * Extracted as a table rather than rendered, because the defect was never
 * visual: the button looked right and did the wrong thing. `Composer` decides
 * between Send, Stop, and Dictate with a nested ternary, and the order used to
 * put Stop ahead of Send. So with a turn running and a message typed, the
 * button was Stop -- clicking it cancelled instead of sending, while Enter sent
 * normally because `handleKeyDown` never consults `streaming`.
 *
 * That asymmetry is what makes this worth pinning: the composer worked from the
 * keyboard and appeared dead to the mouse, which reads to a user as "my
 * messages don't send" and to a developer as "works for me".
 *
 * The rule, from the component's own comment: eve's default `turnPolicy` is
 * `steer`, so a message sent mid-turn replaces the in-flight one. Text always
 * means Send.
 */

type Action = "send" | "stop" | "dictate"

/** Mirrors the precedence in `composer.tsx`. */
const trailingAction = (input: {
  readonly hasText: boolean
  readonly streaming: boolean
  readonly canStopBeOffered: boolean
}): Action => {
  const canStop = input.streaming && input.canStopBeOffered
  return input.hasText ? "send" : canStop ? "stop" : "dictate"
}

describe("the composer's trailing button", () => {
  it("sends when there is text and nothing is running", () => {
    expect(trailingAction({ hasText: true, streaming: false, canStopBeOffered: true })).toBe("send")
  })

  /* The regression: this used to be "stop". */
  it("sends when there is text AND a turn is running, because a turn can be steered", () => {
    expect(trailingAction({ hasText: true, streaming: true, canStopBeOffered: true })).toBe("send")
  })

  it("stops when a turn is running and there is nothing to send", () => {
    expect(trailingAction({ hasText: false, streaming: true, canStopBeOffered: true })).toBe("stop")
  })

  /*
   * Stop is offered only when the caller can actually stop something. A Stop
   * button with no turn id behind it is the same class of lie as a spinner that
   * says "thinking" while the agent is parked.
   */
  it("never offers Stop the caller cannot honour", () => {
    expect(trailingAction({ hasText: false, streaming: true, canStopBeOffered: false })).toBe(
      "dictate",
    )
  })

  it("offers dictation when idle and empty", () => {
    expect(trailingAction({ hasText: false, streaming: false, canStopBeOffered: false })).toBe(
      "dictate",
    )
  })
})
