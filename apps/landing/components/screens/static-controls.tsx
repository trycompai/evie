import { cn } from "@evie/ui/lib/utils"
import { CloseIcon, MicIcon, PlusLargeIcon } from "@evie/ui/components/icon"

/**
 * Resting states of the four controls that cannot render on the server.
 *
 * `Composer` holds IME state, `Dialog` is a Base UI portal, `Segmented` takes a
 * required `onChange`, and `ApprovalCard` only draws its dismiss affordance when
 * something is listening for it. All four are interaction; a screenshot has
 * none. Rather than ship a client bundle so a picture can hold state, these
 * reproduce the resting frame of each -- same class strings as
 * `packages/ui/src/components`, copied deliberately and only here.
 *
 * If one of those components changes shape, these four go stale. That is the
 * trade: a still life of a control, against JavaScript on a marketing page.
 */

/** `Composer`, with nothing typed -- so the trailing control is Dictate. */
export function StaticComposer({ placeholder }: { readonly placeholder: string }) {
  return (
    <div className="flex shrink-0 flex-col gap-2 px-7 pt-2 pb-5">
      <div className="flex min-h-14 items-center gap-3 rounded-composer bg-raised px-2.5 py-2.5">
        <span className="flex size-9 shrink-0 items-center justify-center self-end rounded-full bg-raised-strong text-fg">
          <PlusLargeIcon />
        </span>
        <span className="min-w-0 flex-1 self-center truncate text-body text-fg-muted">
          {placeholder}
        </span>
        <span className="flex size-9 shrink-0 items-center justify-center self-end rounded-full bg-fg text-surface">
          <MicIcon />
        </span>
      </div>
    </div>
  )
}

export interface StaticApprovalCardProps {
  readonly prompt: string
  readonly options: readonly string[]
}

/** `ApprovalCard`, pending, with the dismiss affordance the design draws. */
export function StaticApprovalCard({ prompt, options }: StaticApprovalCardProps) {
  return (
    <div className="flex w-[780px] max-w-full flex-col gap-3.5 rounded-bubble bg-raised px-[18px] pt-4 pb-[18px]">
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 text-body text-fg">{prompt}</p>
        <span className="flex h-6 w-5 shrink-0 items-center justify-center text-fg-muted">
          <CloseIcon />
        </span>
      </div>

      <div className="flex flex-col overflow-hidden rounded-default border border-line-subtle">
        {options.map((label, index) => (
          <span
            key={label}
            className={cn(
              "flex h-12 shrink-0 items-center gap-3 px-3.5 text-left",
              index < options.length - 1 && "border-b border-line-subtle",
            )}
          >
            <span className="flex size-[22px] shrink-0 items-center justify-center rounded-small border border-line text-[12px] leading-3 text-fg-muted">
              {String.fromCharCode(65 + index)}
            </span>
            <span className="min-w-0 flex-1 text-body leading-[22px] text-fg">{label}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

/** `Segmented`, with the first option selected. */
export function StaticSegmented({ options }: { readonly options: readonly string[] }) {
  return (
    <div className="flex items-center gap-1 rounded-default bg-raised-strong p-[3px]">
      {options.map((label, index) => (
        <span
          key={label}
          className={cn(
            "flex h-[30px] items-center justify-center rounded-small px-3.5 text-compact",
            index === 0 ? "bg-raised font-medium text-fg" : "text-fg-muted",
          )}
        >
          {label}
        </span>
      ))}
    </div>
  )
}

/** `DialogSurface` + `DialogHeader`, as the Plugins modal rests over the thread. */
export function StaticDialog({
  title,
  width,
  children,
}: {
  readonly title: string
  readonly width: number
  readonly children: React.ReactNode
}) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-[#0000009e]">
      <div
        className="flex flex-col overflow-hidden rounded-2xl border border-line-subtle bg-raised"
        style={{ width }}
      >
        <div className="flex shrink-0 items-start gap-4 px-7 pt-7">
          <h2 className="min-w-0 flex-1 text-section tracking-subsection text-fg">{title}</h2>
          <span className="flex h-8 w-7 shrink-0 items-center justify-center text-fg-muted">
            <CloseIcon size={16} />
          </span>
        </div>
        {children}
      </div>
    </div>
  )
}
