import { cn } from "@evie/ui/lib/utils"
import { SearchIcon } from "@evie/ui/components/icon"

/**
 * The rail's search box, and the Plugins dialog's.
 *
 * A real `input` rather than the design's static text node: the design draws a
 * resting state and this is the same 36px row with a caret in it.
 */

export interface SearchFieldProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size" | "type"> {
  readonly containerClassName?: string
  /**
   * The design uses three sizes for this one control: 14px in the rail, 15px in
   * the Plugins dialog, 16px on the onboarding hero. A prop rather than a
   * `[&_svg]:size-4` at the call site, because a descendant selector reaching
   * into a component is a dependency on its internals that nothing checks.
   */
  readonly iconSize?: number
}

export function SearchField({
  containerClassName,
  className,
  iconSize,
  placeholder = "Search",
  ...props
}: SearchFieldProps) {
  return (
    <div
      className={cn(
        "flex h-9 w-full items-center gap-2 rounded-default bg-raised px-2.5",
        "focus-within:ring-2 focus-within:ring-focus/40",
        containerClassName,
      )}
    >
      <SearchIcon size={iconSize} className="text-fg-muted" />
      <input
        type="search"
        placeholder={placeholder}
        className={cn(
          "min-w-0 flex-1 bg-transparent text-compact text-fg outline-none",
          "placeholder:text-fg-muted",
          // Safari draws its own clear affordance on type=search and it does not
          // match anything else in the app.
          "[&::-webkit-search-cancel-button]:appearance-none",
          className,
        )}
        {...props}
      />
    </div>
  )
}
