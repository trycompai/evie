import { useState } from "react"
import { cn } from "@evie/ui/lib/utils"
import { CloseIcon } from "@evie/ui/components/icon"
import {
  Questionnaire,
  QuestionnaireChoice,
  QuestionnaireChoices,
  QuestionnaireItem,
  QuestionnaireTitle,
} from "@evie/ui/components/questionnaire"

/**
 * The question card: `input.requested` from eve, rendered in the flow.
 *
 * **Not a modal**, but it is the task: the bot asked and is waiting. So when a
 * question arrives and the user is not mid-draft, keyboard focus moves into the
 * card -- the dialog convention, applied to an inline row -- and every key does
 * the obvious thing from there:
 *
 *   - option letters (A, B, ...) answer, via the questionnaire's own
 *     form-scoped shortcuts;
 *   - arrows rove between choices WITHOUT committing (the native radio group
 *     checks whatever an arrow lands on, and checking is answering here);
 *   - Enter or Space commits the focused choice;
 *   - any other printable key is the start of a typed reply, so focus jumps to
 *     the composer and the character lands there -- typing is never hostage;
 *   - Escape hands focus back to the composer.
 *
 * Focus is stolen only from an idle place: `body`, or the composer while it is
 * EMPTY (it opts in with `data-evie-composer`). A draft keeps its caret, and a
 * card scrolled back into view is not a question arriving, so it never
 * re-steals. A document-level listener backs all of this up so the letters
 * also work when focus has wandered -- it steps aside for modifier chords, IME
 * composition, keys born inside the card, and every field except the empty
 * composer.
 *
 * Tool approvals get an undo beat: the answer is staged for a moment before it
 * dispatches, because a misread keystroke here approves an action for an agent
 * with shell access. Undo (or Escape) inside the beat and nothing was sent.
 * Plain questions dispatch immediately -- a wrong word to a question is cheap
 * and correctable in chat.
 */

/** How long a staged tool approval waits before it dispatches. */
const UNDO_MS = 3000

/**
 * Pending cards that can hear the keyboard, oldest first. With two questions
 * waiting, a letter must answer exactly one -- the newest, the one the user is
 * looking at. Module-level: cards in the virtualized timeline mount and
 * unmount as they scroll, and ownership has to survive that.
 */
const hotkeyOwners: string[] = []

/**
 * Requests that have taken focus once. Only a request's first appearance is
 * "the question arriving"; remounts (scroll-back, StrictMode's double-invoke)
 * must not steal again.
 */
const focusTaken = new Set<string>()

const composerEl = (): HTMLTextAreaElement | null =>
  document.querySelector<HTMLTextAreaElement>("textarea[data-evie-composer]")

const isEmptyComposer = (el: Element | EventTarget | null): boolean =>
  el instanceof HTMLTextAreaElement && el.hasAttribute("data-evie-composer") && el.value === ""

const radiosOf = (root: HTMLElement): HTMLInputElement[] =>
  Array.from(root.querySelectorAll<HTMLInputElement>('input[type="radio"]'))

export interface ApprovalOption {
  readonly id: string
  readonly label: string
  /** Legacy hint; the questionnaire assigns letter shortcuts in option order. */
  readonly hotkey?: string
  readonly tone?: "default" | "primary" | "danger"
}

export interface ApprovalCardProps {
  /** Identifies the request across remounts; without it the keyboard is not wired. */
  readonly requestId?: string
  readonly prompt: string
  readonly options: readonly ApprovalOption[]
  readonly state: "pending" | "answered" | "cancelled" | "expired"
  /** Which option won. Keeps a resolved card readable instead of blank. */
  readonly answeredWith?: string
  /** Who answered, in a shared thread. Absent in a solo organization. */
  readonly answeredBy?: string
  /**
   * The tool being gated. Its presence is what makes a session-long grant
   * offerable -- and what earns the undo beat, because approving a tool is the
   * consequential kind of answer.
   */
  readonly toolName?: string
  readonly onAnswer?: (optionId: string, scope: "once" | "always") => void
  readonly onDismiss?: () => void
}

const TONE_TEXT = {
  default: "text-fg",
  primary: "text-fg",
  danger: "text-error",
} as const

interface Staged {
  readonly optionId: string
  readonly scope: "once" | "always"
  readonly timer: ReturnType<typeof setTimeout>
}

export function ApprovalCard({
  requestId,
  prompt,
  options,
  state,
  answeredWith,
  answeredBy,
  toolName,
  onAnswer,
  onDismiss,
}: ApprovalCardProps) {
  const pending = state === "pending"
  /*
   * The scope rides on the answer rather than being a third row of buttons.
   * Doubling every option into "approve" and "always approve" is how a card
   * with three choices becomes six, and the grant is a modifier on a decision
   * the user is already making, not a separate decision.
   */
  const [always, setAlways] = useState(false)
  /** A tool approval waiting out its undo beat. */
  const [staged, setStaged] = useState<Staged | null>(null)
  /*
   * Dispatched, enforced here and not just by the server: the round trip is
   * long enough to click twice, and the second click would be a second
   * `AnswerInput`. Committing locks the card and checks the chosen radio at
   * once, so the action reads as taken before the store confirms it.
   */
  const [sentWith, setSentWith] = useState<string | null>(null)
  const answerable = pending && staged === null && sentWith === null
  /** What the card shows as chosen right now, whatever stage it is in. */
  const chosenNow = pending ? (staged?.optionId ?? sentWith) : (answeredWith ?? null)

  const commit = (optionId: string) => {
    const scope = always ? "always" : "once"
    if (toolName === undefined) {
      setSentWith(optionId)
      onAnswer?.(optionId, scope)
      return
    }
    /*
     * The timer lives outside the component's lifetime on purpose: if the card
     * unmounts mid-beat (scrolled away, thread switched), the answer still
     * dispatches. An undo window that can silently swallow an answer is worse
     * than no undo window.
     */
    const timer = setTimeout(() => {
      setStaged(null)
      setSentWith(optionId)
      onAnswer?.(optionId, scope)
    }, UNDO_MS)
    setStaged({ optionId, scope, timer })
  }

  const undo = () => {
    if (staged === null) return
    clearTimeout(staged.timer)
    setStaged(null)
  }

  /*
   * A ref callback, not an effect: arrival and the listener's lifetime are
   * facts about the node. It re-attaches on every render, which is also what
   * keeps the closures reading current `always`, `staged`, and `sentWith`.
   */
  const arrive = (node: HTMLDivElement | null) => {
    if (node === null || !pending || requestId === undefined) return

    // The question arriving takes focus -- from an idle place only.
    if (!focusTaken.has(requestId)) {
      focusTaken.add(requestId)
      const active = document.activeElement
      if (active === null || active === document.body || isEmptyComposer(active)) {
        radiosOf(node)[0]?.focus()
      }
    }

    hotkeyOwners.push(requestId)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      if (hotkeyOwners[hotkeyOwners.length - 1] !== requestId) return

      // During the beat the only global key is Escape, and it means undo.
      if (staged !== null) {
        if (event.key === "Escape") {
          event.preventDefault()
          undo()
        }
        return
      }

      if (!answerable) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target
      // Inside the card, the questionnaire's own form-scoped shortcuts answer;
      // acting here too would answer twice off one keystroke.
      if (target instanceof Node && node.contains(target)) return
      const editable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      // Fields keep their keys -- except the empty composer, where the user is
      // parked after sending and "press A" has to mean something.
      if (editable && !isEmptyComposer(target)) return
      const index = event.key.length === 1 ? event.key.toUpperCase().charCodeAt(0) - 65 : -1
      const option = index >= 0 && index < options.length ? options[index] : undefined
      if (option === undefined) return
      event.preventDefault()
      commit(option.id)
    }
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("keydown", onKeyDown)
      const at = hotkeyOwners.lastIndexOf(requestId)
      if (at !== -1) hotkeyOwners.splice(at, 1)
    }
  }

  /*
   * Enter and Space commit the focused choice. Capture phase, because the
   * questionnaire form claims Enter for its own navigation before a bubbling
   * handler would ever see it -- and a card with no Next button turns that
   * claim into a dead key.
   */
  const onCardKeyDownCapture = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return
    if (event.defaultPrevented || event.nativeEvent.isComposing) return
    if (!answerable || event.metaKey || event.ctrlKey || event.altKey) return
    const target = event.target
    if (!(target instanceof HTMLInputElement) || target.type !== "radio") return
    const at = radiosOf(event.currentTarget).indexOf(target)
    const option = at === -1 ? undefined : options[at]
    if (option === undefined) return
    event.preventDefault()
    commit(option.id)
  }

  /* Keys born inside the card: roving, forwarding, escaping. */
  const onCardKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return

    if (event.key === "Escape") {
      event.preventDefault()
      if (staged !== null) undo()
      else composerEl()?.focus()
      return
    }

    if (!answerable || event.metaKey || event.ctrlKey || event.altKey) return
    const target = event.target
    if (!(target instanceof HTMLInputElement) || target.type !== "radio") return
    const radios = radiosOf(event.currentTarget)
    const at = radios.indexOf(target)
    if (at === -1) return

    if (["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(event.key)) {
      // Rove without committing. Left to the browser, an arrow CHECKS the
      // radio it lands on, and checking is answering here.
      event.preventDefault()
      const delta = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1
      radios[(at + delta + radios.length) % radios.length]?.focus()
      return
    }

    if (event.key.length === 1) {
      const index = event.key.toUpperCase().charCodeAt(0) - 65
      const isShortcut = index >= 0 && index < options.length
      if (!isShortcut) {
        // The start of a typed reply, not an answer. Moving focus mid-keydown
        // lets the browser land this very character in the composer -- no
        // synthetic events, and IME-safe. preventDefault would eat it.
        composerEl()?.focus()
      }
      // Shortcut letters fall through to the questionnaire's form handling.
    }
  }

  return (
    <div
      ref={arrive}
      onKeyDown={onCardKeyDown}
      onKeyDownCapture={onCardKeyDownCapture}
      className="flex w-[780px] max-w-full flex-col gap-3.5 rounded-bubble bg-raised px-[18px] pt-4 pb-[18px]"
    >
      <Questionnaire shortcuts="letters" className="gap-3.5">
        <QuestionnaireItem name="answer" className="gap-3.5">
          <div className="flex items-start gap-3">
            <QuestionnaireTitle className="mb-0! min-w-0 flex-1 text-body font-normal text-fg">
              {prompt}
            </QuestionnaireTitle>
            {pending && onDismiss && (
              <button
                type="button"
                onClick={onDismiss}
                aria-label="Dismiss"
                className="flex h-6 w-5 shrink-0 items-center justify-center text-fg-muted hover:text-fg"
              >
                <CloseIcon />
              </button>
            )}
          </div>

          <QuestionnaireChoices>
            {options.map((option) => {
              const chosen = chosenNow === option.id
              return (
                <QuestionnaireChoice
                  key={option.id}
                  value={option.id}
                  // Controlled in every state: while pending the local stage or
                  // send is what checks it, and a resolved card shows the record.
                  checked={chosen}
                  disabled={!answerable}
                  onChange={answerable ? () => commit(option.id) : undefined}
                  className={cn(
                    // A resolved card dims the roads not taken rather than
                    // hiding them: what was offered is as much of the record as
                    // what was picked. The chosen one stays at full strength,
                    // from the moment of the keystroke onward.
                    chosen && "data-disabled:opacity-100",
                  )}
                >
                  <span className={TONE_TEXT[option.tone ?? "default"]}>{option.label}</span>
                </QuestionnaireChoice>
              )
            })}
          </QuestionnaireChoices>
        </QuestionnaireItem>
      </Questionnaire>

      {answerable && toolName !== undefined && onAnswer && (
        <label className="flex cursor-pointer items-center gap-2.5 text-metadata text-fg-muted select-none">
          <input
            type="checkbox"
            checked={always}
            onChange={(event) => setAlways(event.target.checked)}
            className="size-3.5 shrink-0 accent-fg"
          />
          {/* Names the tool and the bound, because both are the promise. */}
          <span>
            Always allow <span className="text-fg">{toolName}</span> for this session
          </span>
        </label>
      )}

      {staged !== null && (
        <div className="flex flex-col gap-2.5">
          {/*
            The undo beat, made visible: a bar that drains over exactly UNDO_MS.
            `@starting-style` (the `starting:` variant) starts it full on mount
            and the transition carries it to empty -- one shot, transform-only,
            linear because it is a progress readout and progress must not ease.
            Under reduced motion the global flatten empties it instantly; the
            text below still says what is about to happen.
          */}
          <span
            aria-hidden
            className="h-0.5 origin-left scale-x-0 rounded-pill bg-fg-muted/40 transition-transform ease-linear starting:scale-x-100"
            style={{ transitionDuration: `${UNDO_MS}ms` }}
          />
          <p aria-live="polite" className="flex items-center gap-2.5 text-metadata text-fg-muted select-none">
            <span>
              Answering with{" "}
              <span className="text-fg">
                {options.find((option) => option.id === staged.optionId)?.label ?? staged.optionId}
              </span>
            </span>
            <button
              type="button"
              onClick={undo}
              className="shrink-0 rounded-small px-2 py-1 font-medium text-fg hover:bg-raised-strong focus-visible:ring-2 focus-visible:ring-focus/50 focus-visible:outline-none"
            >
              Undo (esc)
            </button>
          </p>
        </div>
      )}

      {state !== "pending" && (
        <p className="text-metadata text-fg-muted">
          {state === "answered" && answeredBy
            ? `Answered by ${answeredBy}`
            : state === "answered"
              ? "Answered"
              : state === "expired"
                ? "This question expired"
                : "Cancelled"}
        </p>
      )}
    </div>
  )
}
