import { BotMark } from "@evie/ui/components/bot-mark"

/**
 * Marks.
 *
 * Evie's own mark is not redrawn here: it is `BotMark` on its default shape and
 * tone, the same drawing the rail renders at 34px and the new-bot hero renders
 * at 96px. The slots punch through in `--color-surface-primary`, so the mark is
 * black-on-white out here and white-on-black inside the dark product renders
 * without a second asset.
 *
 * eve's wordmark is theirs, reproduced from the lockup the app ships on its
 * launch screen -- same viewBox, same path data. Only the fill is ours,
 * because the app draws it on black and this page draws it on white.
 */

export function EvieMark({
  size = 22,
  className,
}: {
  readonly size?: number
  /** Overrides `size` responsively, where the design has one artboard and the page has many widths. */
  readonly className?: string
}) {
  return <BotMark size={size} className={className} />
}

export function EvieWordmark() {
  return (
    <span className="flex items-center gap-[9px] select-none">
      <EvieMark size={22} />
      <span className="text-[17px] leading-none font-medium tracking-[-0.03em] text-fg">Evie</span>
    </span>
  )
}

export function EveLogo({ width = 46 }: { readonly width?: number }) {
  return (
    <svg
      width={width}
      height={Math.round((width * 53) / 169)}
      viewBox="0 0 169 53"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="eve"
      className="shrink-0"
    >
      <path
        d="M169 8.47h-51.39L81.73 53H70.36L113 0H169zM169 44.51v8.47h-45.87V44.5zM45.87 52.98H0V44.5h45.87zM38.66 30.55H0v-8.47h38.66z"
        fill="currentColor"
      />
      <path d="M169 30.55h-38.66v-8.47H169zM75.52 8.47H0V0h75.52z" fill="currentColor" />
    </svg>
  )
}

/** The attribution lockup, in the hero at 46px and the colophon at 42px. */
export function PoweredByEve({
  width = 46,
  size = "text-[13px]",
}: {
  readonly width?: number
  readonly size?: string
}) {
  return (
    <span className="flex items-center gap-2.5 select-none">
      <span className={`${size} text-quiet`}>Powered by</span>
      <span className="text-fg">
        <EveLogo width={width} />
      </span>
    </span>
  )
}

export function GitHubIcon({ size = 14 }: { readonly size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden
      className="shrink-0"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 005.47 7.59c.4.07.55-.17.55-.38l-.01-1.49c-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 014 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48l-.01 2.19c0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}

export function AppleIcon({ size = 15 }: { readonly size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden
      className="shrink-0"
    >
      <path d="M11.18 8.5c-.02-1.63 1.33-2.42 1.39-2.46-.76-1.1-1.93-1.26-2.35-1.27-1-.1-1.95.59-2.46.59-.51 0-1.29-.58-2.12-.56-1.09.02-2.1.63-2.66 1.61-1.13 1.97-.29 4.88.81 6.47.54.78 1.18 1.65 2.02 1.62.81-.03 1.12-.52 2.1-.52.98 0 1.26.52 2.12.51.88-.02 1.43-.79 1.96-1.57.62-.9.87-1.77.89-1.81-.02-.01-1.7-.65-1.7-2.61zM9.6 3.24c.45-.55.75-1.3.67-2.06-.65.03-1.43.43-1.9.97-.42.48-.78 1.25-.68 1.99.72.06 1.46-.37 1.91-.9z" />
    </svg>
  )
}
