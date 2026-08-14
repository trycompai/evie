import { cn } from "@evie/ui/lib/utils"
import { AppleIcon } from "~/components/site/brand"
import { CTA } from "~/content/site"

/**
 * The page's shared parts.
 *
 * The design is a stack of full-bleed bands, each holding one 1200px column.
 * That is two facts, so it is two components -- `Section` owns the band (ground
 * colour, hairline, vertical rhythm) and `Column` owns the measure. Sections
 * below compose them rather than repeating `px-10` and `max-w-[1200px]`
 * eleven times.
 *
 * Type sizes that exist in the design system use its utilities. The display
 * steps here do not: marketing runs 46px and 56px between the sheet's 40 and 48,
 * so those are literals, kept in this file rather than sprinkled through the
 * sections. Each one also carries the step it drops to on a phone, where the
 * design has no artboard and 88px of headline would be four words a line.
 *
 * **Selection.** Chrome does not select: buttons, labels, chips, and the
 * screenshots are things you click or look at, and a stray drag highlighting
 * half a button is the tell of a page assembled rather than designed. Prose
 * does select -- the ledes, the answers, the plan lines -- because people quote
 * marketing copy, and `npx evie` selects *whole*, because people run it.
 */

type Ground = "surface" | "muted" | "contrast"

const GROUND: Record<Ground, string> = {
  surface: "bg-surface",
  muted: "bg-surface-muted",
  contrast: "bg-contrast",
}

export interface SectionProps {
  readonly ground?: Ground
  /** The hairline the design draws where two light bands meet. */
  readonly topLine?: boolean
  readonly bottomLine?: boolean
  readonly className?: string
  readonly id?: string
  readonly children: React.ReactNode
}

export function Section({
  ground = "surface",
  topLine = false,
  bottomLine = false,
  className,
  id,
  children,
}: SectionProps) {
  return (
    <section
      id={id}
      className={cn(
        "flex w-full shrink-0 flex-col items-center px-10",
        GROUND[ground],
        topLine && "border-t border-line-subtle",
        bottomLine && "border-b border-line-subtle",
        className,
      )}
    >
      {children}
    </section>
  )
}

/** The 1200px measure every band's content sits in. */
export function Column({
  className,
  children,
}: {
  readonly className?: string
  readonly children: React.ReactNode
}) {
  return <div className={cn("flex w-full max-w-[1200px] flex-col", className)}>{children}</div>
}

/** A section turn: 46px, heading weight, tight. */
export function SectionHeading({
  className,
  children,
}: {
  readonly className?: string
  readonly children: React.ReactNode
}) {
  return (
    <h2
      className={cn(
        "text-[34px] leading-[40px] font-heading tracking-section text-balance text-fg",
        "tablet:text-[46px] tablet:leading-[52px]",
        className,
      )}
    >
      {children}
    </h2>
  )
}

/** The paragraph under a section turn. */
export function SectionLede({
  className,
  children,
}: {
  readonly className?: string
  readonly children: React.ReactNode
}) {
  return (
    <p className={cn("text-[17px] leading-[27px] text-balance text-fg-muted", className)}>
      {children}
    </p>
  )
}

/** The small mono label above a heading, over a divider, or in a footer column. */
export function MonoLabel({
  className,
  children,
}: {
  readonly className?: string
  readonly children: React.ReactNode
}) {
  return (
    <span
      className={cn(
        "font-mono text-[11px] leading-none font-medium tracking-[0.08em] text-quiet select-none",
        className,
      )}
    >
      {children}
    </span>
  )
}

/** The dark pill: the page's one high-emphasis action. */
export function DownloadButton({ className }: { readonly className?: string }) {
  return (
    <a
      href="#download"
      className={cn(
        "flex h-11 shrink-0 items-center gap-[9px] rounded-default bg-contrast px-5 select-none",
        "text-[14px] font-medium text-on-contrast transition-opacity hover:opacity-90",
        "focus-visible:ring-2 focus-visible:ring-focus/50 focus-visible:outline-none",
        className,
      )}
    >
      <AppleIcon />
      {CTA.download}
    </a>
  )
}

/**
 * The quiet half of the pair. A `$` in the same mono as the command, because
 * the thing it is quoting is a shell line, not a label -- and the line itself
 * is `select-all`, so one click takes the whole command and none of the prompt.
 */
export function CommandButton({ className }: { readonly className?: string }) {
  return (
    <a
      href="#install"
      className={cn(
        "flex h-11 shrink-0 items-center gap-2.5 rounded-default border border-line-subtle bg-surface px-[18px]",
        "font-mono text-[14px] text-fg transition-colors hover:border-line-strong",
        "focus-visible:ring-2 focus-visible:ring-focus/50 focus-visible:outline-none",
        className,
      )}
    >
      <span aria-hidden className="text-quiet-strong select-none">
        $
      </span>
      <span className="select-all">{CTA.command}</span>
    </a>
  )
}

export function ActionPair({ className }: { readonly className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center justify-center gap-2.5", className)}>
      <DownloadButton />
      <CommandButton />
    </div>
  )
}

/** A ticked line in a plan card. */
export function CheckItem({ children }: { readonly children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2.5">
      <CheckMark />
      <span className="text-[15px] text-fg-muted">{children}</span>
    </li>
  )
}

function CheckMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0">
      <path
        d="M3 8.5L6.2 11.5L13 4.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-fg"
      />
    </svg>
  )
}
