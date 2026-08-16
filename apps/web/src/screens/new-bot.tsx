import { ActionButton } from "@evie/ui/components/action-button"
import {
  BotMark,
  BOT_SHAPES,
  BOT_TONE_FILLS,
  BOT_TONE_NAMES,
  BOT_TONES,
} from "@evie/ui/components/bot-mark"
import type { BotShape, BotTone } from "@evie/ui/components/bot-mark"
import type { BotId } from "@evie/contracts/ids"
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

/** An archived bot, reduced to what the restore row draws. */
export interface ArchivedBot {
  readonly id: BotId
  readonly name: string
  readonly shape: BotShape
  readonly tone: BotTone
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
  /**
   * Deleted bots, restorable here. This screen is where bots come into being,
   * so it is also where they come back -- the way out of archive lives next to
   * the way in, not behind a settings pane that does not exist yet.
   */
  readonly archived?: readonly ArchivedBot[]
  readonly onRestore?: (botId: BotId) => void
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
  archived = [],
  onRestore,
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
        {/*
          Keyed by shape so picking one remounts the preview and it wakes: the
          mark pops and settles and the eyes open and look around. This is the
          bot you are about to make, so it is the one place in the app where a
          mark should look like it is coming to life, and it is the same
          animation its rail row plays the moment it exists.

          Tone is deliberately not in the key: a colour change is legible on its
          own, and re-waking on every swatch would make the picker feel busy.
        */}
        <BotMark key={shape} size={96} shape={shape} tone={tone} mood="waking" />

        {/* Two rows of six: neutrals above, hues below. A single line of twelve
            is wider than the name field, and the split says what the palette
            is -- a default row, and a row you opt into. */}
        <div role="radiogroup" aria-label="Tone" className="grid grid-cols-6 gap-2.5">
          {BOT_TONES.map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={t === tone}
              aria-label={BOT_TONE_NAMES[t]}
              tabIndex={t === tone ? 0 : -1}
              onClick={() => onToneChange(t)}
              onKeyDown={radioArrowNav}
              className={cn(
                "size-[26px] shrink-0 rounded-pill focus-visible:ring-2 focus-visible:ring-focus/50 focus-visible:outline-none",
                // An offset ring rather than the design's same-colour border,
                // which disappears exactly on tone 1 -- the default.
                t === tone && "ring-2 ring-fg ring-offset-2 ring-offset-surface",
              )}
              style={{ backgroundColor: BOT_TONE_FILLS[t] }}
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

      {archived.length > 0 && onRestore && (
        <div className="flex shrink-0 flex-col gap-3 px-7 pb-5">
          <p className="text-compact text-fg-muted select-none">Archived</p>
          <div className="flex flex-col gap-1">
            {archived.map((bot) => (
              <div
                key={bot.id}
                className="flex items-center gap-3 rounded-default px-2 py-1.5 hover:bg-raised"
              >
                <span className="flex w-6 shrink-0 justify-center">
                  <BotMark size={22} shape={bot.shape} tone={bot.tone} />
                </span>
                <span className="min-w-0 flex-1 truncate text-ui text-fg">{bot.name}</span>
                <button
                  type="button"
                  onClick={() => onRestore(bot.id)}
                  className={cn(
                    "shrink-0 rounded-pill px-3 py-1 text-compact font-medium text-fg select-none",
                    "hover:bg-raised-strong focus-visible:ring-2 focus-visible:ring-focus/50 focus-visible:outline-none",
                  )}
                >
                  Restore
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

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
