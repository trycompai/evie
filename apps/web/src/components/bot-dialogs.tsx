import { useState } from "react"
import type { Bot } from "@evie/contracts/bot"
import type { BotId } from "@evie/contracts/ids"
import { ActionButton } from "@evie/ui/components/action-button"
import { Dialog, DialogBody, DialogHeader, DialogSurface } from "@evie/ui/components/dialog"
import { TextField } from "@evie/ui/components/text-field"

/**
 * The rename and delete dialogs, shared by every place a bot's verbs surface:
 * the thread header's menu and the rail's right-click. One implementation,
 * because two copies of "what does deleting a bot mean" is how the two entry
 * points end up promising different things.
 */

export type BotDialogKind = "rename" | "delete"

export interface BotDialogsProps {
  /** The bot the open dialog is about. Null renders both dialogs closed. */
  readonly bot: Bot | null
  readonly kind: BotDialogKind | null
  readonly onClose: () => void
  readonly onRename: (botId: BotId, name: string) => void
  /** Archives, in truth. "Delete" is what the user meant; the dialog says both. */
  readonly onDelete: (botId: BotId) => void
}

export function BotDialogs({ bot, kind, onClose, onRename, onDelete }: BotDialogsProps) {
  // Null means "not typed yet", so the field shows the bot's current name the
  // moment the dialog opens -- derived, not seeded, which is what makes a
  // reopen (or a rename landing from another device) show the fresh name
  // without an effect to sync it.
  const [draft, setDraft] = useState<string | null>(null)
  const name = draft ?? bot?.name ?? ""

  const close = () => {
    setDraft(null)
    onClose()
  }

  return (
    <>
      <Dialog
        open={bot !== null && kind === "rename"}
        onOpenChange={(open) => {
          if (!open) close()
        }}
      >
        <DialogSurface width={420}>
          <DialogHeader title="Rename bot" />
          <DialogBody>
            <form
              className="flex flex-col gap-6 pt-2"
              onSubmit={(e) => {
                e.preventDefault()
                if (bot === null) return
                const next = name.trim()
                if (next.length === 0) return
                if (next !== bot.name) onRename(bot.id, next)
                close()
              }}
            >
              <TextField
                id="rename-bot-name"
                label="Name"
                value={name}
                onChange={(e) => setDraft(e.target.value)}
              />
              <ActionButton type="submit" shape="rounded" disabled={name.trim().length === 0}>
                Rename
              </ActionButton>
            </form>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog
        open={bot !== null && kind === "delete"}
        onOpenChange={(open) => {
          if (!open) close()
        }}
      >
        <DialogSurface width={420}>
          <DialogHeader title={`Delete ${bot?.name ?? "bot"}?`} />
          <DialogBody>
            {/* The honest sentence: nothing is destroyed. Its computer and its
                conversations are kept, and the way back is named rather than
                implied -- a delete that cannot say where the undo lives is a
                one-way door wearing a euphemism. */}
            <p className="text-compact text-fg-muted">
              {bot?.name} stops appearing in your sidebar and stops taking work. Its computer and
              conversations are kept, and you can restore it any time from the New bot screen.
            </p>
            <div className="flex flex-col gap-2.5">
              <ActionButton
                variant="danger"
                shape="rounded"
                onClick={() => {
                  if (bot === null) return
                  close()
                  onDelete(bot.id)
                }}
              >
                Delete bot
              </ActionButton>
              <ActionButton variant="secondary" shape="rounded" onClick={close}>
                Cancel
              </ActionButton>
            </div>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  )
}
