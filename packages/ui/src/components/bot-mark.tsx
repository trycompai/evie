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
 * Six neutral steps, light to dark, then six hues. The neutrals stay the
 * default -- `defaultMark` never deals a hue, so a fleet that never visited the
 * picker stays quiet and the one place Evie *spends* colour is still status.
 * The hues are for the picker: muted, mid-lightness, and deliberately duller
 * than the status colours so a coloured face never reads as a state.
 */
export type BotTone = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12

const TONE_FILL: Record<BotTone, string> = {
  1: "var(--color-text-primary)",
  2: "var(--color-gray-500)",
  3: "var(--color-gray-600)",
  4: "var(--color-gray-700)",
  5: "var(--color-gray-800)",
  6: "var(--color-gray-900)",
  7: "var(--color-bot-blue)",
  8: "var(--color-bot-teal)",
  9: "var(--color-bot-olive)",
  10: "var(--color-bot-violet)",
  11: "var(--color-bot-rose)",
  12: "var(--color-bot-gold)",
}

/**
 * The eyes are normally punched in the page background, but that only reads
 * when the fill sits far from the surface colour. Gold is light enough that
 * light mode's white eyes would sink into it, so its slots are drawn in ink
 * instead -- the ink is theme-independent because the fill is too, and dark
 * eyes read on a light fill in both themes. Every tone the picker offers must
 * either clear the surface colour in both themes or map its eyes here; that is
 * the invariant that keeps a new swatch from shipping a blind face.
 */
const TONE_EYES: Partial<Record<BotTone, string>> = {
  12: "var(--color-gray-1000)",
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
  /**
   * What the face is doing.
   *
   * A state rather than a set of booleans, because a face has one expression at
   * a time and the drawing enforces it: all three moods animate the same group,
   * so two at once is not a thing the DOM can express.
   *
   * - `still` draws the face. It may still follow the pointer -- that is the
   *   cursor's doing, not a mood, and it composes with the other two.
   * - `waking` plays once on mount, for the moment a bot comes into being. A
   *   mark that redraws on every navigation must not ask for it.
   * - `busy` loops, for a bot whose computer is still being built. It is the
   *   only looping mood and it is deliberately cheap; see `globals.css`.
   */
  readonly mood?: "still" | "waking" | "busy"
}

const MOOD_EYES = {
  still: undefined,
  waking: "evie-wake-eyes",
  busy: "evie-busy-eyes",
} as const

export function BotMark({
  shape = "circle",
  tone = 1,
  size = 34,
  className,
  label,
  mood = "still",
}: BotMarkProps) {
  const slot = SLOTS[shape]
  const eyeFill = TONE_EYES[tone] ?? "var(--color-surface-primary)"
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 34 34"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("shrink-0", mood === "waking" && "evie-wake", className)}
      style={{ color: TONE_FILL[tone] }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {shapePath(shape)}
      {/*
        Two groups, because the eyes have two independent reasons to move and
        one transform each. The outer one carries the mood; the inner one is
        written by `lib/gaze.ts` to follow the pointer. Nesting them means a bot
        that is waking, or busy building its computer, can do that *and* look at
        you, instead of the two fighting over one `transform`.

        `.evie-gaze` is how the gaze finds its marks, so it is unconditional:
        outside a region that watches the pointer, nothing ever writes to it and
        the class costs nothing.

        The slots themselves are punched in the page background rather than in
        the shape, so a mark on a raised surface still reads. Using the surface
        token keeps that true in both themes without a second drawing -- except
        for the tones in TONE_EYES, whose fills sit too close to a surface
        colour to punch through.
      */}
      <g className={MOOD_EYES[mood]}>
        <g className="evie-gaze">
          <rect x="11.6" y={slot.y} width="3.6" height={slot.h} rx="1.8" fill={eyeFill} />
          <rect x="18.8" y={slot.y} width="3.6" height={slot.h} rx="1.8" fill={eyeFill} />
        </g>
      </g>
    </svg>
  )
}

const SHAPES: readonly BotShape[] = ["circle", "squircle", "hexagon", "pod", "triangle", "blob"]
const TONES: readonly BotTone[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]

/**
 * The first six tones: what a bot wears when nobody chose. `defaultMark` deals
 * only from these, and the list is frozen at six on purpose -- widening it
 * would re-deal the face of every bot that never visited the picker, because
 * the hash below takes the list length as its modulus.
 */
const NEUTRAL_TONES: readonly BotTone[] = [1, 2, 3, 4, 5, 6]

export const BOT_SHAPES = SHAPES
export const BOT_TONES = TONES

/**
 * The swatch colours, one per tone, exactly the fills the mark draws. Exported
 * for the pickers: with twelve tones and two picker surfaces (the app's and the
 * landing page's still of it), private-plus-duplicated stopped being cheaper
 * than one export.
 */
export const BOT_TONE_FILLS: Record<BotTone, string> = TONE_FILL

/** What a screen reader calls each swatch. "Tone 9" tells nobody anything. */
export const BOT_TONE_NAMES: Record<BotTone, string> = {
  1: "Ink",
  2: "Mist",
  3: "Silver",
  4: "Stone",
  5: "Slate",
  6: "Charcoal",
  7: "Blue",
  8: "Teal",
  9: "Olive",
  10: "Violet",
  11: "Rose",
  12: "Gold",
}

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
  return {
    shape: SHAPES[n % SHAPES.length]!,
    tone: NEUTRAL_TONES[(n >>> 8) % NEUTRAL_TONES.length]!,
  }
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
