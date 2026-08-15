import { createFileRoute, Outlet, useMatchRoute, useNavigate, useParams } from "@tanstack/react-router"
import type { ThreadId } from "@evie/contracts/ids"
import { AppRail } from "~/components/app-rail.tsx"
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
  const matchRoute = useMatchRoute()

  // `strict: false` because the rail renders above every child route and only
  // one of them has a thread id. Undefined here means "not on a conversation",
  // which is exactly what the rail wants to know.
  const threadId = useParams({ strict: false }).threadId as ThreadId | undefined

  if (!session) return <LaunchScreen state="opening" desktop={IS_DESKTOP} onReopen={reload} onCancel={close} />

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
        onOpenAccount={() => undefined}
      />
      <Outlet />
    </div>
  )
}

const locationLabel = (mode: "local" | "lan" | "tunnel"): string =>
  mode === "local" ? "This Mac" : mode === "lan" ? "On your network" : "Over your tunnel"

const reload = () => globalThis.location.reload()
const close = () => globalThis.close()
