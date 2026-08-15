import { cn } from "@evie/ui/lib/utils"

/**
 * A person.
 *
 * `MemberAvatar` is the initials disc; `MemberChip` is the name-and-avatar pair
 * used to attribute a message in a shared thread.
 *
 * **The chip collapses to nothing in a solo organization.** A single user
 * should not pay a pixel for the team feature, so `MemberChip` returns null
 * when `solo` is set rather than the caller branching at every call site.
 */

export interface MemberAvatarProps {
  readonly name: string
  readonly image?: string | null
  readonly size?: number
  /**
   * Initials size. Defaults to half the disc, which is right up to about 32px
   * and too heavy above it -- a big disc wants proportionally smaller type, and
   * the design sets 16px on a 44px avatar. Passing this beats overriding the
   * inline style from outside, which needs `!important` and then quietly stops
   * working the day someone adds a second declaration here.
   */
  readonly fontSize?: number
  readonly className?: string
}

/** "Lewis Carhart" -> "LC". One initial for a mononym, never three. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "?"
  const first = parts[0]![0]!
  const last = parts.length > 1 ? parts[parts.length - 1]![0]! : ""
  return (first + last).toUpperCase()
}

export function MemberAvatar({ name, image, size = 22, fontSize, className }: MemberAvatarProps) {
  if (image) {
    return (
      <img
        src={image}
        alt=""
        width={size}
        height={size}
        className={cn("shrink-0 rounded-full object-cover", className)}
      />
    )
  }
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-raised font-medium text-fg select-none",
        className,
      )}
      style={{ width: size, height: size, fontSize: fontSize ?? Math.round(size * 0.5), lineHeight: 1 }}
    >
      {initials(name)}
    </span>
  )
}

export interface MemberChipProps {
  readonly name: string
  readonly image?: string | null
  /**
   * True when the organization has exactly one member. Attribution is noise
   * when there is nobody to distinguish from.
   */
  readonly solo?: boolean
  readonly className?: string
}

export function MemberChip({ name, image, solo = false, className }: MemberChipProps) {
  if (solo) return null
  return (
    <span className={cn("flex items-center gap-1.5 text-metadata text-fg-muted", className)}>
      <MemberAvatar name={name} image={image} size={16} />
      {name}
    </span>
  )
}
