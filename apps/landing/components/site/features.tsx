import { ChatScreen } from "~/components/screens/chat-screen"
import { NewBotScreen } from "~/components/screens/new-bot-screen"
import { PluginsScreen } from "~/components/screens/plugins-screen"
import { FIT, ScreenFrame } from "~/components/screens/screen-frame"
import {
  Column,
  MonoLabel,
  Section,
  SectionHeading,
  SectionLede,
} from "~/components/site/primitives"
import { FEATURES } from "~/content/site"

/**
 * Three claims, each with the screen that proves it.
 *
 * Two equal cards then one wide one, rather than a 2x2: the third claim is
 * about a single moment in a thread, so it gets a detail crop at 90% instead of
 * a whole window at 41%, and the change of rhythm is what keeps the grid from
 * reading as a table.
 */

/** 588 / 1440 -- the whole window, exactly as wide as the card. */
const CARD_SCALE = 588 / 1440

export function Features() {
  const [first, second] = FEATURES.cards

  return (
    <Section alive id="product" className="pt-20 pb-24 tablet:pt-28 tablet:pb-30">
      <SectionHeading className="text-center">{FEATURES.heading}</SectionHeading>
      <SectionLede className="w-[600px] max-w-full pt-4 text-center text-lede">
        {FEATURES.lede}
      </SectionLede>

      <Column className="gap-6 pt-12 tablet:pt-14">
        <div className="flex flex-wrap justify-center gap-6">
          <FeatureCard title={first.title} body={first.body}>
            <NewBotScreen />
          </FeatureCard>
          <FeatureCard title={second.title} body={second.body}>
            <PluginsScreen />
          </FeatureCard>
        </div>

        <WideCard />
      </Column>
    </Section>
  )
}

function FeatureCard({
  title,
  body,
  children,
}: {
  readonly title: string
  readonly body: string
  readonly children: React.ReactNode
}) {
  return (
    <article className="flex w-[588px] max-w-full shrink-0 flex-col overflow-hidden rounded-[14px] border border-line-subtle bg-surface">
      <div className="flex flex-col gap-2 px-7 pt-7 pb-[26px]">
        <h3 className="text-subsection font-medium tracking-subsection text-balance text-fg">
          {title}
        </h3>
        <p className="text-[15px] leading-[23px] text-fg-muted">{body}</p>
      </div>
      <ScreenFrame
        width={588}
        height={368}
        scale={CARD_SCALE}
        fit={FIT.card}
        className="border-t border-line-subtle"
      >
        {children}
      </ScreenFrame>
    </article>
  )
}

/**
 * The wide card crops into the thread at 90%, offset to land on the question
 * card with the composer still in shot -- the two things the claim is about.
 * Below the point where 440 of copy and 758 of screenshot stop fitting side by
 * side, the two stack and the card gives up its fixed height.
 */
function WideCard() {
  return (
    <article className="flex w-full flex-wrap overflow-hidden rounded-[14px] border border-line-subtle bg-surface desktop:h-[360px] desktop:flex-nowrap">
      <div className="flex w-[440px] max-w-full shrink-0 flex-col justify-center gap-3 p-8 tablet:p-10">
        <MonoLabel>{FEATURES.wide.eyebrow}</MonoLabel>
        <h3 className="text-subsection font-medium tracking-subsection text-balance text-fg">
          {FEATURES.wide.title}
        </h3>
        <p className="text-[15px] leading-[23px] text-fg-muted">{FEATURES.wide.body}</p>
      </div>
      <ScreenFrame
        width={758}
        height={358}
        scale={0.9}
        offsetX={-240}
        offsetY={-441}
        fit={FIT.detail}
        className="border-t border-line-subtle desktop:border-t-0 desktop:border-l"
      >
        <ChatScreen />
      </ScreenFrame>
    </article>
  )
}
