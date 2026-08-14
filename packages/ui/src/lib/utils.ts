import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

/**
 * `cn` = clsx + tailwind-merge, taught about Evie's theme.
 *
 * The extension is not decoration. tailwind-merge resolves conflicts by class
 * *group*, and it infers groups from Tailwind's default scales — so a custom
 * colour called `surface` and a custom font size called `body` both look like
 * `text-<something>` and land in the same group. The last one wins and the
 * other is silently dropped.
 *
 * That is not hypothetical: `ActionButton`'s primary variant sets
 * `text-surface` (black text on the white button), a call site added
 * `text-body` for the design's 16px label, and the merge threw the colour
 * away. The result was a white button with white text — an invisible "Sign in"
 * that every type check and every unit test passed straight through, because
 * nothing here is type-checked and the classes are just strings.
 *
 * Listing the scales makes the grouping correct, so a size and a colour can
 * coexist on one element the way they read.
 */

/** Every custom `--text-*` step. Must match `@theme inline` in globals.css. */
const FONT_SIZES = [
  "metadata",
  "label",
  "compact",
  "ui",
  "body",
  "lede",
  "subsection",
  "section",
  "title",
  "page-title",
  "display",
]

/** Every custom `--color-*` alias, plus the shadcn contract names. */
const COLORS = [
  "surface",
  "surface-muted",
  "raised",
  "raised-strong",
  "contrast",
  "fg",
  "fg-muted",
  "on-contrast",
  "on-contrast-muted",
  "line",
  "line-subtle",
  "line-strong",
  "line-on-contrast",
  "success",
  "warning",
  "error",
  "info",
  "focus",
  "link",
  "traffic-close",
  "traffic-minimize",
  "traffic-zoom",
]

/** Every custom `--radius-*` step. `pill` and `full` are not interchangeable here. */
const RADII = ["small", "default", "bubble", "composer", "pill"]

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: FONT_SIZES }],
      "text-color": [{ text: COLORS }],
      "bg-color": [{ bg: COLORS }],
      "border-color": [{ border: COLORS }],
      "ring-color": [{ ring: COLORS }],
      rounded: [{ rounded: RADII }],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
