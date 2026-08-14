import { cn } from "@evie/ui/lib/utils"

/**
 * "Sign in, then hand it back."
 *
 * eve raises `authorization.required` for one member. **The card is addressed.**
 * For its subject it is a button; for everyone else in the thread it is a quiet
 * line saying who we are waiting on. Showing a live sign-in button to the wrong
 * person is a bug, not a convenience -- they cannot complete it, and trying
 * teaches them the interface lies.
 */

export interface AuthorizationCardProps {
  readonly displayName: string
  readonly state: "pending" | "completed" | "failed" | "cancelled"
  /** True when the viewer is the member this authorization is for. */
  readonly isMine: boolean
  /** The other person's name, for the inert variant. */
  readonly forName?: string
  readonly url?: string
  /** Device-code flows show a code to type on the other screen. */
  readonly userCode?: string
  readonly onOpen?: () => void
}

export function AuthorizationCard({
  displayName,
  state,
  isMine,
  forName,
  url,
  userCode,
  onOpen,
}: AuthorizationCardProps) {
  if (state === "completed") {
    return (
      <p className="text-metadata text-fg-muted">
        Connected to {displayName}
        {!isMine && forName ? ` for ${forName}` : ""}.
      </p>
    )
  }

  if (state === "failed" || state === "cancelled") {
    return (
      <p className="text-metadata text-fg-muted">
        {state === "failed" ? "Could not connect to" : "Cancelled connecting to"} {displayName}.
      </p>
    )
  }

  if (!isMine) {
    return (
      <p className="text-metadata text-fg-muted">
        Waiting for {forName ?? "a teammate"} to connect {displayName}.
      </p>
    )
  }

  return (
    <div className="flex w-[780px] max-w-full flex-col gap-3.5 rounded-bubble bg-raised px-[18px] pt-4 pb-[18px]">
      <div className="flex flex-col gap-1">
        <p className="text-body text-fg">Sign in to {displayName}</p>
        <p className="text-metadata text-fg-muted">
          This connects your own account. Nobody else in this organization can use it, and the bot picks
          up where it left off.
        </p>
      </div>

      {userCode && (
        <div className="flex items-center gap-3 rounded-default border border-line-subtle px-3.5 py-3">
          <span className="text-metadata text-fg-muted">Enter this code</span>
          <span className="font-mono text-subsection tracking-subsection text-fg select-all">{userCode}</span>
        </div>
      )}

      <a
        href={url}
        target="_blank"
        rel="noreferrer noopener"
        onClick={onOpen}
        className={cn(
          "flex h-11 items-center justify-center rounded-pill bg-fg px-4 text-ui font-medium text-surface",
          "hover:opacity-90 focus-visible:ring-2 focus-visible:ring-focus/50 focus-visible:outline-none",
          !url && "pointer-events-none opacity-50",
        )}
      >
        Continue to {displayName}
      </a>
    </div>
  )
}
