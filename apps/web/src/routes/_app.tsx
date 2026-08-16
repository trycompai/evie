import { useState } from "react"
import { createFileRoute, Outlet, useMatchRoute, useNavigate, useParams, useRouter } from "@tanstack/react-router"
import type { BotId, ThreadId } from "@evie/contracts/ids"
import { AppRail } from "~/components/app-rail.tsx"
import { BotDialogs, type BotDialogKind } from "~/components/bot-dialogs.tsx"
import { IS_DESKTOP } from "~/lib/desktop.ts"
import { useFleet } from "~/lib/hooks.ts"
import { useRuntime } from "~/lib/runtime.ts"
import { LaunchScreen } from "~/screens/launch.tsx"

/**
 * The window you spend your time in: the rail, and whatever the rail is
 * pointing at.
 *
 * Pathless, so the URL reads `/chat/<id>` rather than `/app/chat/<id>` -- the
 * rail is a layout, not a place. Onboarding lives outside it because those
 * screens are full-bleed and there is nothing in the rail to show yet.
 *
 * `beforeLoad` waits for the fleet's first frame, which is the whole reason
 * anything below here can be written as a straight render. "No bots" and "no
 * answer yet" are the same empty array, and a child that had to tell them apart
 * would guess wrong every reload -- which is exactly the bug that sent people
 * with a dozen bots back to the welcome screen.
 */
export const Route = createFileRoute("/_app")({
  beforeLoad: ({ context }) => context.runtime.store.whenFleetLoaded(),
  component: AppLayout,
})

function AppLayout() {
  const runtime = useRuntime()
  const { bots, threads } = useFleet()
  const session = runtime.store.getSession()
  const navigate = useNavigate()
  const router = useRouter()
  const matchRoute = useMatchRoute()

  // `strict: false` because the rail renders above every child route and only
  // one of them has a thread id. Undefined here means "not on a conversation",
  // which is exactly what the rail wants to know.
  const threadId = useParams({ strict: false }).threadId as ThreadId | undefined

  // The rail's right-click dialogs. Held by id and resolved from the fleet on
  // render, so a bot renamed or archived elsewhere updates -- or closes -- the
  // dialog instead of it acting on a snapshot.
  const [botDialog, setBotDialog] = useState<{
    readonly kind: BotDialogKind
    readonly botId: BotId
  } | null>(null)
  const dialogBot = botDialog ? (bots.find((bot) => bot.id === botDialog.botId) ?? null) : null

  if (!session) return <LaunchScreen state="opening" desktop={IS_DESKTOP} onReopen={reload} onCancel={close} />

  const deleteBot = async (botId: BotId) => {
    await runtime.commands.archiveBot(botId)
    // The New-bot screen's Archived list is loader data; if it is on screen,
    // tell it the fleet just lost a member so the bot appears there at once.
    void router.invalidate()
    // The open conversation belongs to the bot that just left the rail --
    // leaving the pane on it would strand the user on an unlisted thread.
    const current = threads.find((thread) => thread.id === threadId)
    if (current?.participants.some((participant) => participant.botId === botId)) {
      void navigate({ to: "/" })
    }
  }

  return (
    <div className="flex h-full bg-surface">
      <AppRail
        bots={bots}
        threads={threads}
        activeThreadId={threadId ?? null}
        composingBot={matchRoute({ to: "/new" }) !== false}
        accountName={session.organizations.find((org) => org.id === session.orgId)?.name ?? "You"}
        location={locationLabel(session.mode)}
        desktop={IS_DESKTOP}
        onSelectThread={(id) => void navigate({ to: "/chat/$threadId", params: { threadId: id } })}
        onNewBot={() => void navigate({ to: "/new" })}
        onOpenPlugins={() => void navigate({ to: "/plugins" })}
        onOpenRoutines={() => void navigate({ to: "/routines" })}
        onOpenAccount={() => undefined}
        onRenameBot={(bot) => setBotDialog({ kind: "rename", botId: bot.id })}
        onDeleteBot={(bot) => setBotDialog({ kind: "delete", botId: bot.id })}
      />
      <Outlet />
      <BotDialogs
        key={botDialog?.botId}
        bot={dialogBot}
        kind={botDialog?.kind ?? null}
        onClose={() => setBotDialog(null)}
        onRename={(botId, name) =>
          // The description rides along unchanged: `RenameBot` writes both, and
          // omitting it here would null the description as a side effect.
          void runtime.commands.renameBot(botId, name, dialogBot?.description ?? null)
        }
        onDelete={(botId) => void deleteBot(botId)}
      />
    </div>
  )
}

const locationLabel = (mode: "local" | "lan" | "tunnel"): string =>
  mode === "local" ? "This Mac" : mode === "lan" ? "On your network" : "Over your tunnel"

const reload = () => globalThis.location.reload()
const close = () => globalThis.close()
