import type { BotHealth } from "@evie/contracts/bot"
import { cn } from "@evie/ui/lib/utils"
import { BotMark, type BotShape, type BotTone } from "@evie/ui/components/bot-mark"
import { BotStatusDot } from "@evie/ui/components/bot-status-dot"
import { MonitorIcon, MoreIcon } from "@evie/ui/components/icon"
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@evie/ui/components/menu"
import { StatusChip, type ThreadState } from "@evie/ui/components/status-chip"

/**
 * The thread's title bar.
 *
 * Resting, it is exactly what the design draws: a mark, a name, and the button
 * that opens the bot's computer. Everything else here -- the status chip, the
 * context meter -- renders nothing until it has something true to say, so a
 * quiet thread has a quiet header rather than a row of "OK" badges.
 */

export interface ThreadHeaderProps {
  readonly name: string
  readonly shape?: BotShape
  readonly tone?: BotTone
  readonly state: ThreadState
  /**
   * The bot's runtime health. Omitted only where there is no bot to speak of
   * (the gallery's bare header); a real thread always has one.
   */
  readonly health?: BotHealth
  /** The context meter, when the window is past half full. */
  readonly meter?: React.ReactNode
  readonly computerOpen?: boolean
  readonly onToggleComputer?: () => void
  /**
   * The bot's verbs, behind one overflow trigger. Both or neither: the menu
   * renders only when at least one is given, so the gallery's bare header and
   * a surface with no bot to manage stay exactly as the design draws them.
   */
  readonly onRenameBot?: () => void
  readonly onDeleteBot?: () => void
}

export function ThreadHeader({
  name,
  shape,
  tone,
  state,
  health,
  meter,
  computerOpen = false,
  onToggleComputer,
  onRenameBot,
  onDeleteBot,
}: ThreadHeaderProps) {
  const hasMenu = onRenameBot !== undefined || onDeleteBot !== undefined
  return (
    <header
      className="flex h-14 shrink-0 items-center gap-2.5 px-5 select-none"
      // The header is the rest of the window's drag handle -- the rail owns the
      // left 280px, this owns the remainder.
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      <span className="flex w-[22px] shrink-0 items-center justify-center">
        <BotMark shape={shape} tone={tone} size={18} />
      </span>
      <h1 className="truncate text-ui font-medium text-fg">{name}</h1>
      {health !== undefined && <BotStatusDot health={health} />}
      <StatusChip state={state} className="shrink-0" />
      <div className="min-w-0 flex-1" />
      {meter}
      {hasMenu && (
        <Menu>
          <MenuTrigger
            aria-label={`More for ${name}`}
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-small text-fg-muted",
              "hover:text-fg focus-visible:ring-2 focus-visible:ring-focus/50 focus-visible:outline-none",
              "data-[popup-open]:bg-raised data-[popup-open]:text-fg",
            )}
          >
            <MoreIcon />
          </MenuTrigger>
          <MenuPopup>
            {onRenameBot && <MenuItem onClick={onRenameBot}>Rename bot…</MenuItem>}
            {onDeleteBot && (
              <MenuItem destructive onClick={onDeleteBot}>
                Delete bot…
              </MenuItem>
            )}
          </MenuPopup>
        </Menu>
      )}
      <button
        type="button"
        onClick={onToggleComputer}
        aria-label="Toggle the bot's computer"
        aria-pressed={computerOpen}
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-small",
          "focus-visible:ring-2 focus-visible:ring-focus/50 focus-visible:outline-none",
          computerOpen ? "bg-raised text-fg" : "text-fg-muted hover:text-fg",
        )}
      >
        <MonitorIcon />
      </button>
    </header>
  )
}
