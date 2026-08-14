import { cn } from "@evie/ui/lib/utils"

/**
 * A labelled input. The new-bot name field, the token field, the routine editor.
 *
 * The label is a real `<label>` wired by id rather than a placeholder, because
 * a placeholder disappears exactly when the user needs it -- while they are
 * typing and checking what they typed.
 */

export interface TextFieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "id"> {
  readonly id: string
  readonly label: string
  /** Shown under the field. Use for a constraint, not for restating the label. */
  readonly hint?: string
  readonly error?: string
  readonly containerClassName?: string
}

export function TextField({
  id,
  label,
  hint,
  error,
  containerClassName,
  className,
  ...props
}: TextFieldProps) {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined
  return (
    <div className={cn("flex flex-col gap-2", containerClassName)}>
      <label htmlFor={id} className="text-compact text-fg-muted">
        {label}
      </label>
      <input
        id={id}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        className={cn(
          "h-11 w-full rounded-default bg-raised px-3.5 text-body text-fg outline-none",
          "placeholder:text-fg-muted focus-visible:ring-2 focus-visible:ring-focus/50",
          error && "ring-2 ring-error/50",
          className,
        )}
        {...props}
      />
      {error ? (
        <p id={`${id}-error`} className="text-metadata text-error">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-metadata text-fg-muted">
          {hint}
        </p>
      ) : null}
    </div>
  )
}
