import { cn } from "@evie/ui/lib/utils"

/**
 * macOS window controls, drawn rather than borrowed.
 *
 * The desktop shell hides the native titlebar so the rail can start at the top
 * of the window, which means these have to be real controls, not decoration --
 * hence `onClose`/`onMinimize`/`onZoom` rather than three divs. In the browser
 * there is no window to close, so `apps/web` renders this only inside Electron.
 *
 * The three colours are system chrome and stay fixed in both themes. They are
 * the one place in Evie where a colour is not a token.
 */

export interface TrafficLightsProps {
  readonly onClose?: () => void
  readonly onMinimize?: () => void
  readonly onZoom?: () => void
  readonly className?: string
}

const LIGHTS = [
  { key: "close", label: "Close window", color: "bg-traffic-close" },
  { key: "minimize", label: "Minimize window", color: "bg-traffic-minimize" },
  { key: "zoom", label: "Zoom window", color: "bg-traffic-zoom" },
] as const

export function TrafficLights({ onClose, onMinimize, onZoom, className }: TrafficLightsProps) {
  const handlers = { close: onClose, minimize: onMinimize, zoom: onZoom }
  return (
    <div className={cn("flex items-center gap-2", className)}>
      {LIGHTS.map((light) => (
        <button
          key={light.key}
          type="button"
          aria-label={light.label}
          onClick={handlers[light.key]}
          className={cn(
            "size-3 shrink-0 rounded-full",
            "focus-visible:ring-2 focus-visible:ring-focus/50 focus-visible:outline-none",
            light.color,
          )}
        />
      ))}
    </div>
  )
}
