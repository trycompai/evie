import type { BotHealth } from "@evie/contracts/bot"
import { cn } from "@evie/ui/lib/utils"

/**
 * Whether a bot's runtime is up, next to its name.
 *
 * The rail deliberately shows no dot for a healthy thread -- "a green dot for
 * fine is noise" -- and that is the right call for a list you scan. This is the
 * opposite case: one bot, named, in front of you, and the question it answers
 * is the one people were actually asking, which is whether the agent is still
 * there at all. Runtimes stop on their own, so silence is ambiguous in a way it
 * is not for a thread.
 *
 * **`idle` is not an error and must never look like one.** A stopped runtime is
 * the normal resting state of a bot nobody is talking to; the next message
 * starts it again. Colouring that red would teach people that a working product
 * is broken, which is worse than showing nothing. It is grey, and it says so.
 *
 * Static, no pulse. A dot that animates forever repaints forever, and on a
 * 120 Hz display that is a measurable GPU cost for decoration -- see the
 * performance pillar in AGENTS.md.
 */

export interface BotStatusDotProps {
  readonly health: BotHealth
  readonly className?: string
}

interface Presentation {
  readonly tone: string
  readonly label: string
  /** The hover/AT explanation. Says what happens next, not just what is true now. */
  readonly detail: string
}

export const presentHealth = (health: BotHealth): Presentation => {
  switch (health.kind) {
    case "ready":
      return { tone: "bg-success", label: "Online", detail: "Online and ready" }
    case "busy":
      return {
        tone: "bg-success",
        label: "Working",
        detail:
          health.activeTurns === 1 ? "Working on your message" : `Working on ${health.activeTurns} turns`,
      }
    case "starting":
      return { tone: "bg-warning", label: "Starting", detail: "Starting up" }
    case "restarting":
      return {
        tone: "bg-warning",
        label: "Reconnecting",
        detail: `Reconnecting (attempt ${health.attempt})`,
      }
    case "unhealthy":
      return { tone: "bg-error", label: "Unhealthy", detail: health.reason }
    case "idle":
      return {
        tone: "bg-fg-muted",
        label: "Asleep",
        // The reassurance is the point: this is the state a user finds their
        // agent in after leaving it alone, and it is not a failure.
        detail: "Asleep — your next message wakes it",
      }
  }
}

export function BotStatusDot({ health, className }: BotStatusDotProps) {
  const { tone, label, detail } = presentHealth(health)
  return (
    <span
      role="img"
      aria-label={`${label}. ${detail}`}
      title={detail}
      className={cn("size-1.5 shrink-0 rounded-full", tone, className)}
    />
  )
}
