import { ActionButton } from "@evie/ui/components/action-button"
import { BotMark } from "@evie/ui/components/bot-mark"
import { ArrowUpIcon, PlusLargeIcon } from "@evie/ui/components/icon"
import { DragRegion, WindowControls } from "~/components/window-controls.tsx"

/**
 * 03 Onboarding — meet Evie.
 *
 * One idea on a black field: you hand work to a bot the way you hand work to a
 * person. The composer under the mark is a still life, not a control -- it is
 * showing the shape of the thing you are about to use, and making it typeable
 * here would be a second place to start a conversation that goes nowhere.
 */

export interface MeetEvieScreenProps {
  readonly onNext: () => void
  readonly onSkip: () => void
  /** The Electron shell draws window controls; the browser has no window. */
  readonly desktop?: boolean
}

export function MeetEvieScreen({ onNext, onSkip, desktop = false }: MeetEvieScreenProps) {
  return (
    <div className="relative flex h-full flex-col items-center justify-center gap-12 overflow-hidden bg-surface px-10">
      {desktop && (
        <>
          <DragRegion />
          <WindowControls className="absolute top-5 left-5" />
        </>
      )}

      {/*
        First-run only, so this is where the delight budget lives: title, then
        the mark and specimen, then the buttons, each 60ms behind the last.
        One shot on mount; the window controls stay out of it -- chrome does
        not fade in.
      */}
      <h1 className="evie-enter text-page-title tracking-section text-fg">Meet Evie</h1>

      <div className="evie-enter flex flex-col items-center gap-8 [animation-delay:60ms]">
        <BotMark size={88} tone={1} label="Evie" />

        <div className="flex w-[620px] max-w-full flex-col gap-3.5 rounded-bubble bg-raised px-[18px] py-4">
          {/* 17px is off the type scale on purpose: this line is a specimen of
              the composer, sized between body and lede so it reads as a real
              message rather than as a heading. The line itself is real copy, so
              only the mocked controls below hide from the accessibility tree. */}
          <p className="text-[17px] leading-6 text-fg">Hand off any task to your team of bots</p>
          <div aria-hidden className="flex items-center gap-3">
            <span className="flex size-[34px] shrink-0 items-center justify-center rounded-full bg-raised-strong text-fg">
              <PlusLargeIcon size={17} />
            </span>
            <span className="min-w-0 flex-1" />
            <span className="flex size-[34px] shrink-0 items-center justify-center rounded-full bg-fg text-surface">
              <ArrowUpIcon size={17} />
            </span>
          </div>
        </div>
      </div>

      <div className="evie-enter flex w-[340px] flex-col items-center gap-2.5 [animation-delay:120ms]">
        <ActionButton block onClick={onNext}>
          Next
        </ActionButton>
        {/* The design draws the ghost step at regular weight, not the button medium. */}
        <ActionButton block variant="ghost" className="font-normal" onClick={onSkip}>
          Skip setup
        </ActionButton>
      </div>
    </div>
  )
}
