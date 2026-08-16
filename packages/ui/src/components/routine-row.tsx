import { cn } from "@evie/ui/lib/utils"
import { describeCron } from "@evie/ui/lib/cron"

/**
 * One routine.
 *
 * The line under the name is the whole point of the row: a person scanning
 * this list wants "Weekdays at 9:00 AM", not `0 9 * * 1-5`, and they want the
 * zone next to it because the one thing a schedule can silently get wrong is
 * which morning it means.
 *
 * Three states, and they are deliberately not one flag. **Paused** is someone's
 * choice and reverses with the same control that made it. **Blocked** is the
 * scheduler taking the routine out of service on its own -- the run-as member
 * left -- so it explains itself and cannot be resumed by flipping a switch,
 * because the thing to fix is not the switch. Everything else is **live**, and
 * says when it next runs.
 */

export interface RoutineRowProps {
  readonly name: string
  readonly cron: string
  readonly tz: string
  readonly enabled: boolean
  readonly blockedReason: string | null
  /** Preformatted by the caller, which owns the viewer's locale. */
  readonly nextRun: string | null
  readonly lastRun: string | null
  /** Shown when the list spans more than one bot. */
  readonly botName?: string
  readonly onToggle: () => void
  readonly onDelete: () => void
}

export function RoutineRow({
  name,
  cron,
  tz,
  enabled,
  blockedReason,
  nextRun,
  lastRun,
  botName,
  onToggle,
  onDelete,
}: RoutineRowProps) {
  const blocked = blockedReason !== null
  const live = enabled && !blocked

  return (
    <div className="flex min-w-0 items-start gap-3.5 rounded-default px-3.5 py-3 hover:bg-raised">
      <span
        aria-hidden
        className={cn(
          "mt-1.5 size-2 shrink-0 rounded-full",
          blocked ? "bg-error" : enabled ? "bg-success" : "bg-fg-muted/40",
        )}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-ui font-medium text-fg">{name}</span>
          {botName !== undefined && (
            <span className="shrink-0 truncate text-metadata text-fg-muted">{botName}</span>
          )}
        </div>
        <span className="truncate text-compact text-fg-muted">
          {describeCron(cron)} · {tz}
        </span>
        <span
          className={cn(
            "truncate text-metadata",
            blocked ? "text-error" : "text-fg-muted",
          )}
        >
          {blocked
            ? blockedReason
            : !enabled
              ? "Paused"
              : nextRun !== null
                ? `Next run ${nextRun}`
                : lastRun !== null
                  ? `Last run ${lastRun}`
                  : "Waiting for its first run"}
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {/*
          Blocked routines still offer the toggle, because pausing one is a
          reasonable thing to do while you go fix why it broke. What they do
          not do is claim that resuming would help.
        */}
        <RowAction onClick={onToggle}>{live ? "Pause" : "Resume"}</RowAction>
        <RowAction onClick={onDelete} destructive>
          Delete
        </RowAction>
      </div>
    </div>
  )
}

function RowAction({
  children,
  onClick,
  destructive = false,
}: {
  readonly children: React.ReactNode
  readonly onClick: () => void
  readonly destructive?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-8 items-center rounded-small px-3 text-compact font-medium select-none",
        "focus-visible:ring-2 focus-visible:ring-focus/50 focus-visible:outline-none",
        destructive
          ? "text-fg-muted hover:bg-error/10 hover:text-error"
          : "text-fg-muted hover:bg-raised-strong hover:text-fg",
      )}
    >
      {children}
    </button>
  )
}
