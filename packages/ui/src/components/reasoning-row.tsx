import { useState } from "react"
import { cn } from "@evie/ui/lib/utils"
import { ChevronRightIcon } from "@evie/ui/components/icon"

/**
 * "Thought for 4.2k tokens."
 *
 * Reasoning is streamed live and then discarded — never mirrored, never stored.
 * It is the most sensitive text a model produces, it dominates disk, and nobody
 * rereads it; in a shared organization it would also be one member's half-formed
 * guesses becoming durable, admin-readable history.
 *
 * So this row has two honest states and no third one:
 *   - live turn -> expanding subscribes to this block and the text arrives;
 *   - reopened thread -> the count, and a line saying the text was not kept.
 *
 * The second state is the whole reason this component exists rather than a
 * `<details>`. A row that spins forever on a fetch that can never resolve is
 * the worst version of this feature.
 */

export interface ReasoningRowProps {
  readonly tokens: number
  /** Present only while the turn is live and this block is being watched. */
  readonly text?: string
  /** False once the turn has settled: there is nothing left to subscribe to. */
  readonly live: boolean
  /**
   * Told the server this client wants this block's deltas. The server sends
   * reasoning to nobody by default, which is most of the 40 KB/s budget.
   */
  readonly onWatch?: (watching: boolean) => void
}

const format = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

export function ReasoningRow({ tokens, text, live, onWatch }: ReasoningRowProps) {
  const [open, setOpen] = useState(false)

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (live) onWatch?.(next)
  }

  return (
    <div className="max-w-[780px]">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-metadata text-fg-muted hover:text-fg focus-visible:outline-none"
      >
        <ChevronRightIcon size={12} className={cn("transition-transform", open && "rotate-90")} />
        {live && tokens === 0 ? "Thinking" : `Thought for ${format(tokens)} tokens`}
      </button>

      {open && (
        <div className="pt-2 pl-[18px]">
          {text ? (
            <p className="border-l border-line-subtle pl-3 text-compact whitespace-pre-wrap text-fg-muted">
              {text}
            </p>
          ) : live ? (
            <p className="evie-thinking border-l border-line-subtle pl-3 text-compact text-fg-muted">
              Streaming
            </p>
          ) : (
            <p className="border-l border-line-subtle pl-3 text-compact text-fg-muted">
              Evie streams reasoning live and does not keep it. Only the token count survives a
              reopened thread.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
