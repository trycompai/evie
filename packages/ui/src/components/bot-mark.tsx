import { cn } from "@evie/ui/lib/utils"

/**
 * A bot's face.
 *
 * Two slots in a solid shape: a wall socket. It is the same motif as the
 * Plugins glyph and the wordmark, and it is the whole product in one drawing --
 * a thing you plug work into. The slots sit slightly below centre, which is
 * what makes it read as a face rather than as an icon.
 *
 * Geometry is authored in a 34-unit box and scaled, so a 22px rail avatar and
 * an 88px onboarding hero are the same drawing rather than two drawings that
 * drift.
 */

/** The six shapes in the new-bot picker, in picker order. */
export type BotShape = "circle" | "squircle" | "hexagon" | "pod" | "triangle" | "blob"

/**
 * Six neutral steps, light to dark. Deliberately not colour: a rail of twelve
 * bots in twelve hues is a toy, and the one place Evie spends colour is status.
 */
export type BotTone = 1 | 2 | 3 | 4 | 5 | 6

const TONE_FILL: Record<BotTone, string> = {
  1: "var(--color-text-primary)",
  2: "var(--color-gray-500)",
  3: "var(--color-gray-600)",
  4: "var(--color-gray-700)",
  5: "var(--color-gray-800)",
  6: "var(--color-gray-900)",
}

/**
 * Slot geometry, per shape.
 *
 * The slots are not centred and not uniform: each shape's mass sits somewhere
 * different, so the design nudges the pair until the face reads. The hexagon's
 * lower point pulls them up and shortens them; the triangle's does far more of
 * both; the blob's asymmetric top pushes them up slightly. These are the
 * design's values, and eyeballing a single default in their place is the
 * difference between six faces and one face wearing five hats.
 */
const SLOTS: Record<BotShape, { readonly y: number; readonly h: number }> = {
  circle: { y: 17.4, h: 7 },
  squircle: { y: 17.4, h: 7 },
  hexagon: { y: 17, h: 6.6 },
  pod: { y: 17.4, h: 7 },
  triangle: { y: 20, h: 6.4 },
  blob: { y: 16.6, h: 7 },
}

const shapePath = (shape: BotShape) => {
  switch (shape) {
    case "circle":
      return <circle cx="17" cy="17" r="17" fill="currentColor" />
    case "squircle":
      return <rect x="0" y="0" width="34" height="34" rx="11" fill="currentColor" />
    case "hexagon":
      return <path d="M17 0L31.7 8.5V25.5L17 34L2.3 25.5V8.5L17 0Z" fill="currentColor" />
    /** Square on one corner, round on the other three. */
    case "pod":
      return (
        <path
          d="M0 17C0 7.6 7.6 0 17 0H34V17C34 26.4 26.4 34 17 34C7.6 34 0 26.4 0 17Z"
          fill="currentColor"
        />
      )
    case "triangle":
      return <path d="M17 1L33 31a2 2 0 01-1.8 3H2.8A2 2 0 011 31L17 1Z" fill="currentColor" />
    /** Deliberately lopsided — the one shape in the set that is hand-drawn. */
    case "blob":
      return (
        <path
          d="M17 0C24 0 34 5 34 14C34 24 27 34 17 34C7 34 0 26 0 16C0 6 9 0 17 0Z"
          fill="currentColor"
        />
      )
  }
}

export interface BotMarkProps {
  readonly shape?: BotShape
  readonly tone?: BotTone
  /** Rendered size in px. The rail uses 34, the header 18, the hero 88. */
  readonly size?: number
  readonly className?: string
  /** Names the bot for a screen reader. Omit inside a row that already says the name. */
  readonly label?: string
}

export function BotMark({ shape = "circle", tone = 1, size = 34, className, label }: BotMarkProps) {
  const slot = SLOTS[shape]
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 34 34"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("shrink-0", className)}
      style={{ color: TONE_FILL[tone] }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {shapePath(shape)}
      {/*
        The slots are punched in the page background rather than in the shape,
        so a mark on a raised surface still reads. Using the surface token keeps
        that true in both themes without a second drawing.
      */}
      <rect x="11.6" y={slot.y} width="3.6" height={slot.h} rx="1.8" fill="var(--color-surface-primary)" />
      <rect x="18.8" y={slot.y} width="3.6" height={slot.h} rx="1.8" fill="var(--color-surface-primary)" />
    </svg>
  )
}

const SHAPES: readonly BotShape[] = ["circle", "squircle", "hexagon", "pod", "triangle", "blob"]
const TONES: readonly BotTone[] = [1, 2, 3, 4, 5, 6]

export const BOT_SHAPES = SHAPES
export const BOT_TONES = TONES

/**
 * A stable mark for a bot that has not picked one.
 *
 * Derived from the id rather than from creation order, so two members looking
 * at the same fleet see the same faces and a bot keeps its face when the list
 * is re-sorted. ULIDs share a long time prefix, so the hash walks the whole
 * string instead of sampling the front.
 */
export function defaultMark(botId: string): { shape: BotShape; tone: BotTone } {
  let h = 2166136261
  for (let i = 0; i < botId.length; i++) {
    h ^= botId.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  const n = Math.abs(h)
  return { shape: SHAPES[n % SHAPES.length]!, tone: TONES[(n >>> 8) % TONES.length]! }
}

/**
 * The mark to draw for a bot: what the user picked, or a stable default.
 *
 * `Bot.avatar` holds `"<shape>:<tone>"` — what the new-bot picker wrote. Every
 * surface that draws a bot must go through here, because reaching for
 * `defaultMark(bot.id)` directly quietly ignores the choice the user made on
 * the one screen that exists to make it, and the bug looks like the picker
 * being broken rather than the rail being wrong.
 *
 * An unparseable or unknown value falls back rather than throwing: `avatar` is
 * a free-text column, and a bot with a face nobody chose beats a crash.
 */
export function markOf(bot: {
  readonly id: string
  readonly avatar?: string | null
}): { shape: BotShape; tone: BotTone } {
  const [shape, tone] = (bot.avatar ?? "").split(":")
  const known = SHAPES.find((candidate) => candidate === shape)
  const step = Number(tone)
  if (known !== undefined && TONES.some((candidate) => candidate === step)) {
    return { shape: known, tone: step as BotTone }
  }
  return defaultMark(bot.id)
}
