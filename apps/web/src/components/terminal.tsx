import type { ThreadId } from "@evie/contracts/ids"
import { TerminalView } from "@evie/ui/components/computer-pane"
import { useTerminal } from "~/lib/hooks.ts"

/**
 * The Computer pane's Terminal tab: a transcript of the thread's `bash` runs.
 *
 * Thin on purpose, like `FileTree`: the lines are derived in
 * `@evie/client-runtime` from timeline rows the client already holds, and
 * `TerminalView` owns how a transcript looks.
 */
export function Terminal({ threadId }: { readonly threadId: ThreadId }) {
  const lines = useTerminal(threadId)
  return <TerminalView lines={lines} />
}
