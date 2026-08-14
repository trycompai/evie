import type { BrandId } from "@evie/ui/components/brand-logo"
import { FilterIcon } from "@evie/ui/components/icon"
import { PluginRow, PluginSection } from "@evie/ui/components/plugin-row"
import { SearchField } from "@evie/ui/components/search-field"
import { ChatScreen } from "~/components/screens/chat-screen"
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "~/components/screens/screen-frame"
import { StaticDialog, StaticSegmented } from "~/components/screens/static-controls"

/**
 * 07 Plugins, as a still: the catalog open over the thread it was opened from.
 *
 * The rows are `PluginRow` with `BrandTile` behind them, so every logo here is
 * the vendor's own mark at the vendor's own colours -- the same file the app
 * ships, not a re-traced copy.
 */

interface Listing {
  readonly brand: BrandId
  readonly name: string
  readonly blurb: string
}

const FEATURED: readonly Listing[] = [
  { brand: "gmail", name: "Gmail", blurb: "Read, draft, and send from your inbox." },
  {
    brand: "google-calendar",
    name: "Google Calendar",
    blurb: "See your day and defend your calendar.",
  },
  {
    brand: "google-drive",
    name: "Google Drive",
    blurb: "Find, read, and write your team's docs.",
  },
  { brand: "notion", name: "Notion", blurb: "Keep specs and notes in sync as work moves." },
]

const COMMUNICATION: readonly Listing[] = [
  { brand: "slack", name: "Slack", blurb: "Watch channels and reply in your voice." },
  { brand: "linear", name: "Linear", blurb: "Open, update, and close issues as work lands." },
  {
    brand: "hubspot",
    name: "HubSpot",
    blurb: "Keep deals and contacts current without asking.",
  },
  { brand: "github", name: "GitHub", blurb: "Review pull requests and chase stale branches." },
]

export function PluginsScreen() {
  return (
    <div className="relative" style={{ width: SCREEN_WIDTH, height: SCREEN_HEIGHT }}>
      <ChatScreen />

      <StaticDialog title="Plugins" width={1040}>
        <div className="flex shrink-0 items-center gap-3 px-7 py-5">
          <StaticSegmented options={["Marketplace", "Yours"]} />
          <div className="min-w-0 flex-1" />
          <span className="flex size-9 shrink-0 items-center justify-center text-fg-muted">
            <FilterIcon />
          </span>
          <SearchField
            placeholder="Search plugins"
            iconSize={15}
            readOnly
            tabIndex={-1}
            containerClassName="w-[300px] shrink-0 bg-raised-strong"
          />
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-7 overflow-hidden px-7 pt-1 pb-7">
          <PluginSection title="Featured" more={2}>
            {FEATURED.map((listing) => (
              <PluginRow key={listing.brand} {...listing} />
            ))}
          </PluginSection>
          <PluginSection title="Communication" more={15}>
            {COMMUNICATION.map((listing) => (
              <PluginRow key={listing.brand} {...listing} />
            ))}
          </PluginSection>
        </div>
      </StaticDialog>
    </div>
  )
}
