import { useState } from "react"
import type { Bot } from "@evie/contracts/bot"
import type { ThreadId, TurnId } from "@evie/contracts/ids"
import type { Thread } from "@evie/contracts/thread"
import { markOf } from "@evie/ui/components/bot-mark"
import { ComputerPane, TerminalView, type ComputerTab } from "@evie/ui/components/computer-pane"
import { Composer } from "@evie/ui/components/composer"
import { DayDivider } from "@evie/ui/components/message"
import { ThreadHeader } from "@evie/ui/components/thread-header"
import { FileTree } from "~/components/file-tree.tsx"
import { Timeline } from "~/components/timeline.tsx"
import { formatDayDivider } from "~/lib/format.ts"

/**
 * The thread pane: header, timeline, composer, and the bot's computer.
 *
 * Owns composition and local view state -- the draft, which pane is open. It
 * owns no server state: the timeline subscribes per row from the store, and
 * everything else arrives as props from the shell.
 */

export interface ThreadPaneProps {
  readonly thread: Thread
  readonly bot: Bot
  readonly viewerId: string
  readonly nameOf?: (userId: string) => string | undefined
  readonly onSend: (threadId: ThreadId, text: string) => void
  /** Given the in-flight turn, which the status carries while one is running. */
  readonly onStop: (threadId: ThreadId, turnId: TurnId) => void
  readonly onAnswerInput: (
    threadId: ThreadId,
    requestId: string,
    optionId: string,
    scope: "once" | "always",
  ) => void
  readonly onWatchReasoning: (threadId: ThreadId, itemId: string, watching: boolean) => void
  readonly onOpenSandboxSettings?: () => void
}

export function ThreadPane({
  thread,
  bot,
  viewerId,
  nameOf,
  onSend,
  onStop,
  onAnswerInput,
  onWatchReasoning,
  onOpenSandboxSettings,
}: ThreadPaneProps) {
  // Per thread, so switching away and back does not lose what you were half-way
  // through typing. Keyed by id rather than reset on prop change, which is the
  // version of this that quietly eats a paragraph.
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [computerOpen, setComputerOpen] = useState(false)
  const [computerTab, setComputerTab] = useState<ComputerTab>("files")

  const draft = drafts[thread.id] ?? ""
  const mark = markOf(bot)
  // Stop is offered only when eve actually named the turn. Without an id
  // `CancelTurn` has nothing to cancel, so the composer falls back to Send --
  // which steers the running turn, and is true rather than merely reassuring.
  const activeTurn =
    thread.status.kind === "thinking" || thread.status.kind === "running"
      ? thread.status.turnId
      : null
  const streaming = thread.status.kind === "thinking" || thread.status.kind === "running"

  const send = () => {
    const text = draft.trim()
    if (text.length === 0) return
    onSend(thread.id, text)
    setDrafts((current) => ({ ...current, [thread.id]: "" }))
  }

  return (
    <>
      <main className="flex min-w-0 flex-1 flex-col">
        <ThreadHeader
          name={bot.name}
          shape={mark.shape}
          tone={mark.tone}
          state={thread.status}
          computerOpen={computerOpen}
          onToggleComputer={() => setComputerOpen((open) => !open)}
        />
        <Timeline
          threadId={thread.id}
          viewerId={viewerId}
          nameOf={nameOf}
          header={<DayDivider label={formatDayDivider(thread.createdAt)} />}
          onAnswerInput={(requestId, optionId, scope) =>
            onAnswerInput(thread.id, requestId, optionId, scope)
          }
          onWatchReasoning={(itemId, watching) => onWatchReasoning(thread.id, itemId, watching)}
        />
        <Composer
          placeholder={`Message ${bot.name}`}
          value={draft}
          onChange={(value) => setDrafts((current) => ({ ...current, [thread.id]: value }))}
          onSend={send}
          onStop={activeTurn === null ? undefined : () => onStop(thread.id, activeTurn)}
          streaming={streaming}
        />
      </main>

      {computerOpen && (
        <ComputerPane
          tab={computerTab}
          onTabChange={setComputerTab}
          onOpenSettings={onOpenSandboxSettings}
          sandbox={{
            backend: bot.sandbox.backend,
            mode: bot.sandbox.network.mode,
            allowed: bot.sandbox.network.allow.length,
            enforced: bot.sandbox.network.enforced,
          }}
        >
          {computerTab === "files" ? <FileTree botId={bot.id} /> : null}
          {computerTab === "terminal" ? <TerminalView lines={[]} /> : null}
        </ComputerPane>
      )}
    </>
  )
}

/**
 * The main column with no conversation in it.
 *
 * Four of these now, and they say four different things on purpose. "Pick a
 * conversation" in front of someone who followed a link to a deleted thread is
 * not an empty state, it is the app pretending nothing happened -- and it
 * leaves a dead id in the address bar with no way to clear it.
 */
function Pane({
  title,
  body,
  action,
}: {
  readonly title: string
  readonly body: string
  readonly action?: { readonly label: string; readonly onSelect: () => void }
}) {
  return (
    <main className="flex min-w-0 flex-1 flex-col items-center justify-center gap-4 px-8">
      <p className="text-lede text-fg">{title}</p>
      <p className="max-w-[420px] text-center text-compact text-fg-muted">{body}</p>
      {action && (
        <button
          type="button"
          onClick={action.onSelect}
          className="rounded-pill bg-fg px-5 py-2.5 text-ui font-medium text-surface select-none hover:opacity-90"
        >
          {action.label}
        </button>
      )}
    </main>
  )
}

/**
 * No thread selected. Two problems, not one: an account with bots is one click
 * from work, and an account with none needs to be told what a bot even is.
 */
export function EmptyPane({
  hasBots,
  onNewBot,
}: {
  readonly hasBots: boolean
  readonly onNewBot: () => void
}) {
  return hasBots ? (
    <Pane
      title="Pick a conversation"
      body="Everything your bots have been doing is in the rail."
    />
  ) : (
    <Pane
      title="Create your first bot"
      body="A bot is a role you set up once and keep talking to. It gets its own computer, and it keeps working after you close the laptop."
      action={{ label: "New bot", onSelect: onNewBot }}
    />
  )
}

/**
 * The environment says this conversation is not one of yours -- deleted, or
 * never here. The way out is the point: the URL still names it, and without a
 * button the only fix is editing the address bar.
 */
export function MissingThreadPane({ onLeave }: { readonly onLeave: () => void }) {
  return (
    <Pane
      title="That conversation is gone"
      body="It was deleted, or it belongs to a different environment. Everything else is still in the rail."
      action={{ label: "Back to your conversations", onSelect: onLeave }}
    />
  )
}

/**
 * The environment confirmed the conversation, but this client cannot draw it:
 * either the thread is outside the rail's window -- it carries the hundred most
 * recent active threads, so archived, snoozed and older ones are not in it --
 * or the bot that owns it has been archived. Two causes, one honest sentence,
 * and neither of them is "gone".
 */
export function UnlistedThreadPane({ onLeave }: { readonly onLeave: () => void }) {
  return (
    <Pane
      title="This conversation isn't available here"
      body="It is outside the rail's recent list, or the bot that owns it has been archived. Everything else is still in the rail."
      action={{ label: "Back to your conversations", onSelect: onLeave }}
    />
  )
}
