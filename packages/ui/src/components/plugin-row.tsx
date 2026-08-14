import { cn } from "@evie/ui/lib/utils"
import { BrandTile, type BrandId } from "@evie/ui/components/brand-logo"
import { CheckIcon } from "@evie/ui/components/icon"

/**
 * One connectable service.
 *
 * The blurb says what the bot will be able to *do*, not what the service is:
 * "Read, draft, and send from your inbox", not "Email by Google". Someone
 * scanning this list is deciding how much reach to hand an agent, and the
 * product name alone does not answer that.
 *
 * Two lines, no scope badge. "Each member signs in with their own account" is
 * true of most of this catalog, and a line that appears on almost every row is
 * not information -- it is a thing the eye learns to skip. The place that
 * sentence earns is the authorization card, at the moment someone is about to
 * hand over an account, and it already says it there.
 */

export interface PluginRowProps {
  readonly brand: BrandId
  readonly name: string
  readonly blurb: string
  readonly installed?: boolean
  readonly onAdd?: () => void
  readonly onRemove?: () => void
}

export function PluginRow({
  brand,
  name,
  blurb,
  installed = false,
  onAdd,
  onRemove,
}: PluginRowProps) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3.5">
      <BrandTile brand={brand} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-ui font-medium text-fg">{name}</span>
        <span className="truncate text-compact text-fg-muted">{blurb}</span>
      </div>
      <button
        type="button"
        onClick={installed ? onRemove : onAdd}
        className={cn(
          "flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-small px-4 text-compact font-medium",
          "focus-visible:ring-2 focus-visible:ring-focus/50 focus-visible:outline-none",
          installed
            ? // Added is a state, and it has to be reversible: the same control
              // that turned it on turns it off. A one-way door is a bug.
              "bg-transparent text-fg-muted hover:bg-raised-strong hover:text-fg"
            : "bg-raised-strong text-fg hover:opacity-80",
        )}
      >
        {installed && <CheckIcon size={13} />}
        {installed ? "Added" : "Add"}
      </button>
    </div>
  )
}

/** A category heading plus its rows, two to a line at desktop width. */
export function PluginSection({
  title,
  children,
  more,
  onShowMore,
}: {
  readonly title: string
  readonly children: React.ReactNode
  /** How many rows are hidden. Omit when everything is shown. */
  readonly more?: number
  readonly onShowMore?: () => void
}) {
  return (
    <section className="flex flex-col gap-3.5">
      <h3 className="text-compact text-fg-muted">{title}</h3>
      <div className="grid grid-cols-1 gap-x-10 gap-y-3.5 desktop:grid-cols-2">{children}</div>
      {more !== undefined && more > 0 && (
        <button
          type="button"
          onClick={onShowMore}
          className="self-start text-compact text-fg-muted hover:text-fg focus-visible:outline-none"
        >
          Show {more} more
        </button>
      )}
    </section>
  )
}
