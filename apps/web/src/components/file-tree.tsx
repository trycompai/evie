import type { BotId } from "@evie/contracts/ids"
import { ROOT } from "@evie/client-runtime/files"
import { FileRow } from "@evie/ui/components/computer-pane"
import { useBotFiles } from "~/lib/hooks.ts"
import { useRuntime } from "~/lib/runtime.ts"

/**
 * The Computer pane's Files tab: the bot's own directory, a level at a time.
 *
 * One level at a time is the contract, not an optimisation to revisit -- a
 * bot's project has a `node_modules` in it, and the eager version sends tens of
 * thousands of names over the socket to draw eight rows.
 *
 * There is no `useEffect` here or in the hook: the store holds the tree,
 * subscribing to it is what asks the server for it, and expanding a folder is
 * a click.
 */
export function FileTree({ botId }: { readonly botId: BotId }) {
  const { store } = useRuntime()
  const { rows, loaded, failed } = useBotFiles(botId)

  if (rows.length === 0) {
    if (failed !== null) return <Note>Could not read the files on this computer.</Note>
    // Nothing at all until the listing answers. An empty pane for one frame
    // beats telling someone their computer is empty for one frame.
    return loaded ? <Note>This computer is empty.</Note> : null
  }

  return (
    <>
      {/* Rows are still on screen, so the failure has to say which read failed. */}
      {failed !== null && (
        <Note>
          {failed === ROOT ? "Could not re-read this computer." : `Could not open ${failed}.`}
        </Note>
      )}
      {rows.map((row) => (
        <FileRow
          key={row.path}
          name={row.name}
          kind={row.kind}
          depth={row.depth}
          // Directories are the only controls here. Opening a file is a later
          // phase, and `FileRow` draws a row with no handler as a row.
          expanded={row.kind === "dir" ? row.expanded : undefined}
          onSelect={
            row.kind === "dir" ? () => void store.toggleDirectory(botId, row.path) : undefined
          }
        />
      ))}
    </>
  )
}

const Note = ({ children }: { readonly children: React.ReactNode }) => (
  <p className="px-2 py-2 text-metadata text-fg-muted">{children}</p>
)
