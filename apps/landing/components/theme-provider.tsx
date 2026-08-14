"use client"

import { ThemeProvider as NextThemeProvider } from "next-themes"

/**
 * The only client component on the page.
 *
 * It exists to put `class="dark"` on `<html>` before first paint, which is the
 * one job that cannot be done on the server: the answer lives in the visitor's
 * OS setting. `next-themes` inlines a blocking script to read it, so the page
 * never flashes white at someone who asked for dark.
 *
 * Children are passed through as a slot, so everything under it stays a server
 * component and the client bundle is this file and nothing else.
 *
 * There is no toggle, deliberately. The design system's position is that themes
 * are implicit and Evie ships no visible switcher; the site follows the system
 * the same way the app does. Should that change, `useTheme()` is already here.
 */

export function ThemeProvider({ children }: { readonly children: React.ReactNode }) {
  return (
    <NextThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      // The tokens change; the type does not need to re-render to keep up.
      disableTransitionOnChange
    >
      {children}
    </NextThemeProvider>
  )
}
