import { Section, SectionHeading } from "~/components/site/primitives"
import { FAQ } from "~/content/site"

/**
 * The accordion, with no JavaScript in it.
 *
 * `<details>` opens and closes on its own, keyboard included, and the chevron
 * is rotated by the `open` attribute rather than by state. The first question
 * ships open, as the design draws it, so the section starts with an answer
 * rather than six closed doors.
 */

export function Faq() {
  return (
    <Section id="docs" topLine className="py-20 tablet:py-28">
      <div className="flex w-full max-w-[1200px] flex-wrap items-start justify-center gap-12 desktop:gap-20">
        <div className="flex w-[380px] max-w-full shrink-0 flex-col gap-3.5">
          <SectionHeading>{FAQ.heading}</SectionHeading>
          <p className="text-[16px] leading-[25px] text-balance text-fg-muted">{FAQ.lede}</p>
        </div>

        <div className="flex w-[740px] max-w-full shrink-0 flex-col">
          {FAQ.items.map((item, index) => (
            <details
              key={item.question}
              open={index === 0}
              className="group border-b border-line-subtle open:[&>summary]:pb-3.5"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-[21px] select-none focus-visible:outline-none [&::-webkit-details-marker]:hidden">
                <span className="text-[17px] font-medium tracking-[-0.01em] text-balance text-fg">
                  {item.question}
                </span>
                <Chevron />
              </summary>
              <p className="w-[640px] max-w-full pb-6 text-[16px] leading-[26px] text-fg-muted">
                {item.answer}
              </p>
            </details>
          ))}
        </div>
      </div>
    </Section>
  )
}

function Chevron() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      className="shrink-0 text-quiet transition-transform group-open:rotate-180"
    >
      <path
        d="M3.5 6L8 10.5L12.5 6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
