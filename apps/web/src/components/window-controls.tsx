import type * as React from "react"
import { TrafficLights } from "@evie/ui/components/traffic-lights"
import { windowControls } from "~/lib/desktop.ts"

/**
 * The drawn traffic lights, wired to the shell.
 *
 * Every screen that draws window controls goes through this, because the bug it
 * exists to prevent is the one that already happened: `TrafficLights` takes
 * optional handlers, three of the four screens rendering it passed none, and
 * three buttons that look like window controls and do nothing is worse than no
 * buttons at all.
 *
 * The design-system component stays dumb -- it knows how the buttons look, not
 * what a window is. This is the one place in the app that knows both.
 *
 * Handlers are undefined in a browser, which is deliberate rather than
 * defensive: the gallery renders these screens with `desktop` on to check the
 * layout against Paper, and it has no shell underneath it.
 */

export function WindowControls({ className }: { readonly className?: string }) {
  return (
    <TrafficLights
      className={className}
      onClose={windowControls?.close}
      onMinimize={windowControls?.minimize}
      onZoom={windowControls?.zoom}
    />
  )
}

/**
 * A strip along the top of a screen that has no rail, so the window can still
 * be dragged by it.
 *
 * The shell hides the native titlebar to give the rail the top of the window,
 * which means any screen without a rail -- the launch screen, both onboarding
 * steps -- has nothing to drag and the window is stuck where it opened. Sized
 * to clear the traffic lights, which sit at `top-5 left-5` and opt out of
 * dragging themselves.
 */
export function DragRegion() {
  return (
    <div
      aria-hidden
      className="absolute inset-x-0 top-0 h-14"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    />
  )
}
