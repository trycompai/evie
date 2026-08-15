import { createRootRouteWithContext, Outlet } from "@tanstack/react-router"
import { NuqsAdapter } from "nuqs/adapters/tanstack-router"
import { IS_DESKTOP } from "~/lib/desktop.ts"
import { useConnection } from "~/lib/hooks.ts"
import type { Runtime } from "~/lib/runtime.ts"
import { LaunchScreen } from "~/screens/launch.tsx"

/**
 * The connection gate, above every route.
 *
 * Connection state is the one thing no URL can override: a link to a thread on
 * an environment that is not answering is still a link to nothing. So it is
 * settled here, in a component rather than in `beforeLoad`, because it changes
 * over the life of the page -- a socket drops, a reconnect lands -- and a route
 * guard that ran once at navigation would show a stale answer for as long as
 * you stayed put.
 *
 * Everything below this is allowed to assume a live, authenticated connection.
 */

export interface RouterContext {
  readonly runtime: Runtime
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootView,
})

function RootView() {
  const connection = useConnection()

  switch (connection.kind) {
    case "connecting":
      return <LaunchScreen state="opening" desktop={IS_DESKTOP} onReopen={reload} onCancel={close} />

    case "offline":
      return <LaunchScreen state="failed" desktop={IS_DESKTOP} onReopen={reload} onCancel={close} />

    case "outdated":
      return <OutdatedScreen client={connection.client} server={connection.server} />

    case "unauthenticated":
      /*
       * Not the sign-in consent screen: that one confirms an account the
       * launcher already named. Arriving here means there is no session and no
       * live claim token, and a browser tab cannot mint one -- only the app or
       * `npx evie` can. So the honest screen is the launch screen saying so.
       */
      return <LaunchScreen state="expired" desktop={IS_DESKTOP} onReopen={reload} onCancel={close} />

    case "ready":
      /*
       * nuqs sits inside the router, not around it: its TanStack adapter reads
       * `useRouter`/`useRouterState`, so it has to be under the provider. What
       * is left for it is query state that refines a place rather than names
       * one -- the path owns the latter now.
       */
      return (
        <NuqsAdapter>
          <Outlet />
        </NuqsAdapter>
      )
  }
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

const reload = () => globalThis.location.reload()
const close = () => globalThis.close()
