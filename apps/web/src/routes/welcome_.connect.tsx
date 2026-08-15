import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQueryState } from "nuqs"
import { IS_DESKTOP } from "~/lib/desktop.ts"
import { useFinishOnboarding } from "~/lib/onboarding.ts"
import { connectedAppsParser } from "~/lib/url-state.ts"
import { ConnectAppsScreen } from "~/screens/connect-apps.tsx"

/**
 * Onboarding, step two.
 *
 * `welcome_.` rather than `welcome.` so this is a sibling of the first step
 * rather than nested inside it -- both are whole screens, and neither renders
 * the other.
 *
 * The picks live in the query string, which is what query state is *for*: they
 * refine this screen rather than name a place. Refreshing halfway through setup
 * should not silently unpick everything.
 */
export const Route = createFileRoute("/welcome_/connect")({
  beforeLoad: ({ context }) => context.runtime.store.whenFleetLoaded(),
  component: ConnectRoute,
})

function ConnectRoute() {
  const navigate = useNavigate()
  const finishOnboarding = useFinishOnboarding()
  const [apps, setApps] = useQueryState("apps", connectedAppsParser)

  return (
    <ConnectAppsScreen
      desktop={IS_DESKTOP}
      selected={new Set(apps)}
      onToggle={(id) =>
        void setApps((current) =>
          current.includes(id) ? current.filter((app) => app !== id) : [...current, id],
        )
      }
      onNext={() => {
        // The picks belong to setup. Dropping them on the way out keeps a
        // conversation link you copy afterwards reading as a conversation link.
        void setApps(null)
        finishOnboarding()
      }}
      onBack={() => void navigate({ to: "/welcome" })}
    />
  )
}
