import type * as React from "react"
import { TrafficLights } from "@evie/ui/components/traffic-lights"
import { windowControls } from "~/lib/desktop.ts"

/**
 * Window controls.
 *
 * Inside the shell these are the **real macOS buttons**, moved to where the
 * design puts them. Outside it — the gallery, checking a screen against its
 * Paper artboard — they are drawn, because there is no window to borrow from.
 *
 * Drawn controls were the obvious first move and the wrong one. Three coloured
 * circles can be pixel-perfect at rest and still feel wrong the moment you use
 * them, because everything that makes these buttons feel like macOS is
 * behaviour the system owns:
 *
 * - they dim to grey when the window is not frontmost, and brighten on return;
 * - the ⨯ − + glyphs appear when the pointer enters the *group*, not the button;
 * - green is full-screen, and Option-green is fit-to-content — a maximize call
 *   is simply the wrong verb, which is what our drawn version did;
 * - Reduce Transparency, Differentiate Without Color, and every future
 *   appearance setting repaint them, and a hard-coded hex does not.
 *
 * None of that is reachable from a `<button>`. So the app renders a spacer of
 * exactly the right size, keeping the Paper layout intact, and tells the shell
 * to put the system's buttons in that spot.
 */

const controls = windowControls

/** 3 × 12px buttons + 2 × 8px gaps — the macOS metric the design already uses. */
const GROUP_WIDTH = 52
const GROUP_HEIGHT = 12

export function WindowControls({ className }: { readonly className?: string }) {
  if (controls === null) return <TrafficLights className={className} />

  /*
   * A ref callback, not an effect: the position is a fact about layout, and
   * layout is settled exactly when the node is attached. Returning the cleanup
   * hands the buttons back to the system default when the screen unmounts, so
   * the next screen's measurement is never inherited by a screen that has none.
   */
  const measure = (node: HTMLDivElement | null) => {
    if (node === null) return
    const rect = node.getBoundingClientRect()
    controls.setButtonPosition({ x: rect.left, y: rect.top })
    return () => controls.setButtonPosition(null)
  }

  return (
    <div
      ref={measure}
      aria-hidden
      className={className}
      // Reserves the space the buttons occupy so the rest of the row lays out
      // exactly as it does in the browser build and in Paper.
      style={
        {
          width: GROUP_WIDTH,
          height: GROUP_HEIGHT,
          flexShrink: 0,
          WebkitAppRegion: "no-drag",
        } as React.CSSProperties
      }
    />
  )
}

/**
 * A strip along the top of a screen that has no rail, so the window can still
 * be dragged by it.
 *
 * The shell hides the native titlebar to give the rail the top of the window,
 * which means any screen without a rail -- the launch screen, both onboarding
 * steps -- has nothing to drag and the window is stuck where it opened.
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
