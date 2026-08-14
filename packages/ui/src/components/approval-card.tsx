import { cn } from "@evie/ui/lib/utils"
import { CloseIcon } from "@evie/ui/components/icon"

/**
 * The question card: `input.requested` from eve, rendered in the flow.
 *
 * **Not a modal.** A modal steals focus while a turn is still streaming and
 * forces a decision before you have finished reading the thing you are deciding
 * about. An inline card lets you keep reading, and it stays in the transcript
 * afterwards showing what was chosen -- which a modal cannot do at all.
 *
 * This is table stakes for an agent with shell access, which is why it ships in
 * Phase 1 rather than later.
 */

export interface ApprovalOption {
  readonly id: string
  readonly label: string
  /** The letter in the bordered square. Also the actual keyboard shortcut. */
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
  readonly onAnswer?: (optionId: string) => void
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
  onAnswer,
  onDismiss,
}: ApprovalCardProps) {
  const pending = state === "pending"

  return (
    <div className="flex w-[780px] max-w-full flex-col gap-3.5 rounded-bubble bg-raised px-[18px] pt-4 pb-[18px]">
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 text-body text-fg">{prompt}</p>
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

      <div className="flex flex-col overflow-hidden rounded-default border border-line-subtle">
        {options.map((option, i) => {
          const chosen = answeredWith === option.id
          return (
            <button
              key={option.id}
              type="button"
              disabled={!pending}
              onClick={() => onAnswer?.(option.id)}
              className={cn(
                "flex h-12 shrink-0 items-center gap-3 px-3.5 text-left",
                i < options.length - 1 && "border-b border-line-subtle",
                pending && "hover:bg-raised-strong/50 focus-visible:bg-raised-strong/50",
                "focus-visible:outline-none",
                // A resolved card dims the roads not taken rather than hiding
                // them: what was offered is as much of the record as what was
                // picked.
                !pending && !chosen && "opacity-40",
              )}
            >
              <span
                className={cn(
                  "flex size-[22px] shrink-0 items-center justify-center rounded-small border text-[12px] leading-3",
                  chosen ? "border-fg bg-fg text-surface" : "border-line text-fg-muted",
                )}
              >
                {option.hotkey ?? String.fromCharCode(65 + i)}
              </span>
              <span className={cn("min-w-0 flex-1 text-body leading-[22px]", TONE_TEXT[option.tone ?? "default"])}>
                {option.label}
              </span>
            </button>
          )
        })}
      </div>

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
