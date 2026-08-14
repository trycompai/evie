import { cn } from "@evie/ui/lib/utils"

/**
 * The icon set from the Evie design file.
 *
 * These are not Lucide. The design draws its chrome at specific stroke widths
 * against specific optical sizes -- a 1.3px stroke on a 14px glyph and 1.6px on
 * an 18px one -- and swapping in a library set changes the weight of every row
 * in the rail. Lucide stays available from `@evie/ui` for anything the design
 * has not drawn; when the design draws it, it lives here.
 *
 * Colour comes from `currentColor` so an icon inherits its parent's text class
 * rather than naming a token twice. The design file hardcodes a `var(--…)` fill
 * per instance because Paper artboards have no cascade; that is the one place
 * the port deviates, and it deviates toward the same rendered pixels.
 */

export interface IconProps extends React.SVGProps<SVGSVGElement> {
  /** Rendered size in px. Defaults match the design's most common placement. */
  readonly size?: number
}

const svg = (props: IconProps, viewBox: string, fallback: number) => {
  const { size = fallback, className, ...rest } = props
  return {
    width: size,
    height: size,
    viewBox,
    xmlns: "http://www.w3.org/2000/svg",
    className: cn("shrink-0", className),
    "aria-hidden": true,
    ...rest,
  }
}

export function PlusIcon(props: IconProps) {
  return (
    <svg {...svg(props, "0 0 16 16", 14)}>
      <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

/** The composer's add button. Heavier stroke because it sits on a 36px pill. */
export function PlusLargeIcon(props: IconProps) {
  return (
    <svg {...svg(props, "0 0 18 18", 18)}>
      <path d="M9 4v10M4 9h10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

export function SearchIcon(props: IconProps) {
  return (
    <svg {...svg(props, "0 0 16 16", 14)}>
      <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10.5 10.5L14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/** A wall socket. The same two-slot motif as the bot mark -- Evie's whole idea in one glyph. */
export function PlugIcon(props: IconProps) {
  return (
    <svg {...svg(props, "0 0 16 16", 16)}>
      <path
        d="M6 1.8v3.4M10 1.8v3.4M3.8 5.2h8.4v3.1a4.2 4.2 0 01-4.2 4.2A4.2 4.2 0 013.8 8.3V5.2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M8 12.5v1.7" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

export function ChevronUpDownIcon(props: IconProps) {
  return (
    <svg {...svg(props, "0 0 16 16", 14)}>
      <path
        d="M5.5 6.5L8 4l2.5 2.5M5.5 9.5L8 12l2.5-2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Opens the Computer pane. A monitor, because "your bot has its own machine" is the promise. */
export function MonitorIcon(props: IconProps) {
  return (
    <svg {...svg(props, "0 0 18 18", 18)}>
      <rect x="1.6" y="3" width="14.8" height="10.2" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6.5 15.6h5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

export function CloseIcon(props: IconProps) {
  return (
    <svg {...svg(props, "0 0 14 14", 14)}>
      <path d="M3 3l8 8M11 3l-8 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

/** Dictation. Deliberately not a live voice mode -- the platform's own input, nothing more. */
export function MicIcon(props: IconProps) {
  return (
    <svg {...svg(props, "0 0 18 18", 18)}>
      <rect x="6.4" y="2.4" width="5.2" height="8.4" rx="2.6" fill="currentColor" />
      <path
        d="M4 8.6a5 5 0 0010 0M9 13.6v2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** Send. Becomes a stop square while a turn is in flight -- see `Composer`. */
export function ArrowUpIcon(props: IconProps) {
  return (
    <svg {...svg(props, "0 0 18 18", 18)}>
      <path
        d="M9 14V4M4.5 8.5L9 4l4.5 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function StopIcon(props: IconProps) {
  return (
    <svg {...svg(props, "0 0 18 18", 18)}>
      <rect x="5.5" y="5.5" width="7" height="7" rx="1.6" fill="currentColor" />
    </svg>
  )
}

export function FilterIcon(props: IconProps) {
  return (
    <svg {...svg(props, "0 0 18 18", 18)}>
      <path
        d="M2.5 4.5h13M4.8 9h8.4M7.5 13.5h3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <svg {...svg(props, "0 0 16 16", 14)}>
      <path
        d="M6 3.5L10.5 8L6 12.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function CheckIcon(props: IconProps) {
  return (
    <svg {...svg(props, "0 0 16 16", 14)}>
      <path
        d="M3.5 8.5L6.5 11.5L12.5 5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function FolderIcon(props: IconProps) {
  return (
    <svg {...svg(props, "0 0 16 16", 14)}>
      <path
        d="M1.9 4.2a1.4 1.4 0 011.4-1.4h2.4l1.3 1.6h5.1a1.4 1.4 0 011.4 1.4v6a1.4 1.4 0 01-1.4 1.4H3.3a1.4 1.4 0 01-1.4-1.4V4.2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function FileIcon(props: IconProps) {
  return (
    <svg {...svg(props, "0 0 16 16", 14)}>
      <path
        d="M3.6 2.6h5l3.8 3.8v7a1 1 0 01-1 1H3.6a1 1 0 01-1-1v-9.8a1 1 0 011-1Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M8.6 2.6v3.8h3.8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  )
}
