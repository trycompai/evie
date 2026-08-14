import { cn } from "@evie/ui/lib/utils"
import { Column, MonoLabel, Section } from "~/components/site/primitives"
import { REMOTE } from "~/content/site"

/**
 * The one inverted band on the page.
 *
 * It carries the claim the rest of the page cannot make in passing -- that
 * there is no server but yours -- and the ink ground is what makes it read as a
 * statement rather than a fourth feature. The live dot is the same indicator
 * the app puts under your name in the rail.
 */

export function RemoteBand() {
  return (
    <Section ground="contrast" className="pt-20 pb-20 tablet:pt-28 tablet:pb-26">
      <Column className="flex-row flex-wrap items-end gap-10 desktop:gap-20">
        <div className="flex w-[620px] max-w-full shrink-0 flex-col gap-[18px]">
          <span className="flex h-[26px] w-fit items-center gap-2 rounded-pill border border-line-on-contrast pr-2.5 pl-2 select-none">
            <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-live" />
            <span className="font-mono text-[11px] leading-none font-medium tracking-[0.06em] text-on-contrast-muted">
              {REMOTE.chip}
            </span>
          </span>
          <h2 className="text-[34px] leading-[40px] font-heading tracking-section text-balance text-on-contrast tablet:text-[46px] tablet:leading-[52px]">
            {REMOTE.heading}
          </h2>
        </div>
        <p className="w-[440px] max-w-full pb-1.5 text-[17px] leading-[27px] text-balance text-on-contrast-muted">
          {REMOTE.lede}
        </p>
      </Column>

      <Column className="flex-row flex-wrap gap-y-10 pt-14 desktop:gap-y-0 desktop:pt-[72px]">
        {REMOTE.modes.map((mode, index) => (
          <div
            key={mode.label}
            className={cn(
              "flex w-[400px] max-w-full shrink-0 flex-col gap-2.5 border-t border-line-on-contrast pt-[26px]",
              // The rule runs unbroken across the column, so the gutters are
              // padding inside each cell rather than a gap between them. Once
              // the cells stack there is no gutter to make.
              index === 0
                ? "desktop:pr-8"
                : index === REMOTE.modes.length - 1
                  ? "desktop:pl-8"
                  : "desktop:px-8",
            )}
          >
            <MonoLabel className="text-quiet-strong">{mode.label}</MonoLabel>
            <h3 className="text-[19px] font-medium tracking-subsection text-balance text-on-contrast">
              {mode.title}
            </h3>
            <p className="text-[15px] leading-[23px] text-on-contrast-muted">{mode.body}</p>
          </div>
        ))}
      </Column>
    </Section>
  )
}
