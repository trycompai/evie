import { cn } from "@evie/ui/lib/utils"

/**
 * Marketplace / Yours.
 *
 * A segmented control rather than tabs because both halves are the same kind of
 * thing seen two ways -- and because the selected segment is a raised chip
 * inside a recessed track, which reads as a switch at a glance where an
 * underline does not.
 *
 * The selection is a `radiogroup`, not a set of buttons: arrow keys move
 * between the options, which is what a keyboard user expects from a control
 * shaped like this.
 */

export interface SegmentedOption<T extends string> {
  readonly value: T
  readonly label: string
}

export interface SegmentedProps<T extends string> {
  readonly options: readonly SegmentedOption<T>[]
  readonly value: T
  readonly onChange: (value: T) => void
  readonly label: string
  readonly className?: string
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: SegmentedProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("flex items-center gap-1 rounded-default bg-raised-strong p-[3px] select-none", className)}
    >
      {options.map((option) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={cn(
              "flex h-[30px] items-center justify-center rounded-small px-3.5 text-compact",
              "focus-visible:ring-2 focus-visible:ring-focus/50 focus-visible:outline-none",
              selected ? "bg-raised font-medium text-fg" : "text-fg-muted hover:text-fg",
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
