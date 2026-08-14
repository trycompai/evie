import { ChatScreen } from "~/components/screens/chat-screen"
import { FIT, ScreenFrame } from "~/components/screens/screen-frame"
import { EvieMark, PoweredByEve } from "~/components/site/brand"
import { ActionPair } from "~/components/site/primitives"
import { HERO } from "~/content/site"

/**
 * The hero.
 *
 * The mark sits inside the headline rather than above it, so the first thing on
 * the page is the product's face at 72px and the sentence reads through it.
 * Under the fold-line: the whole Chat window at 80%, uncropped and unstaged --
 * the argument for Evie is what Evie looks like.
 */

export function Hero() {
  return (
    <section className="flex w-full shrink-0 flex-col items-center bg-surface px-10 pt-14 pb-24 tablet:pt-[72px] tablet:pb-32">
      <p className="flex h-[30px] shrink-0 items-center gap-2.5 rounded-pill border border-line-subtle bg-surface pr-3 pl-1.5 select-none">
        <span className="flex h-5 items-center rounded-pill bg-raised px-2 font-mono text-[11px] font-medium tracking-[0.06em] text-fg">
          {HERO.badge}
        </span>
        <span className="hidden text-[13px] text-fg-muted tablet:inline">{HERO.note}</span>
        <ChevronRight />
      </p>

      <h1 className="flex flex-wrap items-center justify-center gap-3 pt-8 text-center text-[52px] leading-[58px] font-heading tracking-[-0.05em] text-balance text-fg tablet:gap-5 tablet:pt-[34px] tablet:text-[88px] tablet:leading-[96px] tablet:tracking-[-0.055em]">
        {HERO.title.before}
        <EvieMark size={72} className="size-11 tablet:size-[72px]" />
        {HERO.title.after}
      </h1>

      <p className="w-[660px] max-w-full pt-[22px] text-center text-lede text-balance text-fg-muted">
        {HERO.lede}
      </p>

      <ActionPair className="pt-[30px]" />

      <div className="pt-[26px]">
        <PoweredByEve />
      </div>

      <div className="flex w-full justify-center pt-12 tablet:pt-[58px]">
        <ScreenFrame
          width={1152}
          height={720}
          scale={0.8}
          fit={FIT.hero}
          className="rounded-[14px] border border-line-subtle"
        >
          <ChatScreen />
        </ScreenFrame>
      </div>
    </section>
  )
}

function ChevronRight() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      className="shrink-0 text-quiet-strong"
    >
      <path
        d="M6 3.5L10.5 8L6 12.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
