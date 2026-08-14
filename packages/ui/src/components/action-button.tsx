import { cn } from "@evie/ui/lib/utils"
import { cva, type VariantProps } from "class-variance-authority"

/**
 * The full-width decision button: onboarding, sign-in, new bot.
 *
 * Separate from shadcn's `Button`, which is the dense 32px control for
 * toolbars and menus. These are the ones a person aims at once and then never
 * sees again, so they are 46-48px tall, they stack, and they say what happens
 * rather than "OK".
 *
 * Shape follows the surface: `pill` on the full-bleed onboarding stage where
 * there is no box to align to, `rounded` inside a card or a form where a
 * matching corner radius is what makes the group read as one thing.
 */

const actionButton = cva(
  cn(
    "inline-flex shrink-0 items-center justify-center gap-2 text-ui font-medium whitespace-nowrap select-none",
    "transition-opacity focus-visible:ring-2 focus-visible:ring-focus/50 focus-visible:outline-none",
    "disabled:pointer-events-none disabled:opacity-40",
  ),
  {
    variants: {
      variant: {
        primary: "bg-fg text-surface hover:opacity-90",
        secondary: "bg-raised text-fg hover:bg-raised-strong",
        ghost: "text-fg-muted hover:text-fg",
        danger: "bg-error/10 text-error hover:bg-error/20",
      },
      shape: {
        pill: "rounded-pill",
        rounded: "rounded-default",
      },
      size: {
        // 46px is the onboarding stack; 48px is the sign-in pair, which sits
        // next to a 48px-tall account card and has to match it.
        default: "h-[46px] px-5",
        tall: "h-12 px-5",
      },
      block: {
        true: "w-full",
        false: "",
      },
    },
    defaultVariants: { variant: "primary", shape: "pill", size: "default", block: false },
  },
)

export interface ActionButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof actionButton> {}

export function ActionButton({
  className,
  variant,
  shape,
  size,
  block,
  type = "button",
  ...props
}: ActionButtonProps) {
  return (
    <button
      type={type}
      className={cn(actionButton({ variant, shape, size, block }), className)}
      {...props}
    />
  )
}

export { actionButton }
