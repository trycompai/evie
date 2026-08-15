import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { IS_DESKTOP } from "~/lib/desktop.ts"
import { useFinishOnboarding } from "~/lib/onboarding.ts"
import { MeetEvieScreen } from "~/screens/meet-evie.tsx"

/**
 * Onboarding, step one.
 *
 * Outside the rail layout: these screens are full-bleed, and an account that
 * has not made a bot has nothing to put in a rail.
 *
 * There is no "onboarding finished" flag anywhere, and there should not be.
 * Whether you belong here is derived from whether you have bots, so it cannot
 * go stale, disagree with the data, or survive a reload as the wrong answer --
 * which is what a remembered step did.
 */
export const Route = createFileRoute("/welcome")({
  beforeLoad: ({ context }) => context.runtime.store.whenFleetLoaded(),
  component: MeetRoute,
})

function MeetRoute() {
  const navigate = useNavigate()
  const finish = useFinishOnboarding()
  return (
    <MeetEvieScreen
      desktop={IS_DESKTOP}
      onNext={() => void navigate({ to: "/welcome/connect" })}
      onSkip={finish}
    />
  )
}
