import { cn } from "@evie/ui/lib/utils"
import { ChevronRightIcon, FileIcon, FolderIcon } from "@evie/ui/components/icon"
import { Segmented } from "@evie/ui/components/segmented"

/**
 * The bot's computer.
 *
 * This pane is the affordance that makes "your bot has its own machine" legible
 * rather than a claim in marketing copy. Files, a terminal, and later a live
 * browser -- all over one sandbox.
 *
 * The policy footer is the load-bearing part. Docker understands only
 * allow-all/deny-all and `just-bash` has no isolation at all, so the pane says
 * what is actually enforced instead of what was configured. A policy the UI
 * claims and does not deliver is worse than no policy.
 */

export type ComputerTab = "files" | "terminal" | "browser"

const TABS = [
  { value: "files" as const, label: "Files" },
  { value: "terminal" as const, label: "Terminal" },
  { value: "browser" as const, label: "Browser" },
]

export interface SandboxSummary {
  readonly backend: "just-bash" | "docker" | "microsandbox" | "vercel"
  readonly mode: "deny-all" | "allow-list" | "allow-all"
  readonly allowed: number
  /** What the backend can actually police, which is not always what was asked for. */
  readonly enforced: "domain" | "coarse" | "none"
}

export interface ComputerPaneProps {
  readonly tab: ComputerTab
  readonly onTabChange: (tab: ComputerTab) => void
  readonly sandbox: SandboxSummary
  readonly children: React.ReactNode
  readonly onOpenSettings?: () => void
}

export function ComputerPane({
  tab,
  onTabChange,
  sandbox,
  children,
  onOpenSettings,
}: ComputerPaneProps) {
  return (
    <aside className="flex h-full w-[340px] shrink-0 flex-col border-l border-line-subtle bg-surface">
      <div className="flex h-14 shrink-0 items-center px-4">
        <Segmented options={TABS} value={tab} onChange={onTabChange} label="Computer view" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">{children}</div>
      <SandboxFooter sandbox={sandbox} onOpenSettings={onOpenSettings} />
    </aside>
  )
}

function SandboxFooter({
  sandbox,
  onOpenSettings,
}: {
  readonly sandbox: SandboxSummary
  readonly onOpenSettings?: () => void
}) {
  const warn = sandbox.backend === "just-bash" || sandbox.enforced === "none"
  return (
    <button
      type="button"
      onClick={onOpenSettings}
      className="flex shrink-0 flex-col gap-1 border-t border-line-subtle px-4 py-3 text-left select-none hover:bg-raised"
    >
      <span className="flex items-center gap-2">
        <span aria-hidden className={cn("size-1.5 rounded-full", warn ? "bg-warning" : "bg-success")} />
        <span className="text-metadata text-fg">{BACKEND_LABEL[sandbox.backend]}</span>
      </span>
      <span className="text-metadata text-fg-muted">{policyLine(sandbox)}</span>
    </button>
  )
}

const BACKEND_LABEL = {
  "just-bash": "Simulated shell",
  docker: "Container",
  microsandbox: "Local microVM",
  vercel: "Hosted microVM",
} as const

const policyLine = (s: SandboxSummary): string => {
  if (s.backend === "just-bash") return "No isolation — no real binaries, no network boundary"
  if (s.enforced === "none") return "This backend cannot enforce a network policy"
  if (s.enforced === "coarse") {
    return s.mode === "deny-all" ? "Network off (all-or-nothing on this backend)" : "Network on — no per-domain limits"
  }
  if (s.mode === "allow-all") return "Any host"
  if (s.mode === "deny-all") return "No network"
  return `${s.allowed} allowed ${s.allowed === 1 ? "host" : "hosts"}`
}

export interface FileRowProps {
  readonly name: string
  readonly kind: "file" | "dir"
  readonly depth: number
  /**
   * Directories only. Draws the twisty and is what tells a screen reader the
   * row opens something; leaving it off marks the row as a plain entry.
   */
  readonly expanded?: boolean
  readonly onSelect?: () => void
}

export function FileRow({ name, kind, depth, expanded, onSelect }: FileRowProps) {
  const row = "flex h-8 w-full items-center gap-2 rounded-small px-2 text-left select-none"
  // Indent is data, not design: there is no Tailwind class for "depth 4".
  const indent = { paddingLeft: 8 + depth * 14 }
  const content = (
    <>
      {/* Held open on every row, so names stay in one column whatever is beside them. */}
      <span
        className={cn(
          "flex w-3 shrink-0 items-center justify-center text-fg-muted",
          expanded === true && "rotate-90",
        )}
      >
        {expanded === undefined ? null : <ChevronRightIcon size={12} />}
      </span>
      <span className="flex w-4 shrink-0 items-center justify-center text-fg-muted">
        {kind === "dir" ? <FolderIcon /> : <FileIcon />}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-metadata text-fg">{name}</span>
    </>
  )

  // A row with nowhere to go is not a control. Rendering it as one anyway gives
  // it a hover state, a focus ring and a tab stop for a click that does
  // nothing -- three hundred of them between the folder you want and the next
  // thing you can actually press.
  return onSelect ? (
    <button
      type="button"
      onClick={onSelect}
      aria-expanded={expanded}
      className={cn(row, "hover:bg-raised")}
      style={indent}
    >
      {content}
    </button>
  ) : (
    <div className={row} style={indent}>
      {content}
    </div>
  )
}

/**
 * Terminal output. Not an emulator -- a transcript of what the sandbox printed.
 * A real PTY is Phase 3, alongside the CDP screencast.
 */
export function TerminalView({ lines }: { readonly lines: readonly string[] }) {
  return (
    <pre className="overflow-x-auto px-2 py-2 font-mono text-metadata whitespace-pre-wrap text-fg-muted">
      {lines.length > 0 ? lines.join("\n") : "Nothing has run in this sandbox yet."}
    </pre>
  )
}

/** Phase 3. Saying so beats a blank pane that looks broken. */
export function BrowserPlaceholder() {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <p className="text-center text-metadata text-fg-muted">
        The live browser view lands with takeover, so you can sign in for the bot and hand it back.
      </p>
    </div>
  )
}
