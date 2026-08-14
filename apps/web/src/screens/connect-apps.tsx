import { useState } from "react"
import { ActionButton } from "@evie/ui/components/action-button"
import { BrandTile, type BrandId } from "@evie/ui/components/brand-logo"
import { SearchField } from "@evie/ui/components/search-field"
import { TrafficLights } from "@evie/ui/components/traffic-lights"
import { cn } from "@evie/ui/lib/utils"

/**
 * Onboarding step: pick the services Evie should connect to.
 *
 * The screen owns nothing but the search query. Which apps are selected is the
 * caller's state -- onboarding carries it forward to the next step -- so tiles
 * report toggles up rather than keeping their own checked flag.
 */

const APPS: readonly { readonly id: BrandId; readonly name: string }[] = [
  { id: "google-workspace", name: "Workspace" },
  { id: "slack", name: "Slack" },
  { id: "notion", name: "Notion" },
  { id: "salesforce", name: "Salesforce" },
  { id: "microsoft-365", name: "Microsoft 365" },
  { id: "linkedin", name: "LinkedIn" },
  { id: "zoom", name: "Zoom" },
  { id: "github", name: "GitHub" },
  { id: "jira", name: "Jira" },
  { id: "linear", name: "Linear" },
  { id: "hubspot", name: "HubSpot" },
  { id: "stripe", name: "Stripe" },
]

export interface ConnectAppsScreenProps {
  readonly selected: ReadonlySet<string>
  readonly onToggle: (id: string) => void
  readonly onNext: () => void
  readonly onBack: () => void
  /** The Electron shell draws window controls; the browser has no window. */
  readonly desktop?: boolean
}

export function ConnectAppsScreen({
  selected,
  onToggle,
  onNext,
  onBack,
  desktop = false,
}: ConnectAppsScreenProps) {
  const [query, setQuery] = useState("")
  const q = query.trim().toLowerCase()
  const visible = q ? APPS.filter((app) => app.name.toLowerCase().includes(q)) : APPS

  return (
    <div className="relative flex h-full flex-col items-center justify-center gap-9 overflow-hidden bg-surface px-10">
      {desktop && <TrafficLights className="absolute top-5 left-5" />}

      <h1 className="text-page-title tracking-section text-fg">What do you use every day?</h1>

      <SearchField
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        aria-label="Search apps"
        iconSize={16}
        containerClassName="h-[46px] w-[620px] gap-2.5 rounded-pill px-4"
        className="text-body"
      />

      <div role="group" aria-label="Apps" className="grid w-[620px] grid-cols-3 gap-3">
        {visible.map((app) => {
          const isSelected = selected.has(app.id)
          return (
            <button
              key={app.id}
              type="button"
              aria-pressed={isSelected}
              onClick={() => onToggle(app.id)}
              className={cn(
                "flex h-16 min-w-0 items-center gap-3 rounded-[12px] border bg-raised px-3.5",
                "focus-visible:ring-2 focus-visible:ring-focus/50 focus-visible:outline-none",
                isSelected ? "border-fg" : "border-transparent",
              )}
            >
              <BrandTile brand={app.id} size={34} />
              <span className="min-w-0 flex-1 truncate text-left text-body leading-[22px] text-fg">
                {app.name}
              </span>
            </button>
          )
        })}
        {visible.length === 0 && (
          <p className="col-span-3 py-6 text-center text-body text-fg-muted">
            Nothing matches &ldquo;{query.trim()}&rdquo;
          </p>
        )}
      </div>

      <div className="flex w-[340px] flex-col items-center gap-2.5">
        <ActionButton variant="primary" block onClick={onNext}>
          Next
        </ActionButton>
        <ActionButton variant="secondary" block onClick={onBack}>
          Back
        </ActionButton>
      </div>
    </div>
  )
}
