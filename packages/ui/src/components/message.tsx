import { cn } from "@evie/ui/lib/utils"
import { Bubble, BubbleContent, BubbleGroup } from "@evie/ui/components/bubble"
import { Marker, MarkerContent } from "@evie/ui/components/marker"

/**
 * Message surfaces, built on the shadcn chat components (`bubble`, `marker`,
 * and the `message` row parts below). The chat primitives own alignment,
 * variants, and slot wiring; this file owns what Evie says with them.
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

/* ----------------------------------------------------------------------------
 * shadcn `message` row parts, vendored 1:1 (registry/base-nova/ui/message.tsx).
 * The avatar/header/footer lanes are here for multi-member threads; the solo
 * stream renders bubbles directly and pays nothing for them.
 * ------------------------------------------------------------------------- */

function MessageGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-group"
      className={cn("flex min-w-0 flex-col gap-2", className)}
      {...props}
    />
  )
}

function Message({
  className,
  align = "start",
  ...props
}: React.ComponentProps<"div"> & { align?: "start" | "end" }) {
  return (
    <div
      data-slot="message"
      data-align={align}
      className={cn(
        "group/message relative flex w-full min-w-0 gap-2 text-sm data-[align=end]:flex-row-reverse",
        className,
      )}
      {...props}
    />
  )
}

function MessageAvatar({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-avatar"
      className={cn(
        "flex w-fit min-w-8 shrink-0 items-center justify-center self-end overflow-hidden rounded-full bg-muted group-has-data-[slot=message-footer]/message:-translate-y-8",
        className,
      )}
      {...props}
    />
  )
}

function MessageContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-content"
      className={cn(
        "flex w-full min-w-0 flex-col gap-2.5 wrap-break-word group-data-[align=end]/message:*:data-slot:self-end",
        className,
      )}
      {...props}
    />
  )
}

function MessageHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-header"
      className={cn(
        "flex max-w-full min-w-0 items-center px-3 text-xs font-medium text-muted-foreground group-has-data-[variant=ghost]/message:px-0",
        className,
      )}
      {...props}
    />
  )
}

function MessageFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-footer"
      className={cn(
        "flex max-w-full min-w-0 items-center px-3 text-xs font-medium text-muted-foreground group-has-data-[variant=ghost]/message:px-0 group-data-[align=end]/message:justify-end",
        className,
      )}
      {...props}
    />
  )
}

/* ----------------------------------------------------------------------------
 * Evie's surfaces, composed from the primitives above.
 * ------------------------------------------------------------------------- */

/** Evie's bubble shape over the primitive's default: Paper's radius and measure. */
const CONTENT = "rounded-bubble px-[18px] py-3 text-body text-fg"

export function UserBubble({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="flex justify-end">
      {/* `secondary` is the raised-strong surface — the same token the old bubble used. */}
      <Bubble align="end" variant="secondary" className="max-w-[780px]">
        <BubbleContent className={CONTENT}>{children}</BubbleContent>
      </Bubble>
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
    <Bubble variant="muted" className="max-w-[780px]">
      <BubbleContent className={cn(CONTENT, "flex w-full flex-col gap-4")}>
        {children}
        {/*
          A block caret, not a pulsing dot. It appears and disappears with the
          stream and never animates -- a 60fps pulse on a surface the user stares
          at all day is exactly the GPU cost AGENTS.md forbids.
        */}
        {streaming && <span aria-hidden className="-mt-4 inline-block h-[18px] w-[2px] bg-fg align-text-bottom" />}
      </BubbleContent>
    </Bubble>
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
    <Marker className="justify-center pb-2 text-metadata select-none">
      <MarkerContent>{label}</MarkerContent>
    </Marker>
  )
}

/** Wraps consecutive assistant bubbles so they sit 8px apart and 8px below the user's. */
export function AssistantGroup({ children }: { readonly children: React.ReactNode }) {
  return <BubbleGroup className="items-start pt-2">{children}</BubbleGroup>
}

export { MessageGroup, Message, MessageAvatar, MessageContent, MessageFooter, MessageHeader }
