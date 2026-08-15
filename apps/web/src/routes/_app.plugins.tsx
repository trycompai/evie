import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { PluginsDialog } from "~/screens/plugins.tsx"

/**
 * Plugins.
 *
 * Still drawn as a dialog, but it is a route: closing it is a navigation, so
 * the back button, a reload and a copied link all agree about whether it is
 * open. Dismissing goes to `/` rather than back, because arriving here from a
 * pasted link has no back to go to and a sheet you cannot close is a trap.
 */
export const Route = createFileRoute("/_app/plugins")({
  component: PluginsRoute,
})

function PluginsRoute() {
  const navigate = useNavigate()
  return (
    <PluginsDialog
      open
      onOpenChange={(open) => {
        if (!open) void navigate({ to: "/" })
      }}
      listings={[]}
      installed={new Set()}
      onAdd={() => undefined}
      onRemove={() => undefined}
    />
  )
}
