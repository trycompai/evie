import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router"
import { useFleet } from "~/lib/hooks.ts"
import { resolveLanding } from "~/lib/landing.ts"
import { EmptyPane } from "~/screens/chat.tsx"

/**
 * The root, and the only route that decides where you should be rather than
 * showing you something.
 *
 * The fleet is already settled here -- `_app` awaited it -- which is what makes
 * this a read rather than a guess. See `resolveLanding`.
 */
export const Route = createFileRoute("/_app/")({
  beforeLoad: ({ context }) => {
    const landing = resolveLanding(context.runtime.store.getFleet())
    /*
     * Both redirects replace. Without it the root stays in history, and going
     * back lands on a route whose only job is to redirect here again -- a back
     * button that visibly does nothing, which is worse than one that is greyed
     * out.
     */
    if (landing.to === "welcome") throw redirect({ to: "/welcome", replace: true })
    if (landing.to === "thread") {
      throw redirect({ to: "/chat/$threadId", params: { threadId: landing.threadId }, replace: true })
    }
  },
  component: IndexView,
})

/** Only reachable with bots but no conversations -- every other case redirected. */
function IndexView() {
  const { bots } = useFleet()
  const navigate = useNavigate()
  return <EmptyPane hasBots={bots.length > 0} onNewBot={() => void navigate({ to: "/new" })} />
}
