import { cn } from "@evie/ui/lib/utils"

/**
 * What the thread is doing, in the user's words.
 *
 * `AGENTS.md`: our users notice a dropped frame, a lying spinner, and a stale
 * label. So this component takes the *state*, not a string, and owns the
 * mapping -- there is exactly one place that can put the wrong word on a
 * parked turn, and it is here.
 *
 * Never "Thinking" while waiting on a person. That is the lying spinner.
 */

export type ThreadState =
  | { readonly kind: "ready" }
  | { readonly kind: "thinking"; readonly turnId: string | null }
  | { readonly kind: "running"; readonly tool: string; readonly turnId: string | null }
  | { readonly kind: "waitingOnYou" }
  | { readonly kind: "waitingOnSignIn"; readonly service: string }
  | { readonly kind: "waitingOnSubagent"; readonly name: string }
  | { readonly kind: "compacting" }
  | { readonly kind: "reconnecting" }
  | { readonly kind: "catchingUp" }

interface Rendered {
  readonly label: string
  readonly tone: "quiet" | "attention" | "warn"
  /** Only the indeterminate states tick, and they tick on a 1s steps() interval. */
  readonly ticking: boolean
}

const render = (state: ThreadState): Rendered | null => {
  switch (state.kind) {
    case "ready":
      // Streaming text needs no chip -- the text is moving, which says more
      // than a word would. Same for a settled thread.
      return null
    case "thinking":
      return { label: "Thinking", tone: "quiet", ticking: true }
    case "running":
      return { label: `Running ${state.tool}`, tone: "quiet", ticking: true }
    case "waitingOnYou":
      return { label: "Waiting on you", tone: "attention", ticking: false }
    case "waitingOnSignIn":
      return { label: `Sign in to ${state.service}`, tone: "attention", ticking: false }
    case "waitingOnSubagent":
      return { label: `Waiting on ${state.name}`, tone: "quiet", ticking: true }
    case "compacting":
      return { label: "Compacting context", tone: "quiet", ticking: true }
    case "reconnecting":
      return { label: "Reconnecting", tone: "warn", ticking: true }
    case "catchingUp":
      return { label: "Catching up", tone: "warn", ticking: true }
  }
}

const TONE: Record<Rendered["tone"], string> = {
  quiet: "text-fg-muted",
  attention: "text-fg",
  warn: "text-warning",
}

export function StatusChip({ state, className }: { readonly state: ThreadState; readonly className?: string }) {
  const rendered = render(state)
  if (!rendered) return null
  return (
    <span
      aria-live="polite"
      className={cn(
        "text-metadata",
        TONE[rendered.tone],
        rendered.ticking && "evie-thinking",
        className,
      )}
    >
      {rendered.label}
    </span>
  )
}
