import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu"
import { Menu as MenuPrimitive } from "@base-ui/react/menu"
import { cn } from "@evie/ui/lib/utils"

/**
 * The app's dropdown: a short list of actions behind one small trigger.
 *
 * What belongs here is a verb -- rename, delete, restore. Anything that asks a
 * question or takes typing belongs in a `Dialog` the item opens; a menu that
 * grows a text field has stopped being a menu.
 *
 * Enter/exit mirrors `DialogSurface` (opacity + scale, 200/150ms) so the two
 * overlays read as one system, but a menu grows from its trigger rather than
 * from the centre: `--transform-origin` is where base-ui says the trigger is.
 *
 * `ContextMenu*` below is the same menu opened by right-click. Separate
 * primitives because base-ui's are (a context menu positions at the pointer,
 * not at a trigger), but one skin -- the class strings are shared so the two
 * are indistinguishable once open.
 */

const popupClass = cn(
  "min-w-[180px] origin-[var(--transform-origin)] rounded-default border border-line-subtle bg-raised py-1.5",
  "shadow-[0_8px_24px_-4px_rgb(0_0_0/0.16)] focus-visible:outline-none",
  "transition-[opacity,scale] duration-200 ease-out",
  "data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0",
  "data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0 data-[ending-style]:duration-150",
)

const itemClass = (destructive: boolean) =>
  cn(
    "flex w-full cursor-default items-center gap-2.5 px-3.5 py-1.5 text-ui select-none",
    "outline-none data-[highlighted]:bg-raised-strong",
    destructive ? "text-error" : "text-fg",
  )

export const Menu = MenuPrimitive.Root
export const MenuTrigger = MenuPrimitive.Trigger

export function MenuPopup({ className, children, ...props }: MenuPrimitive.Popup.Props) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner sideOffset={6} align="end" className="z-50 outline-none">
        <MenuPrimitive.Popup className={cn(popupClass, className)} {...props}>
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

export interface MenuItemProps extends MenuPrimitive.Item.Props {
  /** Draws the item in the error colour. For the verbs that remove things. */
  readonly destructive?: boolean
}

export function MenuItem({ className, destructive = false, ...props }: MenuItemProps) {
  return <MenuPrimitive.Item className={cn(itemClass(destructive), className)} {...props} />
}

export function MenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      className={cn("mx-3.5 my-1.5 h-px bg-line-subtle", className)}
      {...props}
    />
  )
}

export const ContextMenu = ContextMenuPrimitive.Root

/**
 * `display: contents` so wrapping a row costs no box and breaks no flex
 * layout: the trigger element paints nothing, and the right-click reaches it
 * by bubbling.
 */
export function ContextMenuTrigger({ className, ...props }: ContextMenuPrimitive.Trigger.Props) {
  return <ContextMenuPrimitive.Trigger className={cn("contents", className)} {...props} />
}

export function ContextMenuPopup({ className, children, ...props }: ContextMenuPrimitive.Popup.Props) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner className="z-50 outline-none">
        <ContextMenuPrimitive.Popup className={cn(popupClass, className)} {...props}>
          {children}
        </ContextMenuPrimitive.Popup>
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  )
}

export interface ContextMenuItemProps extends ContextMenuPrimitive.Item.Props {
  /** Draws the item in the error colour. For the verbs that remove things. */
  readonly destructive?: boolean
}

export function ContextMenuItem({ className, destructive = false, ...props }: ContextMenuItemProps) {
  return <ContextMenuPrimitive.Item className={cn(itemClass(destructive), className)} {...props} />
}
