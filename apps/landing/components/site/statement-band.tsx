import { Column, Section, SectionHeading } from "~/components/site/primitives"
import { STATEMENT } from "~/content/site"

/**
 * The claim, stated once.
 *
 * Heading left, argument right, both top-aligned: the asymmetry is what stops
 * the page reading as a stack of centred cards, and it gives the sentence room
 * to be short.
 */

export function StatementBand() {
  return (
    <Section ground="muted" topLine bottomLine className="py-20 tablet:py-28">
      <Column className="flex-row flex-wrap items-start gap-10 desktop:gap-20">
        <SectionHeading className="w-[560px] max-w-full shrink-0">
          {STATEMENT.heading}
        </SectionHeading>
        <div className="flex w-[480px] max-w-full flex-col gap-[18px] pt-1.5">
          {STATEMENT.paragraphs.map((paragraph) => (
            <p key={paragraph} className="text-lede text-fg-muted">
              {paragraph}
            </p>
          ))}
        </div>
      </Column>
    </Section>
  )
}
