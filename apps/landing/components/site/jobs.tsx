import { NewBotScreen } from "~/components/screens/new-bot-screen"
import { FIT, ScreenFrame } from "~/components/screens/screen-frame"
import { Section, SectionHeading, SectionLede } from "~/components/site/primitives"
import { JOBS } from "~/content/site"

/**
 * The one screenshot on the page shown at 1:1.
 *
 * Everything else is a window scaled down; this is the picker at actual size,
 * cropped to the six faces and the name field. After four reduced screens the
 * change of scale is what makes the detail read as a detail.
 */

export function Jobs() {
  return (
    <Section alive className="py-20 tablet:py-28">
      <div className="flex w-full max-w-[1200px] flex-wrap items-center justify-center gap-12 desktop:gap-25">
        <div className="flex w-[480px] max-w-full shrink-0 flex-col gap-5">
          <SectionHeading>{JOBS.heading}</SectionHeading>
          <SectionLede>{JOBS.body}</SectionLede>
          <ul className="flex w-[460px] max-w-full flex-wrap gap-2 pt-2 select-none">
            {JOBS.chips.map((chip) => (
              <li
                key={chip}
                className="flex h-8 items-center rounded-pill border border-line-subtle bg-surface-muted px-[13px] text-compact text-fg"
              >
                {chip}
              </li>
            ))}
          </ul>
        </div>

        <ScreenFrame
          width={620}
          height={420}
          scale={1}
          offsetX={-550}
          offsetY={-186}
          fit={FIT.inline}
          className="rounded-[14px] border border-line-subtle"
        >
          <NewBotScreen />
        </ScreenFrame>
      </div>
    </Section>
  )
}
