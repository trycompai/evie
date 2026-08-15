import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { cn } from "@evie/ui/lib/utils"
import { CloseIcon } from "@evie/ui/components/icon"

/**
 * The app's one modal shell: Plugins, Settings, the routine editor.
 *
 * Approvals are deliberately NOT modals -- they live in the flow, because a
 * modal steals focus while a turn is still streaming. What belongs here is
 * navigation: a place you go, look at, and leave. If a dialog is answering a
 * question the transcript asked, it is the wrong component.
 *
 * The scrim is 62% black in both themes. Dimming toward the page colour would
 * make a light-mode modal float on nothing.
 */

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

export interface DialogSurfaceProps extends DialogPrimitive.Popup.Props {
  /** Plugins is 1040px. A settings pane is narrower. */
  readonly width?: number
}

export function DialogSurface({ className, width = 1040, children, ...props }: DialogSurfaceProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-[#0000009e]" />
      <DialogPrimitive.Popup
        className={cn(
          "fixed top-1/2 left-1/2 z-50 flex max-h-[85vh] w-[calc(100vw-64px)] -translate-x-1/2 -translate-y-1/2",
          "flex-col overflow-hidden rounded-2xl border border-line-subtle bg-raised",
          "focus-visible:outline-none",
          className,
        )}
        style={{ maxWidth: width }}
        {...props}
      >
        {children}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  )
}

export function DialogHeader({
  title,
  children,
}: {
  readonly title: string
  /** Anything trailing the title, before the close button. */
  readonly children?: React.ReactNode
}) {
  return (
    <div className="flex shrink-0 items-start gap-4 px-7 pt-7">
      <DialogPrimitive.Title className="min-w-0 flex-1 text-section tracking-subsection text-fg select-none">
        {title}
      </DialogPrimitive.Title>
      {children}
      <DialogPrimitive.Close
        aria-label="Close"
        className="flex h-8 w-7 shrink-0 items-center justify-center text-fg-muted hover:text-fg"
      >
        <CloseIcon size={16} />
      </DialogPrimitive.Close>
    </div>
  )
}

/** The row under the header: tabs, filters, search. */
export function DialogToolbar({ children }: { readonly children: React.ReactNode }) {
  return <div className="flex shrink-0 items-center gap-3 px-7 py-5">{children}</div>
}

export function DialogBody({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-7 overflow-y-auto px-7 pt-1 pb-7">{children}</div>
  )
}
