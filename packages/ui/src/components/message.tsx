import { cn } from "@evie/ui/lib/utils"

/**
 * Message surfaces.
 *
 * Two bubble tones, no tails, no avatars in the stream: a thread is one person
 * and one bot most of the time, and side plus tone already says who is talking.
 * Attribution appears only when a thread has more than one member, via
 * `MemberChip`, which collapses to nothing in a solo organization.
 *
 * Both bubbles cap at 780px. A 16px/24px line is comfortable to about 90
 * characters and the window is 1440 wide; without the cap a long reply becomes
 * a wall the eye cannot track back across.
 */

const BUBBLE = "max-w-[780px] rounded-bubble px-[18px] py-3 text-body text-fg"

export function UserBubble({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="flex justify-end">
      <div className={cn(BUBBLE, "bg-raised-strong")}>{children}</div>
    </div>
  )
}

export interface AssistantBubbleProps {
  readonly children: React.ReactNode
  /** Set while this is the bubble receiving deltas. Drives the caret, nothing else. */
  readonly streaming?: boolean
}

export function AssistantBubble({ children, streaming = false }: AssistantBubbleProps) {
  return (
    <div className={cn(BUBBLE, "flex flex-col gap-4 bg-raised")}>
      {children}
      {/*
        A block caret, not a pulsing dot. It appears and disappears with the
        stream and never animates -- a 60fps pulse on a surface the user stares
        at all day is exactly the GPU cost AGENTS.md forbids.
      */}
      {streaming && <span aria-hidden className="-mt-4 inline-block h-[18px] w-[2px] bg-fg align-text-bottom" />}
    </div>
  )
}

/** A paragraph inside a bubble. The 16px gap between them is the bubble's, not the text's. */
export function Paragraph({ children }: { readonly children: React.ReactNode }) {
  return <p className="text-body whitespace-pre-wrap">{children}</p>
}

/**
 * "Today 3:52 PM". Groups the stream by session rather than by calendar day, so
 * a thread picked up after lunch reads as two conversations.
 */
export function DayDivider({ label }: { readonly label: string }) {
  return (
    <div className="flex items-center justify-center pb-2">
      <span className="text-metadata text-fg-muted">{label}</span>
    </div>
  )
}

/** Wraps consecutive assistant bubbles so they sit 8px apart and 8px below the user's. */
export function AssistantGroup({ children }: { readonly children: React.ReactNode }) {
  return <div className="flex flex-col items-start gap-2 pt-2">{children}</div>
}
