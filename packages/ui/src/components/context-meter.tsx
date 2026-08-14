import { cn } from "@evie/ui/lib/utils"

/**
 * How full the context window is, and when it was last compacted.
 *
 * A bar rather than a number, because the question a user actually has is "am I
 * about to lose the earlier part of this conversation", and a ratio answers it
 * without arithmetic. The number is there on hover for the people who want it.
 *
 * It only appears past half full. A meter that is always visible and always
 * fine trains people to stop seeing it, and then it is not there when it
 * matters.
 */

const THRESHOLD = 0.5

export interface ContextMeterProps {
  readonly used: number
  readonly window: number
  /** Formatted for the viewer: "2 minutes ago". Omit if this session never compacted. */
  readonly lastCompacted?: string
  readonly className?: string
}

const format = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n)

export function ContextMeter({ used, window, lastCompacted, className }: ContextMeterProps) {
  if (window <= 0) return null
  const ratio = Math.min(used / window, 1)
  if (ratio < THRESHOLD) return null

  const tone = ratio > 0.9 ? "bg-warning" : "bg-fg-muted"

  return (
    <div
      className={cn("flex items-center gap-2", className)}
      title={`${format(used)} of ${format(window)} tokens${lastCompacted ? ` · compacted ${lastCompacted}` : ""}`}
    >
      <div className="h-1 w-16 overflow-hidden rounded-full bg-raised-strong">
        {/* Width is inline because it is data, not a design decision -- there is
            no Tailwind class for 63.4%. No transition: a bar that eases while
            tokens stream is a bar that is always wrong. */}
        <div className={cn("h-full rounded-full", tone)} style={{ width: `${ratio * 100}%` }} />
      </div>
      <span className="text-metadata text-fg-muted tabular-nums">
        {format(used)}/{format(window)}
      </span>
    </div>
  )
}
