import Link from "next/link"
import { EvieWordmark, GitHubIcon } from "~/components/site/brand"
import { CTA, GITHUB_STARS, GITHUB_URL, NAV_LINKS } from "~/content/site"

/**
 * The masthead.
 *
 * Three fixed-width columns rather than a space-between of three unequal
 * blocks: the links stay optically centred in the window whether the star count
 * reads 4.2k or 12.4k.
 */

export function SiteNav() {
  return (
    <header className="flex h-[72px] w-full shrink-0 items-center justify-between bg-surface px-10 select-none">
      <div className="flex shrink-0 items-center desktop:w-[200px]">
        <Link href="/" aria-label="Evie home">
          <EvieWordmark />
        </Link>
      </div>

      <nav aria-label="Primary" className="hidden items-center gap-7 desktop:flex">
        {NAV_LINKS.map((link) => (
          <a
            key={link.label}
            href={link.href}
            className="text-[14px] text-fg-muted transition-colors hover:text-fg"
          >
            {link.label}
          </a>
        ))}
      </nav>

      <div className="flex shrink-0 items-center justify-end gap-2.5 desktop:w-[200px]">
        <a
          href={GITHUB_URL}
          className="flex h-[34px] items-center gap-[7px] rounded-small border border-line-subtle px-3 transition-colors hover:border-line-strong"
        >
          <GitHubIcon />
          <span className="text-[13px] font-medium text-fg">{GITHUB_STARS}</span>
          <span className="sr-only">stars on GitHub</span>
        </a>
        <a
          href="#download"
          className="flex h-[34px] items-center rounded-small bg-contrast px-4 text-[13px] font-medium text-on-contrast transition-opacity hover:opacity-90"
        >
          {CTA.navDownload}
        </a>
      </div>
    </header>
  )
}
