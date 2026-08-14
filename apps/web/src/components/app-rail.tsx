import { useState } from "react"
import type { Bot } from "@evie/contracts/bot"
import type { ThreadId } from "@evie/contracts/ids"
import type { Thread } from "@evie/contracts/thread"
import { markOf } from "@evie/ui/components/bot-mark"
import { AccountRow, PluginsRailItem, Rail, RailEmpty } from "@evie/ui/components/rail"
import { SearchField } from "@evie/ui/components/search-field"
import { ThreadRow } from "@evie/ui/components/thread-row"
import { TrafficLights } from "@evie/ui/components/traffic-lights"
import { formatRailTime } from "~/lib/format.ts"

/**
 * The rail, wired to the fleet.
 *
 * Shared by the chat view and the new-bot view because in the design they are
 * the same window with a different right-hand column -- creating a bot is a
 * place you are, not a modal you are trapped in, so the conversations you
 * already have stay one click away.
 */

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
  readonly onOpenAccount: () => void
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
  onOpenAccount,
}: AppRailProps) {
  const [query, setQuery] = useState("")

  const botsById = new Map(bots.map((bot) => [bot.id as string, bot]))

  // Derived during render. At rail size a memo costs more bookkeeping than the
  // filter costs work, and a derived value cannot go stale.
  const needle = query.trim().toLowerCase()
  const visible = needle
    ? threads.filter((thread) => railName(thread, botsById).toLowerCase().includes(needle))
    : threads

  return (
    <Rail
      windowControls={desktop ? <TrafficLights /> : null}
      search={
        <SearchField value={query} onChange={(event) => setQuery(event.target.value)} />
      }
      onNewBot={onNewBot}
      footer={
        <>
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
            return (
              <ThreadRow
                key={thread.id}
                name={railName(thread, botsById)}
                time={formatRailTime(thread.lastActivity)}
                preview={thread.preview ?? ""}
                shape={mark?.shape}
                tone={mark?.tone}
                active={thread.id === activeThreadId}
                health={rowHealth(thread)}
                onSelect={() => onSelectThread(thread.id)}
              />
            )
          })}
    </Rail>
  )
}

/** A thread is named by its bot, or by the room when several bots are in it. */
export const railName = (thread: Thread, bots: ReadonlyMap<string, Bot>): string => {
  if (thread.title) return thread.title
  const names = thread.participants
    .map((participant) => bots.get(participant.botId as string)?.name)
    .filter((name): name is string => Boolean(name))
  return names.length <= 1 ? (names[0] ?? "Untitled") : names.join(" & ")
}

/** Only surfaces a dot when something is working or wrong. Green for "fine" is noise. */
const rowHealth = (thread: Thread) => {
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
