import { cn } from "@evie/ui/lib/utils"
import { ChevronUpDownIcon, PlugIcon, PlusIcon } from "@evie/ui/components/icon"
import { MemberAvatar } from "@evie/ui/components/member-chip"
import { TrafficLights } from "@evie/ui/components/traffic-lights"

/**
 * The left rail: 280px of window chrome, conversations, and the account.
 *
 * It owns the top of the window because the desktop shell hides the native
 * titlebar, which is why `TrafficLights` lives in its header rather than in a
 * separate bar. The rail's children are supplied by the app so this file stays
 * free of store access -- UI stays dumb.
 */

export interface RailProps {
  /** Rendered only in the desktop shell; the browser has no window to close. */
  readonly windowControls?: React.ReactNode
  readonly search: React.ReactNode
  /** Thread rows, or an empty state. */
  readonly children: React.ReactNode
  readonly onNewBot?: () => void
  readonly footer: React.ReactNode
  readonly className?: string
}

export function Rail({ windowControls, search, children, onNewBot, footer, className }: RailProps) {
  return (
    <aside
      className={cn(
        "flex h-full w-[280px] shrink-0 flex-col border-r border-line-subtle bg-surface",
        className,
      )}
    >
      {/*
        `app-region: drag` makes the whole header a window handle in Electron.
        The buttons inside opt back out, or they would be undraggable *and*
        unclickable.
      */}
      <div
        className="flex w-full items-center gap-2 pt-3.5 pr-2.5 pb-2.5 pl-4"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        {windowControls}
        <div className="min-w-0 flex-1" />
        <button
          type="button"
          onClick={onNewBot}
          aria-label="New bot"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-small text-fg",
            "hover:bg-raised focus-visible:ring-2 focus-visible:ring-focus/50 focus-visible:outline-none",
          )}
        >
          <PlusIcon />
        </button>
      </div>

      <div className="flex w-full items-center px-3 pb-3">{search}</div>

      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-3">{children}</div>

      <div className="flex shrink-0 flex-col px-3 pt-2 pb-3">{footer}</div>
    </aside>
  )
}

export { TrafficLights }

export interface RailItemProps {
  readonly icon: React.ReactNode
  readonly label: string
  readonly onSelect?: () => void
  readonly trailing?: React.ReactNode
}

/**
 * A single-line rail action -- Plugins, Settings.
 *
 * The 22px leading slot and 18px trailing slot are fixed even when empty, so
 * every label in the footer starts on the same vertical lane whether or not its
 * row has a trailing control.
 */
export function RailItem({ icon, label, onSelect, trailing }: RailItemProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex h-[34px] shrink-0 items-center gap-2.5 rounded-small px-2 text-left",
        "hover:bg-raised focus-visible:ring-2 focus-visible:ring-focus/50 focus-visible:outline-none",
      )}
    >
      <span className="flex w-[22px] shrink-0 items-center justify-center text-fg-muted">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-ui text-fg">{label}</span>
      <span className="flex w-[18px] shrink-0 items-center justify-center text-fg-muted">{trailing}</span>
    </button>
  )
}

export function PluginsRailItem({ onSelect }: { readonly onSelect?: () => void }) {
  return <RailItem icon={<PlugIcon />} label="Plugins" onSelect={onSelect} />
}

export interface AccountRowProps {
  readonly name: string
  readonly image?: string | null
  /**
   * Where this environment is running, in the user's words: "This Mac",
   * "studio.local", "via Tailscale". Naming the machine is what makes remote
   * access legible instead of magic.
   */
  readonly location: string
  /** Drives the dot. Anything but `online` is worth a colour. */
  readonly presence?: "online" | "connecting" | "offline"
  readonly onSelect?: () => void
}

const PRESENCE_DOT = {
  online: "bg-success",
  connecting: "bg-warning",
  offline: "bg-fg-muted",
} as const

export function AccountRow({ name, image, location, presence = "online", onSelect }: AccountRowProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex h-11 shrink-0 items-center gap-2.5 rounded-small px-2 text-left",
        "hover:bg-raised focus-visible:ring-2 focus-visible:ring-focus/50 focus-visible:outline-none",
      )}
    >
      <span className="flex w-[22px] shrink-0 items-center justify-center">
        <MemberAvatar name={name} image={image} size={22} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="truncate text-[15px] leading-[18px] font-medium text-fg">{name}</span>
        <span className="flex items-center gap-[5px]">
          <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", PRESENCE_DOT[presence])} />
          <span className="truncate text-[13px] leading-4 text-fg-muted">{location}</span>
        </span>
      </span>
      <span className="flex w-[18px] shrink-0 items-center justify-center text-fg-muted">
        <ChevronUpDownIcon />
      </span>
    </button>
  )
}

/** The rail before the first bot exists. Short, and it names the next action. */
export function RailEmpty({ label = "No chats yet" }: { readonly label?: string }) {
  return (
    <div className="flex flex-1 items-center justify-center px-4">
      <p className="text-compact text-fg-muted">{label}</p>
    </div>
  )
}
