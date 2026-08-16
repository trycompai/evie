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
 * Every section is a server component. The only interaction on the page is the
 * FAQ, and `<details>` already does that; the client bundle is two files, both
 * of which pass their children through as a slot so nothing under them leaves
 * the server -- `ThemeProvider`, which has to read the OS theme before first
 * paint, and `GazeArea`, which makes the Evie marks in a band watch the cursor.
 *
 * The product screenshots are the app's own components rendered and scaled, so
 * this page is one build away from the truth rather than one screenshot
 * session. Which is also why the marks in them are alive: they are real
 * `BotMark`s, and the same file that makes them follow the cursor in the app's
 * rail finds them here.
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
