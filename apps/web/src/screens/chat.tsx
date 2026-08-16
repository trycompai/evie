import { useState } from "react"
import { useQueryState } from "nuqs"
import type { Bot } from "@evie/contracts/bot"
import type { BotId, ThreadId, TurnId } from "@evie/contracts/ids"
import type { Thread } from "@evie/contracts/thread"
import { BotMark, markOf } from "@evie/ui/components/bot-mark"
import type { BotShape, BotTone } from "@evie/ui/components/bot-mark"
import { ComputerPane } from "@evie/ui/components/computer-pane"
import { Composer } from "@evie/ui/components/composer"
import { DayDivider } from "@evie/ui/components/message"
import { ThreadHeader } from "@evie/ui/components/thread-header"
import { BotDialogs, type BotDialogKind } from "~/components/bot-dialogs.tsx"
import { FileTree } from "~/components/file-tree.tsx"
import { Terminal } from "~/components/terminal.tsx"
import { Timeline } from "~/components/timeline.tsx"
import { formatDayDivider } from "~/lib/format.ts"
import { computerTabParser } from "~/lib/url-state.ts"

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
  readonly onRenameBot: (botId: BotId, name: string) => void
  /** Archives, in truth. "Delete" is what the user meant; the dialog says both. */
  readonly onDeleteBot: (botId: BotId) => void
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
  onRenameBot,
  onDeleteBot,
}: ThreadPaneProps) {
  // Per thread, so switching away and back does not lose what you were half-way
  // through typing. Keyed by id rather than reset on prop change, which is the
  // version of this that quietly eats a paragraph.
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  // In the URL, not state: the pane refines the place, so a reload -- and a
  // copied link -- lands with the same tab open. `?computer=files`; absent is
  // closed, which keeps a plain conversation link plain. Closing forgets the
  // tab, by construction: one param cannot say "closed, on Terminal".
  const [computerTab, setComputerTab] = useQueryState("computer", computerTabParser)
  const computerOpen = computerTab !== null

  // The open dialog remembers whose bot it was opened for, and a rail click
  // that lands on another thread closes it by construction -- a rename typed
  // against bot A must not be able to fire at bot B.
  const [botDialog, setBotDialog] = useState<{
    readonly kind: BotDialogKind
    readonly botId: BotId
  } | null>(null)
  const openDialog = botDialog !== null && botDialog.botId === bot.id ? botDialog.kind : null

  const draft = drafts[thread.id] ?? ""
  const mark = markOf(bot)
  // A bot is `starting` only between BotCreated and BotProvisioned -- its eve
  // project is still being written and installed. There is nothing to talk to
  // yet, so the pane says so instead of offering a composer that would dispatch
  // into a runtime that does not exist. `unhealthy` is the same flow's failure:
  // provisioning is the only writer of that state in the read model.
  const provisioning = bot.health.kind === "starting"
  const provisionFailed = bot.health.kind === "unhealthy"
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
          health={bot.health}
          computerOpen={computerOpen}
          onToggleComputer={() => void setComputerTab(computerOpen ? null : "files")}
          onRenameBot={() => setBotDialog({ kind: "rename", botId: bot.id })}
          onDeleteBot={() => setBotDialog({ kind: "delete", botId: bot.id })}
        />
        {provisioning ? (
          <CreatingPane name={bot.name} shape={mark.shape} tone={mark.tone} />
        ) : (
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
        )}
        <Composer
          placeholder={`Message ${bot.name}`}
          value={draft}
          onChange={(value) => setDrafts((current) => ({ ...current, [thread.id]: value }))}
          onSend={send}
          onStop={activeTurn === null ? undefined : () => onStop(thread.id, activeTurn)}
          streaming={streaming}
          disabled={provisioning || provisionFailed}
        >
          {bot.health.kind === "unhealthy" && (
            <p className="px-1 pb-1 text-compact text-error">
              {bot.name} couldn&apos;t be set up — the {bot.health.reason} step failed.
            </p>
          )}
        </Composer>
      </main>

      {computerTab !== null && (
        <ComputerPane
          tab={computerTab}
          onTabChange={(tab) => void setComputerTab(tab)}
          onOpenSettings={onOpenSandboxSettings}
          sandbox={{
            backend: bot.sandbox.backend,
            mode: bot.sandbox.network.mode,
            allowed: bot.sandbox.network.allow.length,
            enforced: bot.sandbox.network.enforced,
          }}
        >
          {computerTab === "files" ? <FileTree botId={bot.id} /> : null}
          {computerTab === "terminal" ? <Terminal threadId={thread.id} /> : null}
        </ComputerPane>
      )}

      {/* Keyed so switching to another bot's thread drops any half-typed
          rename with the dialog, instead of serving it to the next bot. */}
      <BotDialogs
        key={bot.id}
        bot={bot}
        kind={openDialog}
        onClose={() => setBotDialog(null)}
        onRename={onRenameBot}
        onDelete={onDeleteBot}
      />
    </>
  )
}

/**
 * The wait while a new bot's eve project is written, installed and booted -- a
 * minute or more, and the one moment the product literally builds something in
 * front of the user, so it gets a piece of the first-run delight budget: the
 * `evie-enter` stagger from onboarding, and then the bot's own face saying the
 * wait is alive.
 *
 * The face carries that, not the copy. This used to hang `evie-thinking`'s
 * ellipsis off the end of the line, which shifted a centred sentence four times
 * a second for the entire wait. `mood="busy"` moves the signal onto the thing
 * the user is already looking at and costs less than half the repaints (see
 * `.evie-busy-eyes`). The words underneath stay honest and stay still.
 *
 * It unmounts on `BotProvisioned`, which the supervisor writes only once the
 * runtime answered its health route -- and the timeline that takes over is not
 * empty for long: the bot's greeting turn is already streaming into it
 * (TurnReactor.greet).
 */
export function CreatingPane({
  name,
  shape,
  tone,
}: {
  readonly name: string
  readonly shape: BotShape
  readonly tone: BotTone
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-8 px-8">
      <span className="evie-enter">
        <BotMark size={88} shape={shape} tone={tone} mood="busy" />
      </span>
      <div className="evie-enter flex flex-col items-center gap-3 [animation-delay:60ms]">
        <p className="text-lede text-fg">{name} is being created</p>
        <p className="max-w-[420px] text-center text-compact text-fg-muted">
          Evie is setting up its computer, installing its runtime, and starting it up. The first
          time takes a minute or two — it will say hello when it&apos;s ready.
        </p>
      </div>
    </div>
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
