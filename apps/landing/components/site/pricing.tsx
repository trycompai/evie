import { cn } from "@evie/ui/lib/utils"
import {
  CheckItem,
  Column,
  MonoLabel,
  Section,
  SectionHeading,
  SectionLede,
} from "~/components/site/primitives"
import { PRICING } from "~/content/site"

/**
 * Two cards where a pricing table would be.
 *
 * There is one product and it is free, so the second card is not a tier: it is
 * the bill you already pay, named honestly. `$0` and `Your key` are set at the
 * same size for that reason -- they are two halves of one answer.
 */

export function Pricing() {
  return (
    <Section ground="muted" topLine className="py-20 tablet:py-28">
      <MonoLabel>{PRICING.eyebrow}</MonoLabel>
      <SectionHeading className="pt-3.5 text-center">{PRICING.heading}</SectionHeading>
      <SectionLede className="w-[560px] max-w-full pt-3.5 text-center">{PRICING.lede}</SectionLede>

      <Column className="flex-row flex-wrap justify-center gap-6 pt-12 tablet:pt-13">
        {PRICING.plans.map((plan) => (
          <article
            key={plan.label}
            className="flex w-[588px] max-w-full shrink-0 flex-col rounded-[14px] border border-line-subtle bg-surface p-8"
          >
            <h3 className="text-[15px] font-medium text-fg select-none">{plan.label}</h3>

            <p className="flex items-baseline gap-2 pt-[18px] select-none">
              <span className="text-[44px] leading-[48px] font-heading tracking-[-0.05em] text-fg tablet:text-[56px] tablet:leading-[60px]">
                {plan.price}
              </span>
              {"unit" in plan ? <span className="text-[15px] text-quiet">{plan.unit}</span> : null}
            </p>

            <p className="pt-2.5 text-[15px] leading-[23px] text-balance text-fg-muted">
              {plan.blurb}
            </p>

            <a
              href="#download"
              className={cn(
                "mt-6 flex h-11 items-center justify-center rounded-default text-[14px] font-medium select-none",
                "focus-visible:ring-2 focus-visible:ring-focus/50 focus-visible:outline-none",
                plan.action.variant === "primary"
                  ? "bg-contrast text-on-contrast transition-opacity hover:opacity-90"
                  : "border border-line-strong bg-surface text-fg transition-colors hover:bg-raised",
              )}
            >
              {plan.action.label}
            </a>

            <div className="mt-7 flex flex-col gap-3">
              <MonoLabel className="pb-0.5">{plan.listLabel}</MonoLabel>
              <ul className="flex flex-col gap-3">
                {plan.items.map((item) => (
                  <CheckItem key={item}>{item}</CheckItem>
                ))}
              </ul>
            </div>
          </article>
        ))}
      </Column>
    </Section>
  )
}
