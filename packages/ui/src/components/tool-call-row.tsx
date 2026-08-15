import { useState } from "react"
import { cn } from "@evie/ui/lib/utils"
import { ChevronRightIcon } from "@evie/ui/components/icon"

/**
 * A tool call.
 *
 * A first-class row, not a message part: it has its own lifecycle, its own
 * expansion state, and its own truncation rules, so collapsing tools is a list
 * operation rather than a re-parse of somebody's prose.
 *
 * Collapsed it is one line -- name, argument, duration, state -- because a
 * fifteen-step turn should read as a paragraph of work, not fifteen cards.
 */

export type ToolState = "pending" | "running" | "ok" | "error" | "cancelled"

const STATE_DOT: Record<ToolState, string> = {
  pending: "bg-fg-muted/40",
  running: "bg-fg-muted",
  ok: "bg-success",
  error: "bg-error",
  cancelled: "bg-fg-muted/40",
}

export interface ToolCallRowProps {
  readonly name: string
  /** The one-line gist of the input: `ls /workspace/data`. Already truncated. */
  readonly summary?: string
  readonly state: ToolState
  readonly durationMs?: number
  /** Head + tail of an oversized payload, or the whole thing when it fit. */
  readonly body?: string
  /** Set when the payload exceeded 8 KiB and the rest lives in a blob. */
  readonly truncated?: boolean
  readonly byteSize?: number
  /**
   * Fetches the full payload. Called on first expand of a truncated row --
   * never eagerly, and never over the RPC socket.
   */
  readonly onFetchFull?: () => void
}

const formatDuration = (ms: number): string =>
  ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60_000)}m`

const formatBytes = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`

export function ToolCallRow({
  name,
  summary,
  state,
  durationMs,
  body,
  truncated = false,
  byteSize,
  onFetchFull,
}: ToolCallRowProps) {
  const [open, setOpen] = useState(false)

  const toggle = () => {
    // Expanding a truncated row is the only thing that fetches the blob, and it
    // fetches once. `body` arriving replaces this branch on the next render.
    if (!open && truncated && onFetchFull) onFetchFull()
    setOpen((v) => !v)
  }

  return (
    <div className="max-w-[780px] overflow-hidden rounded-default border border-line-subtle bg-raised/60">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex h-9 w-full items-center gap-2.5 px-3 text-left select-none hover:bg-raised focus-visible:outline-none"
      >
        <span className="flex w-4 shrink-0 items-center justify-center text-fg-muted">
          <ChevronRightIcon className={cn("transition-transform", open && "rotate-90")} />
        </span>
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", STATE_DOT[state])} />
        <span className="shrink-0 font-mono text-metadata text-fg">{name}</span>
        {summary && (
          <span className="min-w-0 flex-1 truncate font-mono text-metadata text-fg-muted">{summary}</span>
        )}
        {!summary && <span className="min-w-0 flex-1" />}
        {durationMs !== undefined && (
          <span className="shrink-0 text-metadata text-fg-muted tabular-nums">
            {formatDuration(durationMs)}
          </span>
        )}
      </button>

      {open && (
        <div className="border-t border-line-subtle px-3 py-2.5">
          <pre className="overflow-x-auto font-mono text-metadata whitespace-pre-wrap text-fg-muted">
            {body ?? "…"}
          </pre>
          {truncated && (
            <p className="pt-2 text-metadata text-fg-muted">
              Showing the first and last 2 KB of {byteSize ? formatBytes(byteSize) : "a large payload"}.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
