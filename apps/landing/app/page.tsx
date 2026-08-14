import { ClosingCta } from "~/components/site/closing-cta"
import { Faq } from "~/components/site/faq"
import { Features } from "~/components/site/features"
import { Hero } from "~/components/site/hero"
import { Jobs } from "~/components/site/jobs"
import { Pricing } from "~/components/site/pricing"
import { RemoteBand } from "~/components/site/remote-band"
import { SiteFooter } from "~/components/site/site-footer"
import { SiteNav } from "~/components/site/site-nav"
import { StatementBand } from "~/components/site/statement-band"

/**
 * tryevie.ai.
 *
 * Every section is a server component and the page ships no client JavaScript:
 * the only interaction on it is the FAQ, and `<details>` already does that. The
 * product screenshots are the app's own components rendered and scaled, so this
 * page is one build away from the truth rather than one screenshot session.
 */

export default function Page() {
  return (
    <main className="flex w-full flex-col">
      <SiteNav />
      <Hero />
      <StatementBand />
      <Features />
      <RemoteBand />
      <Jobs />
      <Pricing />
      <Faq />
      <ClosingCta />
      <SiteFooter />
    </main>
  )
}
