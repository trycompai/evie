import { ActionButton } from "@evie/ui/components/action-button"
import { BotMark, BOT_SHAPES, BOT_TONES } from "@evie/ui/components/bot-mark"
import type { BotShape, BotTone } from "@evie/ui/components/bot-mark"
import { TextField } from "@evie/ui/components/text-field"
import { cn } from "@evie/ui/lib/utils"

/**
 * 05 New bot.
 *
 * The main column of the new-bot flow: pick a face, name it, go. The form is
 * deliberately thin -- everything else a bot needs (plugins, instructions) is
 * settled in conversation after it exists, not in a wizard before.
 */

export interface BotSuggestion {
  readonly name: string
  readonly blurb: string
  readonly shape: BotShape
  readonly tone: BotTone
}

/** The three starter bots pitched under the form, exactly as designed. */
export const BOT_SUGGESTIONS: readonly BotSuggestion[] = [
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
]

/**
 * Mirrors BotMark's tone fills so a swatch is the exact colour the mark will
 * be. BotMark keeps the mapping private; duplicating six vars here beats
 * widening the design system's surface for one picker.
 */
const TONE_SWATCH: Record<BotTone, string> = {
  1: "var(--color-text-primary)",
  2: "var(--color-gray-500)",
  3: "var(--color-gray-600)",
  4: "var(--color-gray-700)",
  5: "var(--color-gray-800)",
  6: "var(--color-gray-900)",
}

/**
 * Roving-tabindex arrow navigation for a radio row: Left/Up and Right/Down move
 * focus and selection together, wrapping at the ends. Selection follows focus,
 * the standard radio-group pattern, so `click()` is the whole state change.
 */
function radioArrowNav(event: React.KeyboardEvent<HTMLButtonElement>) {
  const delta =
    event.key === "ArrowRight" || event.key === "ArrowDown"
      ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? -1
        : 0
  if (delta === 0) return
  event.preventDefault()
  const group = event.currentTarget.closest('[role="radiogroup"]')
  if (!group) return
  const radios = Array.from(group.querySelectorAll<HTMLButtonElement>('[role="radio"]'))
  const next = radios[(radios.indexOf(event.currentTarget) + delta + radios.length) % radios.length]
  next?.focus()
  next?.click()
}

export interface NewBotScreenProps {
  readonly name: string
  readonly onNameChange: (name: string) => void
  readonly shape: BotShape
  readonly tone: BotTone
  readonly onShapeChange: (shape: BotShape) => void
  readonly onToneChange: (tone: BotTone) => void
  readonly onCreate: () => void
  readonly onPickSuggestion: (suggestion: BotSuggestion) => void
  /** Disables the form while the create round-trip is in flight. */
  readonly creating?: boolean
}

export function NewBotScreen({
  name,
  onNameChange,
  shape,
  tone,
  onShapeChange,
  onToneChange,
  onCreate,
  onPickSuggestion,
  creating = false,
}: NewBotScreenProps) {
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-surface">
      <header className="flex h-14 shrink-0 items-center gap-2.5 px-5">
        <span className="flex w-[22px] shrink-0 items-center justify-center">
          <BotMark size={18} shape={shape} tone={tone} />
        </span>
        <h1 className="text-ui font-medium text-fg select-none">New bot</h1>
      </header>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-10">
        <BotMark size={96} shape={shape} tone={tone} />

        <div role="radiogroup" aria-label="Tone" className="flex items-center gap-2.5">
          {BOT_TONES.map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={t === tone}
              aria-label={`Tone ${t}`}
              tabIndex={t === tone ? 0 : -1}
              onClick={() => onToneChange(t)}
              onKeyDown={radioArrowNav}
              className={cn(
                "size-[26px] shrink-0 rounded-pill focus-visible:ring-2 focus-visible:ring-focus/50 focus-visible:outline-none",
                // An offset ring rather than the design's same-colour border,
                // which disappears exactly on tone 1 -- the default.
                t === tone && "ring-2 ring-fg ring-offset-2 ring-offset-surface",
              )}
              style={{ backgroundColor: TONE_SWATCH[t] }}
            />
          ))}
        </div>

        <div role="radiogroup" aria-label="Shape" className="flex items-center gap-1.5">
          {BOT_SHAPES.map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={s === shape}
              aria-label={s}
              tabIndex={s === shape ? 0 : -1}
              onClick={() => onShapeChange(s)}
              onKeyDown={radioArrowNav}
              className={cn(
                "flex size-11 shrink-0 items-center justify-center rounded-default",
                "focus-visible:ring-2 focus-visible:ring-focus/50 focus-visible:outline-none",
                s === shape && "border border-line-strong",
              )}
            >
              <BotMark size={26} shape={s} tone={tone} />
            </button>
          ))}
        </div>

        <form
          className="flex flex-col items-center gap-6"
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim() && !creating) onCreate()
          }}
        >
          <TextField
            id="new-bot-name"
            label="Name"
            placeholder="Chief of Staff"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            disabled={creating}
            containerClassName="w-[380px] pt-2"
          />
          <ActionButton
            type="submit"
            shape="rounded"
            disabled={!name.trim() || creating}
            className="h-11 w-[380px]"
          >
            Get started
          </ActionButton>
        </form>
      </div>

      <div className="flex shrink-0 flex-col gap-3 px-7 pb-7">
        <p className="text-compact text-fg-muted select-none">Suggestions</p>
        <div className="flex gap-3">
          {BOT_SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion.name}
              type="button"
              onClick={() => onPickSuggestion(suggestion)}
              className={cn(
                "flex min-w-0 flex-1 items-start gap-3.5 rounded-default bg-raised p-4 text-left select-none",
                "hover:bg-raised-strong focus-visible:ring-2 focus-visible:ring-focus/50 focus-visible:outline-none",
              )}
            >
              <span className="flex w-9 shrink-0 justify-center">
                <BotMark size={34} shape={suggestion.shape} tone={suggestion.tone} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-ui font-medium text-fg">{suggestion.name}</span>
                <span className="text-compact text-fg-muted">{suggestion.blurb}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
