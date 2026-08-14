import { EvieMark } from "~/components/site/brand"
import { ActionPair, Section } from "~/components/site/primitives"
import { CLOSING } from "~/content/site"

/**
 * The last ask.
 *
 * The line under it is the product's own tagline, the one the app shows while
 * it opens -- so the page ends on the sentence the software starts with.
 */

export function ClosingCta() {
  return (
    <Section id="download" ground="muted" topLine className="pt-24 pb-24 tablet:pt-30 tablet:pb-32">
      <EvieMark size={44} className="size-9 tablet:size-11" />
      <h2 className="pt-6 text-center text-[38px] leading-[44px] font-heading tracking-[-0.05em] text-balance text-fg tablet:pt-[26px] tablet:text-[56px] tablet:leading-[62px]">
        {CLOSING.heading}
      </h2>
      <p className="w-[560px] max-w-full pt-3.5 text-center text-lede text-balance text-fg-muted">
        {CLOSING.tagline}
      </p>
      <ActionPair className="pt-8" />
    </Section>
  )
}
