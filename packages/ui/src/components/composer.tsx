import { useState } from "react"
import { cn } from "@evie/ui/lib/utils"
import { ArrowUpIcon, MicIcon, PlusLargeIcon, StopIcon } from "@evie/ui/components/icon"

/**
 * The composer.
 *
 * The trailing button is one control with three truthful states, not three
 * controls that appear and disappear: dictate when there is nothing to send,
 * send when there is, stop while a turn is running. A send button that stays
 * lit during a turn is the same lie as a spinner that says "thinking" while the
 * agent is parked.
 *
 * Height comes from `field-sizing: content` rather than a measure-and-set
 * effect. The browser already knows how tall the text is; asking it is one CSS
 * declaration, and the effect version reflows on every keystroke.
 */

export interface ComposerProps {
  readonly placeholder: string
  readonly value: string
  readonly onChange: (value: string) => void
  readonly onSend: () => void
  /**
   * Omit when the caller cannot cancel. The button then stays Send, which is
   * honest: sending mid-turn steers it.
   */
  readonly onStop?: () => void
  readonly onAttach?: () => void
  readonly onDictate?: () => void
  /** A turn is in flight for this thread. */
  readonly streaming?: boolean
  readonly disabled?: boolean
  /** Approval cards, attachment chips, a *catching up* notice. */
  readonly children?: React.ReactNode
}

export function Composer({
  placeholder,
  value,
  onChange,
  onSend,
  onStop,
  onAttach,
  onDictate,
  streaming = false,
  disabled = false,
  children,
}: ComposerProps) {
  const [composing, setComposing] = useState(false)
  const hasText = value.trim().length > 0

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // An IME candidate window swallows Enter to accept a suggestion. Sending on
    // that keystroke posts a half-typed message in every CJK locale.
    if (composing) return

    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      if (streaming) onStop?.()
      return
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      if (hasText && !disabled) onSend()
    }
  }

  /*
   * Stop is offered only when the caller can actually stop something. Rendering
   * it whenever a turn is running -- and having it do nothing because the turn
   * id has not been threaded through yet -- is the same class of lie as a
   * spinner that says "thinking" while the agent is parked.
   *
   * Falling through to Send during a turn is truthful rather than a
   * consolation: eve's default `turnPolicy` is "steer", so a message sent
   * mid-turn cancels the in-flight one and starts a replacement. That is what a
   * chat UI implies and what the button does.
   */
  const canStop = streaming && onStop !== undefined

  const trailing = canStop
    ? { label: "Stop", icon: <StopIcon />, action: onStop }
    : hasText
      ? { label: "Send", icon: <ArrowUpIcon />, action: onSend }
      : { label: "Dictate", icon: <MicIcon />, action: onDictate }

  return (
    <div className="flex shrink-0 flex-col gap-2 px-7 pt-2 pb-5">
      {children}
      <div className="flex min-h-14 items-center gap-3 rounded-composer bg-raised px-2.5 py-2.5">
        <button
          type="button"
          onClick={onAttach}
          aria-label="Attach"
          className={cn(
            "flex size-9 shrink-0 items-center justify-center self-end rounded-full bg-raised-strong text-fg",
            "hover:opacity-80 focus-visible:ring-2 focus-visible:ring-focus/50 focus-visible:outline-none",
          )}
        >
          <PlusLargeIcon />
        </button>

        <textarea
          rows={1}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          className={cn(
            "min-w-0 flex-1 resize-none self-center bg-transparent text-body text-fg outline-none",
            "field-sizing-content max-h-[40vh] placeholder:text-fg-muted",
          )}
        />

        <button
          type="button"
          onClick={trailing.action}
          aria-label={trailing.label}
          disabled={disabled && !canStop}
          className={cn(
            "flex size-9 shrink-0 items-center justify-center self-end rounded-full bg-fg text-surface",
            "hover:opacity-90 focus-visible:ring-2 focus-visible:ring-focus/50 focus-visible:outline-none",
            "disabled:opacity-40",
          )}
        >
          {trailing.icon}
        </button>
      </div>
    </div>
  )
}
