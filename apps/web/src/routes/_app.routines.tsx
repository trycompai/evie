import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router"
import type { BotId, RoutineId } from "@evie/contracts/ids"
import { useFleet } from "~/lib/hooks.ts"
import { useRuntime } from "~/lib/runtime.ts"
import { RoutinesDialog, type RoutineDraft } from "~/screens/routines.tsx"

/**
 * Routines.
 *
 * A route drawn as a dialog, the same as Plugins: closing is a navigation, so
 * back, reload and a pasted link all agree about whether it is open.
 *
 * The list comes from the loader rather than a subscription. Routines change
 * when a person edits one, so a live slice of the fleet frame would spend the
 * frame budget on a table almost nobody has open -- and `nextRunAt` is the
 * scheduler's own recomputation, which a cached copy would render as a
 * countdown that quietly lies. Every command therefore ends in `invalidate()`,
 * which re-runs the loader and shows what the server actually did, rather than
 * an optimistic row that can disagree with it.
 */
export const Route = createFileRoute("/_app/routines")({
  loader: ({ context }) => context.runtime.store.listRoutines(),
  component: RoutinesRoute,
  pendingComponent: RoutinesPending,
})

function RoutinesRoute() {
  const routines = Route.useLoaderData()
  const { commands } = useRuntime()
  const { bots } = useFleet()
  const navigate = useNavigate()
  const router = useRouter()

  const close = () => void navigate({ to: "/" })
  // Awaited so the refetch happens after the command settles, not beside it.
  const refresh = () => void router.invalidate()

  return (
    <RoutinesDialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
      routines={routines}
      bots={bots}
      loading={false}
      onCreate={(botId: BotId, draft: RoutineDraft) => {
        void commands.createRoutine(botId, draft).then(refresh, refresh)
      }}
      onToggle={(botId: BotId, routineId: RoutineId, enabled: boolean) => {
        void commands.setRoutineEnabled(botId, routineId, enabled).then(refresh, refresh)
      }}
      onDelete={(botId: BotId, routineId: RoutineId) => {
        void commands.deleteRoutine(botId, routineId).then(refresh, refresh)
      }}
    />
  )
}

/** The loader's round trip. Same dialog, so opening does not flash an empty one. */
function RoutinesPending() {
  const navigate = useNavigate()
  return (
    <RoutinesDialog
      open
      onOpenChange={(open) => {
        if (!open) void navigate({ to: "/" })
      }}
      routines={[]}
      bots={[]}
      loading
      onCreate={() => undefined}
      onToggle={() => undefined}
      onDelete={() => undefined}
    />
  )
}
