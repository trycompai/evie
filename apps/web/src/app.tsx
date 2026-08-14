import { useState } from "react"
import type { BotId, ThreadId } from "@evie/contracts/ids"
import type { BotShape, BotTone } from "@evie/ui/components/bot-mark"
import { AppRail } from "~/components/app-rail.tsx"
import { useConnection, useFleet } from "~/lib/hooks.ts"
import { useRuntime } from "~/lib/runtime.ts"
import { EmptyPane, ThreadPane } from "~/screens/chat.tsx"
import { ConnectAppsScreen } from "~/screens/connect-apps.tsx"
import { LaunchScreen } from "~/screens/launch.tsx"
import { MeetEvieScreen } from "~/screens/meet-evie.tsx"
import { NewBotScreen } from "~/screens/new-bot.tsx"
import { PluginsDialog } from "~/screens/plugins.tsx"

/**
 * What the window shows.
 *
 * Connection state decides the outer branch and local state decides the inner
 * one. There is no router: Evie is one window with one place you spend your
 * time, and a URL scheme would be three abstractions to make the back button
 * work in an app whose main surface has no pages. Deep links
 * (`evie://thread/<id>`) resolve to a thread id and land in `selectedThread`.
 */

type Onboarding = "meet" | "connect" | "done"

const IS_DESKTOP = typeof globalThis.navigator !== "undefined" && "evie" in globalThis

export function App() {
  const connection = useConnection()

  switch (connection.kind) {
    case "connecting":
      return <LaunchScreen state="opening" onReopen={reload} onCancel={close} />

    case "offline":
      return <LaunchScreen state="failed" onReopen={reload} onCancel={close} />

    case "outdated":
      return <OutdatedScreen client={connection.client} server={connection.server} />

    case "unauthenticated":
      /*
       * Not the sign-in consent screen: that one confirms an account the
       * launcher already named. Arriving here means there is no session and no
       * live claim token, and a browser tab cannot mint one -- only the app or
       * `npx evie` can. So the honest screen is the launch screen saying so.
       */
      return <LaunchScreen state="expired" onReopen={reload} onCancel={close} />

    case "ready":
      return <Signed />
  }
}

function Signed() {
  const runtime = useRuntime()
  const { bots, threads } = useFleet()
  const session = runtime.store.getSession()

  const [onboarding, setOnboarding] = useState<Onboarding>(bots.length > 0 ? "done" : "meet")
  const [selectedThread, setSelectedThread] = useState<ThreadId | null>(null)
  const [composingBot, setComposingBot] = useState(bots.length === 0)
  const [pluginsOpen, setPluginsOpen] = useState(false)

  // New-bot form state. Lives here rather than in the screen so picking a
  // suggestion can fill the name and the mark in one place.
  const [botName, setBotName] = useState("")
  const [shape, setShape] = useState<BotShape>("circle")
  const [tone, setTone] = useState<BotTone>(1)
  const [creating, setCreating] = useState(false)

  const [connected, setConnected] = useState<ReadonlySet<string>>(new Set())

  if (!session) return <LaunchScreen state="opening" onReopen={reload} onCancel={close} />

  if (onboarding === "meet") {
    return (
      <MeetEvieScreen
        desktop={IS_DESKTOP}
        onNext={() => setOnboarding("connect")}
        onSkip={() => setOnboarding("done")}
      />
    )
  }

  if (onboarding === "connect") {
    return (
      <ConnectAppsScreen
        desktop={IS_DESKTOP}
        selected={connected}
        onToggle={(id) =>
          setConnected((current) => {
            const next = new Set(current)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
          })
        }
        onNext={() => setOnboarding("done")}
        onBack={() => setOnboarding("meet")}
      />
    )
  }

  const thread = threads.find((candidate) => candidate.id === selectedThread) ?? null
  const bot = thread
    ? bots.find((candidate) => candidate.id === thread.participants[0]?.botId)
    : undefined

  const createBot = async () => {
    setCreating(true)
    try {
      const receipt = await runtime.commands.createBot({
        name: botName.trim(),
        model: DEFAULT_MODEL,
        avatar: `${shape}:${tone}`,
      })
      // The bot arrives on the fleet stream; the receipt only tells us which id
      // to open so the user lands in the conversation they just created.
      if (receipt.resourceId) {
        const opened = await runtime.commands.openThread([receipt.resourceId as BotId])
        if (opened.resourceId) setSelectedThread(opened.resourceId as ThreadId)
      }
      setComposingBot(false)
      setBotName("")
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="flex h-full bg-surface">
      <AppRail
        bots={bots}
        threads={threads}
        activeThreadId={selectedThread}
        composingBot={composingBot}
        accountName={session.organizations.find((org) => org.id === session.orgId)?.name ?? "You"}
        location={locationLabel(session.mode)}
        desktop={IS_DESKTOP}
        onSelectThread={(id) => {
          setComposingBot(false)
          setSelectedThread(id)
          void runtime.store.openThread(id)
          runtime.presence.opened(id)
        }}
        onNewBot={() => {
          setComposingBot(true)
          setSelectedThread(null)
        }}
        onOpenPlugins={() => setPluginsOpen(true)}
        onOpenAccount={() => undefined}
      />

      {composingBot ? (
        <NewBotScreen
          name={botName}
          onNameChange={setBotName}
          shape={shape}
          tone={tone}
          onShapeChange={setShape}
          onToneChange={setTone}
          onCreate={() => void createBot()}
          onPickSuggestion={(suggestion) => {
            setBotName(suggestion.name)
            setShape(suggestion.shape)
            setTone(suggestion.tone)
          }}
          creating={creating}
        />
      ) : thread && bot ? (
        <ThreadPane
          thread={thread}
          bot={bot}
          viewerId={session.userId}
          onSend={(threadId, text) => void runtime.commands.sendMessage(threadId, text)}
          onStop={(threadId, turnId) => void runtime.commands.cancelTurn(threadId, turnId)}
          onAnswerInput={(threadId, requestId, optionId) =>
            void runtime.commands.answerInput(threadId, requestId, optionId)
          }
          onWatchReasoning={(threadId, itemId, watching) =>
            runtime.presence.watchReasoning(threadId, itemId, watching)
          }
        />
      ) : (
        <EmptyPane hasBots={bots.length > 0} onNewBot={() => setComposingBot(true)} />
      )}

      <PluginsDialog
        open={pluginsOpen}
        onOpenChange={setPluginsOpen}
        listings={[]}
        installed={new Set()}
        onAdd={() => undefined}
        onRemove={() => undefined}
      />
    </div>
  )
}

/**
 * A version mismatch is the one failure where retrying forever is wrong, so it
 * gets a screen rather than a toast: the client and the environment cannot talk
 * and no amount of waiting changes that.
 */
function OutdatedScreen({ client, server }: { readonly client: number; readonly server: number }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-surface px-10">
      <p className="text-subsection text-fg">Update Evie to keep using this environment</p>
      <p className="max-w-[420px] text-center text-compact text-fg-muted">
        This client speaks version {client} and the environment speaks version {server}. Updating
        the one that is behind will reconnect it.
      </p>
    </div>
  )
}

/** The model a new bot starts on. Changeable per bot the moment it exists. */
const DEFAULT_MODEL = "anthropic/claude-opus-4.8"

const locationLabel = (mode: "local" | "lan" | "tunnel"): string =>
  mode === "local" ? "This Mac" : mode === "lan" ? "On your network" : "Over your tunnel"

const reload = () => globalThis.location.reload()
const close = () => globalThis.close()
