import type { Metadata, Viewport } from "next"
import { ThemeProvider } from "~/components/theme-provider"
import "./globals.css"

/**
 * The marketing shell.
 *
 * No `next/font`: Geist arrives self-hosted through @evie/ui's stylesheet, the
 * same files the app loads, so a heading here and a heading in the product are
 * the same rasterisation rather than two subsets that drift. `--font-sans` is
 * already bound to it by the design system, and the base layer sets it on
 * `body`.
 *
 * `suppressHydrationWarning` is required by the theme script, which is the one
 * thing that legitimately edits `<html>` before React sees it.
 */

export const metadata: Metadata = {
  metadataBase: new URL("https://tryevie.ai"),
  title: "Evie — a minimal GUI for eve agents",
  description:
    "A minimal, open-source GUI for eve agents. Bring your own key, run it on your own machine, and let your bots keep working after you close the laptop.",
  openGraph: {
    title: "Evie — a minimal GUI for eve agents",
    description: "Your team of always-on bots that you can give real work to.",
    url: "https://tryevie.ai",
    siteName: "Evie",
    type: "website",
  },
}

/** Matches `--color-surface-primary` in each theme, so the browser chrome agrees with the page. */
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full" suppressHydrationWarning>
      <body className="min-h-full bg-surface text-fg">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  )
}
