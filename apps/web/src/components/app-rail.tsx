import { useRef, useState } from "react"
import type { Bot } from "@evie/contracts/bot"
import type { ThreadId } from "@evie/contracts/ids"
import type { Thread } from "@evie/contracts/thread"
import { markOf } from "@evie/ui/components/bot-mark"
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuPopup,
  ContextMenuTrigger,
} from "@evie/ui/components/menu"
import { AccountRow, PluginsRailItem, Rail, RailEmpty, RoutinesRailItem } from "@evie/ui/components/rail"
import { SearchField } from "@evie/ui/components/search-field"
import { ThreadRow } from "@evie/ui/components/thread-row"
import { gazeArea } from "@evie/ui/lib/gaze"
import { WindowControls } from "~/components/window-controls.tsx"
import { formatRailTime } from "~/lib/format.ts"

/**
 * The rail, wired to the fleet.
 *
 * Shared by the chat view and the new-bot view because in the design they are
 * the same window with a different right-hand column -- creating a bot is a
 * place you are, not a modal you are trapped in, so the conversations you
 * already have stay one click away.
 */

/**
 * The rail's bots watch the cursor. Built once at module scope so the ref
 * identity never changes across renders; the defaults are tuned to the rail's
 * 280px column.
 */
const railGaze = gazeArea()

export interface AppRailProps {
  readonly bots: readonly Bot[]
  readonly threads: readonly Thread[]
  readonly activeThreadId: ThreadId | null
  /** Set while the new-bot pane is open, so its rail row reads as selected. */
  readonly composingBot?: boolean
  readonly accountName: string
  readonly accountImage?: string | null
  readonly location: string
  readonly desktop?: boolean
  readonly onSelectThread: (threadId: ThreadId) => void
  readonly onNewBot: () => void
  readonly onOpenPlugins: () => void
  readonly onOpenRoutines: () => void
  readonly onOpenAccount: () => void
  /**
   * Right-click on a row: the row's bot's verbs, same as the thread header's
   * menu. Optional together -- the gallery's rails have no fleet to manage.
   */
  readonly onRenameBot?: (bot: Bot) => void
  readonly onDeleteBot?: (bot: Bot) => void
}

export function AppRail({
  bots,
  threads,
  activeThreadId,
  composingBot = false,
  accountName,
  accountImage,
  location,
  desktop = false,
  onSelectThread,
  onNewBot,
  onOpenPlugins,
  onOpenRoutines,
  onOpenAccount,
  onRenameBot,
  onDeleteBot,
}: AppRailProps) {
  const [query, setQuery] = useState("")

  const botsById = new Map(bots.map((bot) => [bot.id as string, bot]))

  const known = useRef<Set<string> | null>(null)
  const born = useRef<Set<string>>(new Set())
  noteNewBots(bots, known, born)

  // Derived during render. At rail size a memo costs more bookkeeping than the
  // filter costs work, and a derived value cannot go stale.
  //
  // A thread none of whose bots are in the fleet belongs to archived bots only
  // -- the fleet carries every live bot, so "not found" can mean nothing else.
  // Those rows hide with their owner: a deleted bot that kept its conversations
  // in the sidebar would not read as deleted, and they come straight back when
  // the bot is restored.
  const needle = query.trim().toLowerCase()
  const owned = threads.filter((thread) =>
    thread.participants.some((participant) => botsById.has(participant.botId as string)),
  )
  const visible = needle
    ? owned.filter((thread) => railName(thread, botsById).toLowerCase().includes(needle))
    : owned

  return (
    <Rail
      windowControls={desktop ? <WindowControls /> : null}
      search={
        <SearchField value={query} onChange={(event) => setQuery(event.target.value)} />
      }
      onNewBot={onNewBot}
      listRef={railGaze}
      footer={
        <>
          <RoutinesRailItem onSelect={onOpenRoutines} />
          <PluginsRailItem onSelect={onOpenPlugins} />
          <AccountRow
            name={accountName}
            image={accountImage}
            location={location}
            onSelect={onOpenAccount}
          />
        </>
      }
    >
      {composingBot && (
        <ThreadRow
          name="Create your first bot"
          time=""
          preview=""
          active
          onSelect={onNewBot}
        />
      )}

      {visible.length === 0
        ? !composingBot && <RailEmpty label={needle ? "No matches" : "No chats yet"} />
        : visible.map((thread) => {
            const bot = botsById.get(thread.participants[0]?.botId ?? "")
            const mark = bot ? markOf(bot) : undefined
            const row = (
              <ThreadRow
                key={thread.id}
                name={railName(thread, botsById)}
                time={formatRailTime(thread.lastActivity)}
                preview={thread.preview ?? ""}
                shape={mark?.shape}
                tone={mark?.tone}
                active={thread.id === activeThreadId}
                health={rowHealth(thread, bot)}
                awake={bot ? born.current.has(bot.id as string) : false}
                onSelect={() => onSelectThread(thread.id)}
              />
            )
            if (!bot || !onRenameBot || !onDeleteBot) return row
            return (
              <ContextMenu key={thread.id}>
                <ContextMenuTrigger>{row}</ContextMenuTrigger>
                <ContextMenuPopup>
                  <ContextMenuItem onClick={() => onRenameBot(bot)}>Rename bot…</ContextMenuItem>
                  <ContextMenuItem destructive onClick={() => onDeleteBot(bot)}>
                    Delete bot…
                  </ContextMenuItem>
                </ContextMenuPopup>
              </ContextMenu>
            )
          })}
    </Rail>
  )
}

/**
 * Records which bots came into being while the user was watching.
 *
 * Only those wake up. The first render seeds `known` without marking anything,
 * because a fleet of twelve faces all opening their eyes every time you launch
 * the app is a screensaver, not a greeting -- the moment is worth animating
 * precisely because it is rare.
 *
 * A bot stays in `born` for the session rather than being cleared after it
 * plays. The wake is a mount animation, so a second render does not replay it,
 * and clearing the flag on the next render would instead cancel it a frame in.
 *
 * Mutating refs during render is safe here because it is idempotent: React
 * rendering this twice reaches the same two sets.
 */
function noteNewBots(
  bots: readonly Bot[],
  known: React.RefObject<Set<string> | null>,
  born: React.RefObject<Set<string>>,
): void {
  if (known.current === null) {
    known.current = new Set(bots.map((bot) => bot.id as string))
    return
  }
  for (const bot of bots) {
    const id = bot.id as string
    if (known.current.has(id)) continue
    known.current.add(id)
    born.current.add(id)
  }
}

/** A thread is named by its bot, or by the room when several bots are in it. */
export const railName = (thread: Thread, bots: ReadonlyMap<string, Bot>): string => {
  if (thread.title) return thread.title
  const names = thread.participants
    .map((participant) => bots.get(participant.botId as string)?.name)
    .filter((name): name is string => Boolean(name))
  return names.length <= 1 ? (names[0] ?? "Untitled") : names.join(" & ")
}

/**
 * Only surfaces a dot when something is working or wrong. Green for "fine" is
 * noise in a list you scan -- the positive "this agent is up" indicator belongs
 * in the header, on the one bot you are looking at (`BotStatusDot`).
 *
 * A bot whose runtime is unhealthy still gets a dot here, because that is the
 * case the rule was hiding: create four bots, watch one fail its install, and
 * the rail said nothing at all -- the thread's own status is `ready`, since
 * nothing has been asked of it yet. "Wrong" has to include the bot, not just
 * the conversation.
 */
const rowHealth = (thread: Thread, bot: Bot | undefined) => {
  if (bot?.health.kind === "unhealthy") return "unhealthy" as const
  switch (thread.status.kind) {
    case "waitingOnYou":
    case "waitingOnSignIn":
      return "waiting" as const
    case "thinking":
    case "running":
      return "busy" as const
    case "reconnecting":
      return "unhealthy" as const
    default:
      return "ok" as const
  }
}
