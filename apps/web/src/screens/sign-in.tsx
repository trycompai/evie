import { ActionButton } from "@evie/ui/components/action-button"
import { BotMark } from "@evie/ui/components/bot-mark"
import { MemberAvatar } from "@evie/ui/components/member-chip"

/**
 * 02 Sign in — the consent step.
 *
 * The desktop app asked to sign in with this account and the person confirms.
 * The column is 620px and centred in the window, but everything inside it is
 * left-aligned: this is a decision, not a splash screen, and it reads like one.
 */

export interface SignInScreenProps {
  readonly name: string
  readonly email: string
  readonly image?: string | null
  /** True while the token exchange is in flight; both buttons disable. */
  readonly pending?: boolean
  readonly onConfirm: () => void
  readonly onCancel: () => void
}

export function SignInScreen({
  name,
  email,
  image,
  pending = false,
  onConfirm,
  onCancel,
}: SignInScreenProps) {
  return (
    <div className="flex h-full items-center justify-center overflow-hidden bg-surface px-10">
      <div className="flex w-[620px] max-w-full flex-col gap-7">
        <div className="flex flex-col gap-3.5">
          <BotMark size={48} tone={1} label="Evie" />
          <div className="flex flex-col gap-1.5">
            {/* -0.03em sits between the section and subsection steps; the
                design tightens this one heading by exactly that much. */}
            <h1 className="text-title tracking-[-0.03em] text-fg">Sign in to Evie</h1>
            <p className="text-[17px] leading-[26px] text-fg-muted">
              The Evie app is asking to sign in with this account.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3.5 rounded-default border border-line p-4">
          {/* The design holds the initials at 16px inside the 44px disc. */}
          <MemberAvatar
            name={name}
            image={image}
            size={44}
            fontSize={16}
            className="bg-raised-strong"
          />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="truncate text-[17px] leading-6 text-fg">{name}</p>
            <p className="truncate text-body leading-[22px] text-fg-muted">{email}</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {/* The design sets this pair one step up from the button default:
              16px labels on the 48px tall size. */}
          <ActionButton
            variant="secondary"
            shape="rounded"
            size="tall"
            className="min-w-0 flex-1 text-body leading-[22px]"
            disabled={pending}
            onClick={onCancel}
          >
            Cancel
          </ActionButton>
          <ActionButton
            shape="rounded"
            size="tall"
            className="min-w-0 flex-1 text-body leading-[22px]"
            disabled={pending}
            onClick={onConfirm}
          >
            {pending ? "Signing in" : "Sign in"}
          </ActionButton>
        </div>

        <p className="text-body text-fg-muted">
          Only continue if you just opened this page from the Evie app.
        </p>
      </div>
    </div>
  )
}
