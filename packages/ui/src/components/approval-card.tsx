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
 * **Not a modal.** A modal steals focus while a turn is still streaming and
 * forces a decision before you have finished reading the thing you are deciding
 * about. An inline card lets you keep reading, and it stays in the transcript
 * afterwards showing what was chosen -- which a modal cannot do at all.
 *
 * The question itself is a `Questionnaire` -- the shadcn component every
 * AI-asked questionnaire in Evie goes through. One item, radio choices, and
 * real letter shortcuts: the primitive scopes its key handling to the form and
 * ignores keystrokes born in inputs, so typing in the composer can never answer
 * an approval. Answering happens on choice selection; there is no separate
 * submit step to slow a decision the user has already made.
 *
 * This is table stakes for an agent with shell access, which is why it ships in
 * Phase 1 rather than later.
 */

export interface ApprovalOption {
  readonly id: string
  readonly label: string
  /** Legacy hint; the questionnaire assigns letter shortcuts in option order. */
  readonly hotkey?: string
  readonly tone?: "default" | "primary" | "danger"
}

export interface ApprovalCardProps {
  readonly prompt: string
  readonly options: readonly ApprovalOption[]
  readonly state: "pending" | "answered" | "cancelled" | "expired"
  /** Which option won. Keeps a resolved card readable instead of blank. */
  readonly answeredWith?: string
  /** Who answered, in a shared thread. Absent in a solo organization. */
  readonly answeredBy?: string
  /**
   * The tool being gated. Its presence is what makes a session-long grant
   * offerable -- "always allow" with nothing named is not a decision.
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

export function ApprovalCard({
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

  return (
    <div className="flex w-[780px] max-w-full flex-col gap-3.5 rounded-bubble bg-raised px-[18px] pt-4 pb-[18px]">
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
              const chosen = answeredWith === option.id
              return (
                <QuestionnaireChoice
                  key={option.id}
                  value={option.id}
                  // Controlled in both states: a pending card shows nothing
                  // selected (the store's answer, not the click, is what checks
                  // it), and a resolved card shows the record.
                  checked={pending ? false : chosen}
                  disabled={!pending}
                  onChange={
                    pending
                      ? () => onAnswer?.(option.id, always ? "always" : "once")
                      : undefined
                  }
                  className={cn(
                    // A resolved card dims the roads not taken rather than
                    // hiding them: what was offered is as much of the record as
                    // what was picked. The chosen one stays at full strength.
                    !pending && chosen && "data-disabled:opacity-100",
                  )}
                >
                  <span className={TONE_TEXT[option.tone ?? "default"]}>{option.label}</span>
                </QuestionnaireChoice>
              )
            })}
          </QuestionnaireChoices>
        </QuestionnaireItem>
      </Questionnaire>

      {pending && toolName !== undefined && onAnswer && (
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
