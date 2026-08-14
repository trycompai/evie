import { useState } from "react"
import type { PluginListing } from "@evie/contracts/rpc"
import type { BrandId } from "@evie/ui/components/brand-logo"
import { Dialog, DialogBody, DialogHeader, DialogSurface, DialogToolbar } from "@evie/ui/components/dialog"
import { FilterIcon } from "@evie/ui/components/icon"
import { PluginRow, PluginSection } from "@evie/ui/components/plugin-row"
import { SearchField } from "@evie/ui/components/search-field"
import { Segmented } from "@evie/ui/components/segmented"

/**
 * The connection catalog.
 *
 * Two views of the same list: everything available, and the ones this bot
 * already has. "Yours" is not a different screen -- it is the same rows with
 * the same Add/Added control, so removing something is where you found it.
 *
 * Sections collapse to the first four rows. A catalog that opens at full length
 * is a catalog nobody reads to the bottom of, and "Show 15 more" is a smaller
 * promise than a scrollbar.
 */

const COLLAPSED = 4

const TABS = [
  { value: "marketplace" as const, label: "Marketplace" },
  { value: "yours" as const, label: "Yours" },
]

export interface PluginsDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly listings: readonly PluginListing[]
  /** Plugin ids already connected on the bot being edited. */
  readonly installed: ReadonlySet<string>
  readonly onAdd: (pluginId: string) => void
  readonly onRemove: (pluginId: string) => void
}

export function PluginsDialog({
  open,
  onOpenChange,
  listings,
  installed,
  onAdd,
  onRemove,
}: PluginsDialogProps) {
  const [tab, setTab] = useState<"marketplace" | "yours">("marketplace")
  const [query, setQuery] = useState("")
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())

  const needle = query.trim().toLowerCase()
  const pool = tab === "yours" ? listings.filter((l) => installed.has(l.id)) : listings
  const matching = needle
    ? pool.filter((l) => `${l.name} ${l.blurb} ${l.category}`.toLowerCase().includes(needle))
    : pool

  // Featured is a section, not a flag on a row: it is the only one that mixes
  // categories, so it has to be built before the rest are grouped.
  const featured = matching.filter((l) => l.featured)
  const rest = matching.filter((l) => !l.featured)
  const byCategory = new Map<string, PluginListing[]>()
  for (const listing of rest) {
    const group = byCategory.get(listing.category)
    if (group) group.push(listing)
    else byCategory.set(listing.category, [listing])
  }

  const sections: Array<[string, readonly PluginListing[]]> = [
    ...(featured.length > 0 ? ([["Featured", featured]] as Array<[string, readonly PluginListing[]]>) : []),
    ...[...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b)),
  ]

  const toggleSection = (title: string) =>
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(title)) next.delete(title)
      else next.add(title)
      return next
    })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogSurface width={1040} aria-label="Plugins">
        <DialogHeader title="Plugins" />

        <DialogToolbar>
          <Segmented options={TABS} value={tab} onChange={setTab} label="Plugin view" />
          <div className="min-w-0 flex-1" />
          <button
            type="button"
            aria-label="Filter"
            className="flex size-9 shrink-0 items-center justify-center text-fg-muted hover:text-fg"
          >
            <FilterIcon />
          </button>
          <SearchField
            placeholder="Search plugins"
            iconSize={15}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            containerClassName="w-[300px] shrink-0 bg-raised-strong"
          />
        </DialogToolbar>

        <DialogBody>
          {sections.length === 0 ? (
            <p className="text-compact text-fg-muted">
              {tab === "yours" ? "This bot has no plugins yet." : "Nothing matches that."}
            </p>
          ) : (
            sections.map(([title, items]) => {
              const open = expanded.has(title) || needle.length > 0
              const shown = open ? items : items.slice(0, COLLAPSED)
              return (
                <PluginSection
                  key={title}
                  title={title}
                  more={open ? 0 : items.length - shown.length}
                  onShowMore={() => toggleSection(title)}
                >
                  {shown.map((listing) => (
                    <PluginRow
                      key={listing.id}
                      brand={listing.id as BrandId}
                      name={listing.name}
                      blurb={listing.blurb}
                      installed={installed.has(listing.id)}
                      onAdd={() => onAdd(listing.id)}
                      onRemove={() => onRemove(listing.id)}
                    />
                  ))}
                </PluginSection>
              )
            })
          )}
        </DialogBody>
      </DialogSurface>
    </Dialog>
  )
}
