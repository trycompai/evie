// @vitest-environment jsdom
import { StrictMode, act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApprovalCard } from "../src/components/approval-card.tsx"

/**
 * The card's keyboard contract, pinned in a real DOM.
 *
 * This exists because the contract failed twice in ways no type check sees:
 * focus never arrived (StrictMode re-invokes refs, and the first version's
 * dedupe skipped the retry), and then letters died whenever the composer held
 * focus (which is always, after sending). Every rule here is one a user
 * reported broken or one that guards an answer being sent by accident.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const OPTIONS = [
  { id: "yes", label: "Yes, run it" },
  { id: "no", label: "No" },
] as const

let n = 0
let host: HTMLDivElement
let composer: HTMLTextAreaElement
let root: Root
let requestId: string

beforeEach(() => {
  requestId = `req_${n++}`
  host = document.createElement("div")
  document.body.appendChild(host)
  composer = document.createElement("textarea")
  composer.setAttribute("data-evie-composer", "")
  document.body.appendChild(composer)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  composer.remove()
  vi.useRealTimers()
})

const show = (props: Partial<Parameters<typeof ApprovalCard>[0]> = {}, strict = false) => {
  const card = (
    <ApprovalCard requestId={requestId} prompt="Run it?" options={OPTIONS} state="pending" {...props} />
  )
  act(() => root.render(strict ? <StrictMode>{card}</StrictMode> : card))
}

/** Keydown as the browser would deliver it: on the focused element, bubbling. */
const press = (key: string, target: HTMLElement) => {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
  })
}

const radios = () => Array.from(host.querySelectorAll<HTMLInputElement>('input[type="radio"]'))

describe("focus on arrival", () => {
  it("moves into the card when the composer is empty", () => {
    composer.focus()
    show()
    expect(document.activeElement).toBe(radios()[0])
  })

  it("moves into the card under StrictMode's double-invoked refs", () => {
    composer.focus()
    show({}, true)
    expect(document.activeElement).toBe(radios()[0])
  })

  it("leaves a draft alone", () => {
    composer.value = "actually, hold on"
    composer.focus()
    show()
    expect(document.activeElement).toBe(composer)
  })
})

describe("answering with letters", () => {
  it("answers from the empty composer", () => {
    const onAnswer = vi.fn()
    show({ onAnswer })
    composer.focus() // the user clicked back after the card took focus
    press("a", composer)
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith("yes", "once")
  })

  it("answers when focus is nowhere in particular", () => {
    const onAnswer = vi.fn()
    show({ onAnswer })
    act(() => (document.activeElement as HTMLElement | null)?.blur())
    press("b", document.body)
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith("no", "once")
  })

  it("never fires from a draft", () => {
    const onAnswer = vi.fn()
    show({ onAnswer })
    composer.value = "a draft"
    composer.focus()
    press("a", composer)
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it("locks after the first answer", () => {
    const onAnswer = vi.fn()
    show({ onAnswer })
    act(() => (document.activeElement as HTMLElement | null)?.blur())
    press("a", document.body)
    press("b", document.body)
    expect(onAnswer).toHaveBeenCalledTimes(1)
  })
})

describe("keys inside the card", () => {
  it("arrows rove between choices without committing", () => {
    const onAnswer = vi.fn()
    composer.focus()
    show({ onAnswer })
    press("ArrowDown", radios()[0]!)
    expect(document.activeElement).toBe(radios()[1])
    press("ArrowUp", radios()[1]!)
    expect(document.activeElement).toBe(radios()[0])
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it("Enter commits the focused choice", () => {
    const onAnswer = vi.fn()
    composer.focus()
    show({ onAnswer })
    press("ArrowDown", radios()[0]!)
    press("Enter", radios()[1]!)
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith("no", "once")
  })

  it("a non-shortcut letter forwards focus to the composer", () => {
    const onAnswer = vi.fn()
    composer.focus()
    show({ onAnswer })
    press("h", radios()[0]!)
    expect(document.activeElement).toBe(composer)
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it("Escape hands focus back to the composer", () => {
    composer.focus()
    show()
    press("Escape", radios()[0]!)
    expect(document.activeElement).toBe(composer)
  })
})

describe("the undo beat on tool approvals", () => {
  it("stages the answer, then dispatches it", () => {
    vi.useFakeTimers()
    const onAnswer = vi.fn()
    show({ onAnswer, toolName: "bash" })
    act(() => (document.activeElement as HTMLElement | null)?.blur())
    press("a", document.body)
    expect(onAnswer).not.toHaveBeenCalled()
    act(() => void vi.advanceTimersByTime(3000))
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith("yes", "once")
  })

  it("Escape inside the beat undoes, and the card is answerable again", () => {
    vi.useFakeTimers()
    const onAnswer = vi.fn()
    show({ onAnswer, toolName: "bash" })
    act(() => (document.activeElement as HTMLElement | null)?.blur())
    press("a", document.body)
    press("Escape", document.body)
    act(() => void vi.advanceTimersByTime(10_000))
    expect(onAnswer).not.toHaveBeenCalled()
    press("b", document.body)
    act(() => void vi.advanceTimersByTime(3000))
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith("no", "once")
  })

  it("plain questions dispatch immediately", () => {
    const onAnswer = vi.fn()
    show({ onAnswer })
    act(() => (document.activeElement as HTMLElement | null)?.blur())
    press("a", document.body)
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith("yes", "once")
  })
})
