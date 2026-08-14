import { AssistantBubble, DayDivider, Paragraph, UserBubble } from "@evie/ui/components/message"
import { ThreadHeader } from "@evie/ui/components/thread-header"
import { MockRail } from "~/components/screens/mock-rail"
import { Screen } from "~/components/screens/screen-frame"
import { StaticApprovalCard, StaticComposer } from "~/components/screens/static-controls"

/**
 * 06 Chat, as a still.
 *
 * The turn shown is the one the design picked: a question with real stakes,
 * answered in the bot's own voice, ending in the card that asks before it
 * touches anything. Three of the page's four screenshots crop into this screen,
 * so the transcript is written once, here.
 */

const BOT = "Chief of Staff"

const ASK =
  "Hey chief of staff. Find out everything about me (Lewis Carhart, lewis@trycomp.ai) — what will actually make me faster?"

const REPLIES = [
  "On it. Starting with you and Comp, then I'll turn that into what actually makes you faster.",
  "You're Lewis Carhart, CEO of Comp. Builder first, operator second. You still ship, and you write like you talk: short, blunt, anti-complexity. So I'll skip the generic founder advice.",
] as const

const CLOSING = [
  "What makes you fast is not another dashboard. It's me sitting on Slack and Workspace and only putting in front of you the things that need Lewis: overnight Slack, email that can't wait, today's meetings with a one-liner on each, and hiring that's stalling. Everything else I draft, chase, or kill.",
  "The 20-hire push is the highest-leverage thing I can run. After that: calendar defense, and replies in your voice so you tap send instead of writing from scratch.",
] as const

const OPTIONS = ["Slack + Google", "Just Slack", "Just Google", "Not yet"] as const

export function ChatScreen() {
  return (
    <Screen>
      <MockRail />
      <main className="flex min-w-0 flex-1 flex-col">
        <ThreadHeader name={BOT} shape="circle" tone={1} state={{ kind: "ready" }} />

        <div className="min-h-0 flex-1 overflow-hidden px-7 pt-5 pb-3">
          <DayDivider label="Today 3:52 PM" />
          <UserBubble>{ASK}</UserBubble>
          <div className="flex flex-col items-start gap-2 pt-2">
            {REPLIES.map((reply) => (
              <AssistantBubble key={reply}>
                <Paragraph>{reply}</Paragraph>
              </AssistantBubble>
            ))}
            <AssistantBubble>
              {CLOSING.map((paragraph) => (
                <Paragraph key={paragraph}>{paragraph}</Paragraph>
              ))}
            </AssistantBubble>
            <StaticApprovalCard
              prompt="Want me to connect Slack and Google so I can actually do this?"
              options={OPTIONS}
            />
          </div>
        </div>

        <StaticComposer placeholder={`Message ${BOT}`} />
      </main>
    </Screen>
  )
}
