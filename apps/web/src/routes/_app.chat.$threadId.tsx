import { createFileRoute, useNavigate } from "@tanstack/react-router"
import type { ThreadId } from "@evie/contracts/ids"
import { useFleet } from "~/lib/hooks.ts"
import { useRuntime } from "~/lib/runtime.ts"
import { MissingThreadPane, ThreadPane, UnlistedThreadPane } from "~/screens/chat.tsx"

/**
 * One conversation.
 *
 * The loader is what makes a reload into a thread work. Opening the stream used
 * to hang off the rail's click handler, which is fine right up until the id
 * comes from the address bar instead of a click -- then the pane renders with
 * nothing behind it. The route is the thing that needs the data, so the route
 * asks for it, and `openThread` is idempotent so a second visit is free.
 *
 * It is also the only place that can tell a deleted conversation from one this
 * client simply has not loaded. The rail carries the hundred most recent active
 * threads, so "not in the fleet" means very little; the server refusing the
 * timeline means the thread is not yours, and that failure lands in
 * `errorComponent`. Three outcomes, and none of them lie.
 */
export const Route = createFileRoute("/_app/chat/$threadId")({
  loader: async ({ params, context }) => {
    const threadId = params.threadId as ThreadId
    await context.runtime.store.openThread(threadId)
    // Presence reads the store's open set rather than this id, so it has to be
    // told after the stream is actually up.
    context.runtime.presence.opened(threadId)
  },
  component: ChatRoute,
  errorComponent: MissingThread,
})

function MissingThread() {
  const navigate = useNavigate()
  return <MissingThreadPane onLeave={() => void navigate({ to: "/" })} />
}

function ChatRoute() {
  const { threadId } = Route.useParams()
  const runtime = useRuntime()
  const { bots, threads } = useFleet()
  const navigate = useNavigate()

  const session = runtime.store.getSession()
  const thread = threads.find((candidate) => candidate.id === threadId) ?? null
  const bot = thread
    ? bots.find((candidate) => candidate.id === thread.participants[0]?.botId)
    : undefined

  /*
   * The loader succeeded, so the conversation is real -- we just do not hold
   * its record. That is the rail's hundred-thread window, or an archived or
   * snoozed thread, not a missing one, and the copy says so.
   */
  if (!thread || !bot || !session) {
    return <UnlistedThreadPane onLeave={() => void navigate({ to: "/" })} />
  }

  return (
    <ThreadPane
      thread={thread}
      bot={bot}
      viewerId={session.userId}
      onSend={(id, text) => void runtime.commands.sendMessage(id, text)}
      onStop={(id, turnId) => void runtime.commands.cancelTurn(id, turnId)}
      onAnswerInput={(id, requestId, optionId) =>
        void runtime.commands.answerInput(id, requestId, optionId)
      }
      onWatchReasoning={(id, itemId, watching) =>
        runtime.presence.watchReasoning(id, itemId, watching)
      }
    />
  )
}
