import { cn } from "@evie/ui/lib/utils"

/**
 * A window onto a product screen.
 *
 * Every screenshot on this page is the real app rendered at its real size and
 * then scaled, which is what the Paper file does with a clone of the artboard.
 * So this is that: a fixed viewport, and inside it a 1440x900 screen scaled by
 * `scale` and slid by `offset` when the design crops to a detail. Nothing is a
 * PNG, so a token change lands here at the same commit it lands in the app.
 *
 * `scale` over `zoom`: `transform` composites on the GPU and never reflows the
 * page, and the frame's own box is authored, not inferred.
 *
 * **Fitting narrower viewports.** The design has one artboard, 1440 wide. Below
 * that the frame cannot keep its authored width, and cropping a screenshot at
 * the viewport edge looks like a bug. So the frame and its contents share a
 * `--frame-fit` multiplier -- shrink both and the picture stays whole, just
 * smaller. Callers set it per breakpoint (see `FIT` maps below), because what
 * counts as "fits" depends on how wide that particular frame is. CSS does the
 * arithmetic; there is no measuring and no JavaScript.
 *
 * The screens are decorative. They contain real buttons and inputs, so the
 * whole frame is `aria-hidden` and `inert` -- a marketing screenshot must not
 * put twelve stops in a keyboard user's path.
 */

/** The artboard every screen is drawn at, matching the app's desktop window. */
export const SCREEN_WIDTH = 1440
export const SCREEN_HEIGHT = 900

/**
 * Per-frame fit ladders.
 *
 * Each step is (available width / frame width) at that breakpoint, where
 * available is the viewport minus the section's 40px gutters. Rounded up a
 * hair: a frame one pixel wider than its box crops invisibly, one pixel
 * narrower shows a seam of ground colour.
 */
export const FIT = {
  /** 1152 wide: the hero. Fits whole from 1232px up. */
  hero: "[--frame-fit:0.28] min-[480px]:[--frame-fit:0.35] min-[640px]:[--frame-fit:0.49] min-[768px]:[--frame-fit:0.6] min-[1024px]:[--frame-fit:0.82] min-[1232px]:[--frame-fit:1]",
  /** 588 wide: the two feature cards, which stack before they shrink. */
  card: "[--frame-fit:0.53] min-[480px]:[--frame-fit:0.68] min-[560px]:[--frame-fit:0.81] min-[668px]:[--frame-fit:1]",
  /** 758 wide: the detail crop in the wide card. */
  detail:
    "[--frame-fit:0.41] min-[480px]:[--frame-fit:0.53] min-[640px]:[--frame-fit:0.74] min-[838px]:[--frame-fit:1]",
  /** 620 wide: the 1:1 crop beside the job chips. */
  inline:
    "[--frame-fit:0.5] min-[480px]:[--frame-fit:0.65] min-[560px]:[--frame-fit:0.77] min-[700px]:[--frame-fit:1]",
} as const

export interface ScreenFrameProps {
  readonly width: number
  readonly height: number
  readonly scale: number
  /** Where the scaled screen's top-left sits, for the cropped details. */
  readonly offsetX?: number
  readonly offsetY?: number
  /** One of `FIT`. Omit only for a frame that is always narrower than the page. */
  readonly fit?: string
  readonly className?: string
  readonly children: React.ReactNode
}

export function ScreenFrame({
  width,
  height,
  scale,
  offsetX = 0,
  offsetY = 0,
  fit,
  className,
  children,
}: ScreenFrameProps) {
  return (
    <div
      aria-hidden
      inert
      className={cn(
        "screen-frame dark relative shrink-0 overflow-hidden bg-surface select-none",
        fit,
        className,
      )}
      style={
        {
          "--frame-w": `${width}px`,
          "--frame-h": `${height}px`,
          "--frame-scale": scale,
          "--frame-x": `${offsetX}px`,
          "--frame-y": `${offsetY}px`,
        } as React.CSSProperties
      }
    >
      <div className="screen-frame-inner">{children}</div>
    </div>
  )
}

/** The screen itself: the app's window, at window size. */
export function Screen({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="flex bg-surface" style={{ width: SCREEN_WIDTH, height: SCREEN_HEIGHT }}>
      {children}
    </div>
  )
}
