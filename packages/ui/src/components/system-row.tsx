import { cn } from "@evie/ui/lib/utils"

/**
 * Quiet rows: something happened to the session, or something failed.
 *
 * Both are centred and small. A compaction is not news, and an error that
 * shouts is an error the user learns to scroll past -- what makes an error
 * useful is the retry next to it, not the colour.
 */

export type SystemEvent = "compacted" | "cleared" | "checkpoint" | "restored" | "budgetReached"

const SYSTEM_LABEL: Record<SystemEvent, string> = {
  compacted: "Context compacted",
  cleared: "Session cleared",
  checkpoint: "Checkpoint saved",
  restored: "Restored from a checkpoint",
  budgetReached: "Budget reached — this bot is paused",
}

export function SystemRow({
  event,
  detail,
  action,
}: {
  readonly event: SystemEvent
  readonly detail?: string
  readonly action?: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-center gap-2 py-1">
      <span className="text-metadata text-fg-muted">
        {SYSTEM_LABEL[event]}
        {detail ? ` · ${detail}` : ""}
      </span>
      {action}
    </div>
  )
}

export function ErrorRow({
  message,
  retryable,
  onRetry,
  onFix,
}: {
  readonly message: string
  readonly retryable: boolean
  readonly onRetry?: () => void
  /** Present for credential problems: the way out is Settings, not a retry. */
  readonly onFix?: () => void
}) {
  return (
    <div className="flex max-w-[780px] items-start gap-3 rounded-default border border-error/30 bg-error/5 px-3.5 py-3">
      <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-error" />
      <p className="min-w-0 flex-1 text-compact text-fg">{message}</p>
      {onFix && (
        <button type="button" onClick={onFix} className={ACTION}>
          Fix in Settings
        </button>
      )}
      {retryable && onRetry && (
        <button type="button" onClick={onRetry} className={ACTION}>
          Retry
        </button>
      )}
    </div>
  )
}

const ACTION = cn(
  "shrink-0 rounded-small px-2 py-1 text-metadata font-medium text-fg",
  "hover:bg-raised focus-visible:ring-2 focus-visible:ring-focus/50 focus-visible:outline-none",
)

/**
 * The one indicator allowed to loop, and it ticks four times a second on a
 * `steps()` interval rather than interpolating per frame. See `globals.css`.
 */
export function ThinkingRow({ label = "Thinking" }: { readonly label?: string }) {
  return (
    <div className="flex items-center gap-2 py-1">
      <span className="evie-thinking text-compact text-fg-muted">{label}</span>
    </div>
  )
}
