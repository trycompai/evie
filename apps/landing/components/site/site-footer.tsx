import { EvieMark, PoweredByEve } from "~/components/site/brand"
import { Column, MonoLabel } from "~/components/site/primitives"
import { FOOTER } from "~/content/site"

/**
 * The footer, and the second half of the eve attribution.
 *
 * Four link columns at a fixed 170px so their labels form four clean lanes
 * whatever the longest link in each turns out to be.
 */

export function SiteFooter() {
  return (
    <footer className="flex w-full shrink-0 flex-col items-center gap-12 border-t border-line-subtle bg-surface px-10 pt-16 pb-10">
      <Column className="flex-row flex-wrap items-start justify-between gap-15">
        <div className="flex w-[300px] max-w-full shrink-0 flex-col gap-3.5">
          <span className="flex items-center gap-[9px]">
            <EvieMark size={20} />
            <span className="text-[16px] leading-none font-medium tracking-[-0.03em] text-fg">
              Evie
            </span>
          </span>
          <p className="text-compact leading-[22px] text-fg-muted">{FOOTER.blurb}</p>
        </div>

        {FOOTER.columns.map((column) => (
          <nav
            key={column.label}
            aria-label={column.label}
            className="flex w-[170px] shrink-0 flex-col gap-3 select-none"
          >
            <MonoLabel className="pb-0.5">{column.label}</MonoLabel>
            {column.links.map((link) => (
              <a
                key={link}
                href="#"
                className="text-compact text-fg-muted transition-colors hover:text-fg"
              >
                {link}
              </a>
            ))}
          </nav>
        ))}
      </Column>

      <Column className="flex-row flex-wrap items-center justify-between gap-4 border-t border-line-subtle pt-7 select-none">
        <span className="font-mono text-[12px] text-quiet">{FOOTER.colophon}</span>
        <PoweredByEve width={42} size="text-[12px] font-mono" />
      </Column>
    </footer>
  )
}
