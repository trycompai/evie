import { useNavigate } from "@tanstack/react-router"
import { useFleet } from "./hooks.ts"

/**
 * Where onboarding lets you out: the compose pane when there is still nothing
 * to talk to, the app itself otherwise.
 *
 * Shared by both steps so *Skip* and *Done* cannot drift apart, and kept out of
 * the route files so neither step has to import the other.
 */
export function useFinishOnboarding(): () => void {
  const navigate = useNavigate()
  const { bots } = useFleet()
  return () => void navigate({ to: bots.length === 0 ? "/new" : "/" })
}
