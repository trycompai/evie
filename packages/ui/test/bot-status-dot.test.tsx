// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import type { BotHealth } from "@evie/contracts/bot"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { BotStatusDot, presentHealth } from "../src/components/bot-status-dot.tsx"

/**
 * What the dot next to a bot's name is allowed to say.
 *
 * The indicator exists because runtimes stop on their own and the app gave no
 * sign either way, so "is my agent still there?" had no answer on screen. The
 * risk in adding one is telling the opposite lie -- `idle` is the ordinary
 * resting state of a bot nobody is talking to, and painting it as a fault would
 * make a working product look broken every time someone came back to it.
 *
 * These pin the honest mapping and, more importantly, the exhaustiveness: a new
 * `BotHealth` variant must not fall through to a blank dot with no label.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const ALL: ReadonlyArray<BotHealth> = [
  { kind: "idle" },
  { kind: "starting" },
  { kind: "ready" },
  { kind: "busy", activeTurns: 1 },
  { kind: "restarting", attempt: 2 },
  { kind: "unhealthy", reason: "eve is not installed", stderr: [] },
]

describe("the bot status dot", () => {
  it("is green only when the runtime is actually up", () => {
    const green = ALL.filter((health) => presentHealth(health).tone === "bg-success")
    expect(green.map((health) => health.kind)).toEqual(["ready", "busy"])
  })

  it("never shows a stopped runtime as a fault", () => {
    const idle = presentHealth({ kind: "idle" })
    expect(idle.tone).toBe("bg-fg-muted")
    expect(idle.tone).not.toBe("bg-error")
    // The label has to carry the reassurance, not just the colour: grey alone
    // reads as "broken, but quietly".
    expect(idle.detail).toMatch(/wakes it/)
  })

  it("reserves the error tone for a bot that will not answer", () => {
    const red = ALL.filter((health) => presentHealth(health).tone === "bg-error")
    expect(red.map((health) => health.kind)).toEqual(["unhealthy"])
    // The chip shows a cause, so the reason has to survive into it.
    expect(presentHealth(ALL.at(-1)!).detail).toBe("eve is not installed")
  })

  it("gives every variant a label and a tone", () => {
    for (const health of ALL) {
      const { tone, label, detail } = presentHealth(health)
      expect(tone, health.kind).toBeTruthy()
      expect(label, health.kind).toBeTruthy()
      expect(detail, health.kind).toBeTruthy()
    }
  })

  it("announces itself to assistive tech rather than being a bare colour", () => {
    act(() => root.render(<BotStatusDot health={{ kind: "ready" }} />))
    const dot = host.querySelector("[role='img']")
    expect(dot?.getAttribute("aria-label")).toBe("Online. Online and ready")
  })
})
