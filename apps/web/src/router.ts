import { createBrowserHistory, createRouter } from "@tanstack/react-router"
import type { Runtime } from "~/lib/runtime.ts"
import { routeTree } from "~/routeTree.gen.ts"

/**
 * The router.
 *
 * Browser history, not hash. The desktop shell serves the app over http
 * (`apps/desktop/src/main/window.ts`), so paths resolve the same there as in a
 * tab, and the server already mounts its static bundle with an SPA fallback --
 * a cold load of `/chat/<id>` gets `index.html` either way.
 *
 * The runtime goes in the router's context so `beforeLoad` and `loader` can
 * reach the store without a component. That is what lets a route *wait* for the
 * fleet instead of rendering a guess, and what lets a conversation open itself
 * on a reload rather than on a click.
 */
export function createAppRouter(runtime: Runtime) {
  return createRouter({
    routeTree,
    history: createBrowserHistory(),
    context: { runtime },
  })
}

export type AppRouter = ReturnType<typeof createAppRouter>

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter
  }
}
