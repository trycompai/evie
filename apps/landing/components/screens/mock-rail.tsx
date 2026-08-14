import { AccountRow, PluginsRailItem, Rail, RailEmpty } from "@evie/ui/components/rail"
import { SearchField } from "@evie/ui/components/search-field"
import { ThreadRow } from "@evie/ui/components/thread-row"
import { TrafficLights } from "@evie/ui/components/traffic-lights"
import type { BotShape, BotTone } from "@evie/ui/components/bot-mark"

/**
 * The rail, as the marketing screens show it.
 *
 * `apps/web` wires this same `Rail` to the fleet; here the three conversations
 * are fixed, because a screenshot is a moment. Every part is the product's own
 * component, so the rail on this page cannot drift from the rail in the app.
 * Handlers are omitted rather than stubbed -- these render on the server and
 * the frame around them is inert.
 */

interface MockThread {
  readonly name: string
  readonly time: string
  readonly preview: string
  readonly shape: BotShape
  readonly tone: BotTone
}

const THREADS: readonly MockThread[] = [
  {
    name: "Chief of Staff",
    time: "3:53 PM",
    preview: "What makes you fast is not another dashboard.",
    shape: "circle",
    tone: 1,
  },
  {
    name: "Inbox Triage",
    time: "11:20 AM",
    preview: "Cleared 14 threads.",
    shape: "squircle",
    tone: 2,
  },
  {
    name: "Recruiting",
    time: "Yesterday",
    preview: "Two candidates waiting.",
    shape: "hexagon",
    tone: 3,
  },
]

export interface MockRailProps {
  /** The new-bot screen's rail: no conversations yet, the draft row selected. */
  readonly composing?: boolean
}

export function MockRail({ composing = false }: MockRailProps) {
  return (
    <Rail
      windowControls={<TrafficLights />}
      search={<SearchField readOnly tabIndex={-1} />}
      footer={
        <>
          <PluginsRailItem />
          <AccountRow name="Lewis Carhart" location="This Mac" />
        </>
      }
    >
      {composing ? (
        <>
          <ThreadRow name="Create your first bot" time="" preview="" active />
          <RailEmpty />
        </>
      ) : (
        THREADS.map((thread, index) => (
          <ThreadRow
            key={thread.name}
            name={thread.name}
            time={thread.time}
            preview={thread.preview}
            shape={thread.shape}
            tone={thread.tone}
            active={index === 0}
          />
        ))
      )}
    </Rail>
  )
}
