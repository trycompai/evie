import { cn } from "@evie/ui/lib/utils"
import { BotMark, type BotShape, type BotTone } from "@evie/ui/components/bot-mark"

/**
 * One row in the rail.
 *
 * The rail lists conversations, each led by its bot's mark and name. In the
 * common case -- one bot per thread -- that is also a list of bots, which is
 * the shape the product promises: you are messaging a colleague, not opening a
 * document. A multi-participant thread stacks two marks and names the room.
 *
 * Every slot here is fixed-width (`size-[34px]` for the mark, `shrink-0` for
 * the timestamp) so a bot called "Ops" and one called "Quarterly Reporting"
 * put their timestamps in the same vertical lane.
 */

/** Only rendered when something is wrong or working. A green dot for "fine" is noise. */
export type RowHealth = "ok" | "busy" | "waiting" | "unhealthy"

const HEALTH_DOT: Record<Exclude<RowHealth, "ok">, string> = {
  busy: "bg-fg-muted",
  waiting: "bg-warning",
  unhealthy: "bg-error",
}

export interface ThreadRowProps {
  readonly name: string
  /** Already formatted for the viewer's locale: "3:53 PM", "Yesterday", "Mar 4". */
  readonly time: string
  readonly preview: string
  readonly shape?: BotShape
  readonly tone?: BotTone
  readonly active?: boolean
  readonly unread?: boolean
  readonly health?: RowHealth
  readonly onSelect?: () => void
}

export function ThreadRow({
  name,
  time,
  preview,
  shape,
  tone,
  active = false,
  unread = false,
  health = "ok",
  onSelect,
}: ThreadRowProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex w-full items-center gap-3 rounded-default p-2.5 text-left select-none",
        "focus-visible:ring-2 focus-visible:ring-focus/50 focus-visible:outline-none",
        active ? "bg-raised" : "hover:bg-raised/60",
      )}
    >
      <span className="relative flex size-[34px] shrink-0 items-center justify-center">
        <BotMark shape={shape} tone={tone} size={34} />
        {health !== "ok" && (
          <span
            aria-hidden
            className={cn(
              "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-surface",
              HEALTH_DOT[health],
            )}
          />
        )}
      </span>

      <span className="flex min-w-0 flex-1 flex-col gap-0.5 overflow-hidden">
        <span className="flex items-baseline gap-2">
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-ui",
              unread ? "font-semibold text-fg" : "font-medium text-fg",
            )}
          >
            {name}
          </span>
          <span className="shrink-0 text-metadata text-fg-muted">{time}</span>
        </span>
        {/*
          19px rather than the 20px `--leading-compact` step: the design tightens
          the preview line so a two-line row still clears 34px of avatar.
        */}
        <span className="truncate text-[14px] leading-[19px] text-fg-muted">{preview}</span>
      </span>
    </button>
  )
}
