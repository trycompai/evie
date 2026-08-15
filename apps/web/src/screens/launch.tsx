import { BotMark } from "@evie/ui/components/bot-mark"
import { DragRegion, WindowControls } from "~/components/window-controls.tsx"

/**
 * The hand-off screen: shown by the desktop app while sign-in continues in the
 * browser, and by the browser for the moment before the claim token is
 * redeemed. There is nothing to do here but wait, so the screen says exactly
 * one thing at a time: the wordmark, what is happening, and the two ways out.
 *
 * The ring next to the status line is deliberately static -- the text carries
 * the state change, not a spinner (see AGENTS.md on repainting animation).
 */

export type LaunchState = "waiting" | "opening" | "failed" | "expired"

const STATUS_COPY: Record<LaunchState, string> = {
  opening: "Opening your browser…",
  waiting: "Continue in your browser",
  failed: "Your browser didn't open",
  // Sign-in links are single-use and expire in a minute, so a reload of a spent
  // one lands here. Saying where a new one comes from is the whole job: this
  // tab cannot mint one, and offering a button that pretends otherwise is how
  // someone spends five minutes clicking it.
  expired: "That sign-in link was already used",
}

export interface LaunchScreenProps {
  readonly state: LaunchState
  readonly onReopen: () => void
  readonly onCancel: () => void
  /** True inside the Electron shell, where the window has controls to draw. */
  readonly desktop?: boolean
}

/** A static three-quarter ring. It marks the status line; it never spins. */
function StatusRing() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      xmlns="http://www.w3.org/2000/svg"
      className="shrink-0"
      aria-hidden
    >
      <circle cx="9" cy="9" r="7.6" fill="none" strokeWidth="1.5" className="stroke-fg-muted" />
      <path
        d="M9 1.4a7.6 7.6 0 017.6 7.6"
        fill="none"
        strokeWidth="1.5"
        strokeLinecap="round"
        className="stroke-fg"
      />
    </svg>
  )
}

/** The eve wordmark, traced from the design. */
function EveWordmark() {
  return (
    <svg
      width="58"
      height="18"
      viewBox="0 0 169 53"
      xmlns="http://www.w3.org/2000/svg"
      className="shrink-0 fill-fg"
      role="img"
      aria-label="eve"
    >
      <path d="M169 8.47h-51.39L81.73 53H70.36L113 0H169zM169 44.51v8.47h-45.87V44.5zM45.87 52.98H0V44.5h45.87zM38.66 30.55H0v-8.47h38.66z" />
      <path d="M169 30.55h-38.66v-8.47H169zM75.52 8.47H0V0h75.52z" />
    </svg>
  )
}

export function LaunchScreen({ state, onReopen, onCancel, desktop }: LaunchScreenProps) {
  return (
    <div className="relative flex h-full flex-col items-center justify-center gap-10 overflow-hidden bg-surface">
      {desktop ? <DragRegion /> : null}
      {desktop ? <WindowControls className="absolute left-5 top-5" /> : null}

      <div className="flex items-center gap-5">
        <BotMark shape="circle" tone={1} size={72} />
        <div className="text-[64px] font-medium leading-[72px] tracking-[-0.05em] text-fg">
          Evie
        </div>
      </div>

      {/*
        Paper sizes this box at 560px, which fits its artboard's system font on
        one line. Geist is wider, and Geist is the product's font -- so the box
        grows to keep the design's line break rather than keeping its number and
        orphaning "work to." on a second line.
      */}
      <p className="w-[620px] max-w-full text-center text-[22px] leading-8 text-fg">
        Your team of always-on bots that you can give real work to.
      </p>

      <div className="flex flex-col items-center gap-[18px] pt-6">
        <div className="flex items-center gap-2.5 select-none" role="status">
          <StatusRing />
          <span className="text-body text-fg-muted">{STATUS_COPY[state]}</span>
        </div>
        <div className="flex items-center gap-3 select-none">
          <button
            type="button"
            onClick={onReopen}
            className="text-ui font-medium leading-[22px] text-link focus-visible:ring-2 focus-visible:ring-focus/50 focus-visible:outline-none"
          >
            Reopen link
          </button>
          <span aria-hidden className="text-ui leading-[22px] text-fg-muted">
            ·
          </span>
          <button
            type="button"
            onClick={onCancel}
            className="text-ui leading-[22px] text-fg focus-visible:ring-2 focus-visible:ring-focus/50 focus-visible:outline-none"
          >
            Cancel
          </button>
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-10 flex items-center justify-center gap-2.5">
        <span className="text-compact text-fg-muted select-none">Powered by</span>
        <EveWordmark />
      </div>
    </div>
  )
}
