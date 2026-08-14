import { createRoot } from "react-dom/client"
import type { Bot } from "@evie/contracts/bot"
import type { BotId, OrgId, ThreadId, UserId } from "@evie/contracts/ids"
import type { Thread } from "@evie/contracts/thread"
import { ApprovalCard } from "@evie/ui/components/approval-card"
import { Composer } from "@evie/ui/components/composer"
import { AssistantBubble, AssistantGroup, DayDivider, Paragraph, UserBubble } from "@evie/ui/components/message"
import { ThreadHeader } from "@evie/ui/components/thread-header"
import { AppRail } from "~/components/app-rail.tsx"
import { ConnectAppsScreen } from "~/screens/connect-apps.tsx"
import { LaunchScreen } from "~/screens/launch.tsx"
import { MeetEvieScreen } from "~/screens/meet-evie.tsx"
import { BOT_SUGGESTIONS, NewBotScreen } from "~/screens/new-bot.tsx"
import { PluginsDialog } from "~/screens/plugins.tsx"
import { SignInScreen } from "~/screens/sign-in.tsx"
import "~/styles.css"

/**
 * The screen gallery: every screen at its Paper size, with fixed props, no
 * server.
 *
 * `docs/internals/design-system.md` says to screenshot the Paper artboard and
 * read your rendered output beside it. Doing that through the real app means
 * driving it into each state first -- some of which need a live agent and a
 * finished npm install. This renders all of them deterministically instead, so
 * a fidelity check is one screenshot per URL rather than a scripted session.
 *
 * Dev-only: `gallery.html` is not in `build.rollupOptions.input`, so it never
 * reaches a production bundle.
 */

const SCREEN = new URLSearchParams(globalThis.location.search).get("screen") ?? "index"

const orgId = "org_1" as OrgId
const userId = "user_1" as UserId

const bot = (id: string, name: string, avatar: string): Bot =>
  ({
    id: id as BotId,
    orgId,
    teamId: null,
    slug: name.toLowerCase().replace(/\s+/g, "-"),
    name,
    description: null,
    avatar,
    model: "anthropic/claude-opus-4.8",
    reasoning: "high",
    runtimeMode: "dev",
    sandbox: {
      backend: "docker",
      network: { mode: "allow-list", allow: ["ai-gateway.vercel.sh"], enforced: "coarse" },
    },
    health: { kind: "idle" },
    createdBy: userId,
    createdAt: 1_786_740_000_000,
    archivedAt: null,
  }) as Bot

const BOTS = [
  // The three faces the Paper chat artboard draws.
  bot("01M013RGEPPQHCWZT7SEK73KHG", "Chief of Staff", "circle:1"),
  bot("01M013X2MJQ1Q42FZ4KCCKRET7", "Inbox Triage", "squircle:3"),
  bot("01M013Z4PH5BP0E91H4JNMCXF0", "Recruiting", "hexagon:5"),
]

const thread = (id: string, botIndex: number, preview: string, at: number): Thread =>
  ({
    id: id as ThreadId,
    orgId,
    title: null,
    participants: [
      { botId: BOTS[botIndex]!.id, eveSessionId: null, streamIndex: 0, isDefault: true },
    ],
    status: { kind: "ready" },
    preview,
    createdBy: userId,
    createdAt: at,
    lastActivity: at,
    snoozedUntil: null,
    archivedAt: null,
  }) as Thread

const NOW = new Date("2026-08-14T15:53:00").getTime()
const THREADS = [
  thread("01M0140000000000000000TH1", 0, "What makes you fast…", NOW),
  thread("01M0140000000000000000TH2", 1, "Cleared 14 threads.", NOW - 4.5 * 3_600_000),
  thread("01M0140000000000000000TH3", 2, "Two candidates waiting.", NOW - 26 * 3_600_000),
]

const noop = () => {}

function Rail() {
  return (
    <div className="flex h-full bg-surface">
      <AppRail
        bots={BOTS}
        threads={THREADS}
        activeThreadId={THREADS[0]!.id}
        accountName="Lewis Carhart"
        location="This Mac"
        desktop
        onSelectThread={noop}
        onNewBot={noop}
        onOpenPlugins={noop}
        onOpenAccount={noop}
      />
      <main className="flex-1" />
    </div>
  )
}

function NewBot() {
  return (
    <div className="flex h-full bg-surface">
      <AppRail
        bots={[]}
        threads={[]}
        activeThreadId={null}
        composingBot
        accountName="Lewis Carhart"
        location="This Mac"
        desktop
        onSelectThread={noop}
        onNewBot={noop}
        onOpenPlugins={noop}
        onOpenAccount={noop}
      />
      <NewBotScreen
        name="Chief of Staff"
        onNameChange={noop}
        shape="circle"
        tone={1}
        onShapeChange={noop}
        onToneChange={noop}
        onCreate={noop}
        onPickSuggestion={noop}
        creating={false}
      />
    </div>
  )
}

const LISTINGS = [
  { id: "gmail", name: "Gmail", blurb: "Read, draft, and send from your inbox.", category: "Featured", kind: "mcp", scope: "member", featured: true, hosts: [] },
  { id: "google-calendar", name: "Google Calendar", blurb: "See your day and defend your calendar.", category: "Featured", kind: "mcp", scope: "member", featured: true, hosts: [] },
  { id: "google-drive", name: "Google Drive", blurb: "Find, read, and write your team's docs.", category: "Featured", kind: "mcp", scope: "member", featured: true, hosts: [] },
  { id: "notion", name: "Notion", blurb: "Keep specs and notes in sync as work moves.", category: "Featured", kind: "mcp", scope: "member", featured: true, hosts: [] },
  { id: "slack", name: "Slack", blurb: "Watch channels and reply in your voice.", category: "Communication", kind: "mcp", scope: "member", featured: false, hosts: [] },
  { id: "linear", name: "Linear", blurb: "Open, update, and close issues as work lands.", category: "Communication", kind: "mcp", scope: "member", featured: false, hosts: [] },
  { id: "hubspot", name: "HubSpot", blurb: "Keep deals and contacts current without asking.", category: "Communication", kind: "mcp", scope: "org", featured: false, hosts: [] },
  { id: "github", name: "GitHub", blurb: "Review pull requests and chase stale branches.", category: "Communication", kind: "mcp", scope: "member", featured: false, hosts: [] },
] as never

/**
 * The chat surface, composed from the same components the app uses but with
 * fixed content instead of a store. The store path is proven end to end
 * against a live server; what this checks is the drawing.
 */
function Chat() {
  return (
    <div className="flex h-full bg-surface">
      <AppRail
        bots={BOTS}
        threads={THREADS}
        activeThreadId={THREADS[0]!.id}
        accountName="Lewis Carhart"
        location="This Mac"
        desktop
        onSelectThread={noop}
        onNewBot={noop}
        onOpenPlugins={noop}
        onOpenAccount={noop}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        <ThreadHeader name="Chief of Staff" state={{ kind: "ready" }} onToggleComputer={noop} />
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-7 pt-5 pb-3">
          <DayDivider label="Today 3:52 PM" />
          <UserBubble>
            <Paragraph>
              Hey chief of staff. Find out everything about me (Lewis Carhart, lewis@trycomp.ai) — what
              will actually make me faster?
            </Paragraph>
          </UserBubble>
          <AssistantGroup>
            <AssistantBubble>
              <Paragraph>
                On it. Starting with you and Comp, then I&apos;ll turn that into what actually makes you
                faster.
              </Paragraph>
            </AssistantBubble>
            <AssistantBubble>
              <Paragraph>
                You&apos;re Lewis Carhart, CEO of Comp. Builder first, operator second. You still ship,
                and you write like you talk: short, blunt, anti-complexity. So I&apos;ll skip the generic
                founder advice.
              </Paragraph>
            </AssistantBubble>
            <AssistantBubble>
              <Paragraph>
                What makes you fast is not another dashboard. It&apos;s me sitting on Slack and Workspace
                and only putting in front of you the things that need Lewis: overnight Slack, email that
                can&apos;t wait, today&apos;s meetings with a one-liner on each, and hiring that&apos;s
                stalling. Everything else I draft, chase, or kill.
              </Paragraph>
              <Paragraph>
                The 20-hire push is the highest-leverage thing I can run. After that: calendar defense,
                and replies in your voice so you tap send instead of writing from scratch.
              </Paragraph>
            </AssistantBubble>
            <ApprovalCard
              prompt="Want me to connect Slack and Google so I can actually do this?"
              state="pending"
              onDismiss={noop}
              options={[
                { id: "both", label: "Slack + Google" },
                { id: "slack", label: "Just Slack" },
                { id: "google", label: "Just Google" },
                { id: "no", label: "Not yet" },
              ]}
            />
          </AssistantGroup>
        </div>
        <Composer placeholder="Message Chief of Staff" value="" onChange={noop} onSend={noop} />
      </main>
    </div>
  )
}

const SCREENS: Record<string, () => React.ReactNode> = {
  launch: () => <LaunchScreen state="waiting" onReopen={noop} onCancel={noop} desktop />,
  "sign-in": () => (
    <SignInScreen
      name="Lewis Carhart"
      email="lewis@trycomp.ai"
      pending={false}
      onConfirm={noop}
      onCancel={noop}
    />
  ),
  "meet-evie": () => <MeetEvieScreen onNext={noop} onSkip={noop} desktop />,
  "connect-apps": () => (
    <ConnectAppsScreen
      selected={new Set(["google-workspace", "slack"])}
      onToggle={noop}
      onNext={noop}
      onBack={noop}
      desktop
    />
  ),
  "new-bot": () => <NewBot />,
  rail: () => <Rail />,
  chat: () => <Chat />,
  plugins: () => (
    <>
      <Rail />
      <PluginsDialog
        open
        onOpenChange={noop}
        listings={LISTINGS}
        installed={new Set()}
        onAdd={noop}
        onRemove={noop}
      />
    </>
  ),
}

function Index() {
  return (
    <div className="flex h-full flex-col gap-4 bg-surface p-10">
      <h1 className="text-page-title tracking-section text-fg">Screen gallery</h1>
      <ul className="flex flex-col gap-2">
        {Object.keys(SCREENS).map((name) => (
          <li key={name}>
            <a className="text-body text-link underline underline-offset-2" href={`?screen=${name}`}>
              {name}
            </a>
          </li>
        ))}
      </ul>
      <p className="max-w-[520px] text-compact text-fg-muted">
        Each screen renders at the Paper artboard size with fixed props and no server, so a fidelity
        check is one screenshot per URL. Dev only — this entry is not in the production build.
      </p>
    </div>
  )
}

const root = document.getElementById("root")
if (!root) throw new Error("#root is missing from gallery.html")

const render = SCREENS[SCREEN] ?? Index
createRoot(root).render(render())

void BOT_SUGGESTIONS
