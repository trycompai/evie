import { ActionButton } from "@evie/ui/components/action-button"
import { BOT_SHAPES, BOT_TONES, BotMark, type BotShape, type BotTone } from "@evie/ui/components/bot-mark"
import { TextField } from "@evie/ui/components/text-field"
import { cn } from "@evie/ui/lib/utils"
import { MockRail } from "~/components/screens/mock-rail"
import { Screen } from "~/components/screens/screen-frame"

/**
 * 05 New bot, as a still.
 *
 * The picker is the product's: `BotMark` draws the hero and all six shapes, so
 * the faces on this page are the faces the app draws. Only the two radio rows
 * are re-laid-out here, because theirs carry roving-tabindex keyboard handling
 * that a screenshot has no use for.
 *
 * The suggestions are the app's `BOT_SUGGESTIONS`, restated rather than
 * imported: `apps/web` owns them, apps do not import each other, and the day
 * they move into a package this block becomes one import.
 */

const SHAPE: BotShape = "circle"
const TONE: BotTone = 1

/** Mirrors `BotMark`'s private tone fills, as the app's picker does. */
const TONE_SWATCH: Record<BotTone, string> = {
  1: "var(--color-text-primary)",
  2: "var(--color-gray-500)",
  3: "var(--color-gray-600)",
  4: "var(--color-gray-700)",
  5: "var(--color-gray-800)",
  6: "var(--color-gray-900)",
}

const SUGGESTIONS = [
  {
    name: "Channel Digest",
    blurb: "Summarises your Slack channels and flags what needs you.",
    shape: "hexagon",
    tone: 2,
  },
  {
    name: "Deck Designer",
    blurb: "Turns your notes into an on-brand Workspace deck.",
    shape: "squircle",
    tone: 2,
  },
  {
    name: "Night Shift",
    blurb: "Works overnight so your morning starts already sorted.",
    shape: "pod",
    tone: 3,
  },
] as const satisfies readonly {
  name: string
  blurb: string
  shape: BotShape
  tone: BotTone
}[]

export function NewBotScreen() {
  return (
    <Screen>
      <MockRail composing />
      <div className="flex h-full min-w-0 flex-1 flex-col bg-surface">
        <header className="flex h-14 shrink-0 items-center gap-2.5 px-5">
          <span className="flex w-[22px] shrink-0 items-center justify-center">
            <BotMark size={18} shape={SHAPE} tone={TONE} />
          </span>
          <h1 className="text-ui font-medium text-fg">New bot</h1>
        </header>

        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-10">
          <BotMark size={96} shape={SHAPE} tone={TONE} />

          <div className="flex items-center gap-2.5">
            {BOT_TONES.map((tone) => (
              <span
                key={tone}
                className={cn(
                  "size-[26px] shrink-0 rounded-pill",
                  tone === TONE && "ring-2 ring-fg ring-offset-2 ring-offset-surface",
                )}
                style={{ backgroundColor: TONE_SWATCH[tone] }}
              />
            ))}
          </div>

          <div className="flex items-center gap-1.5">
            {BOT_SHAPES.map((shape) => (
              <span
                key={shape}
                className={cn(
                  "flex size-11 shrink-0 items-center justify-center rounded-default",
                  shape === SHAPE && "border border-line-strong",
                )}
              >
                <BotMark size={26} shape={shape} tone={TONE} />
              </span>
            ))}
          </div>

          <div className="flex flex-col items-center gap-6">
            <TextField
              id="new-bot-name"
              label="Name"
              placeholder="Chief of Staff"
              readOnly
              tabIndex={-1}
              containerClassName="w-[380px] pt-2"
            />
            <ActionButton shape="rounded" className="h-11 w-[380px]">
              Get started
            </ActionButton>
          </div>
        </div>

        <div className="flex shrink-0 flex-col gap-3 px-7 pb-7">
          <p className="text-compact text-fg-muted">Suggestions</p>
          <div className="flex gap-3">
            {SUGGESTIONS.map((suggestion) => (
              <span
                key={suggestion.name}
                className="flex min-w-0 flex-1 items-start gap-3.5 rounded-default bg-raised p-4 text-left"
              >
                <span className="flex w-9 shrink-0 justify-center">
                  <BotMark size={34} shape={suggestion.shape} tone={suggestion.tone} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="text-ui font-medium text-fg">{suggestion.name}</span>
                  <span className="text-compact text-fg-muted">{suggestion.blurb}</span>
                </span>
              </span>
            ))}
          </div>
        </div>
      </div>
    </Screen>
  )
}
