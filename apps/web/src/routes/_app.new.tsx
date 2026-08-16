import { useState } from "react"
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router"
import type { BotId, ThreadId } from "@evie/contracts/ids"
import { markOf } from "@evie/ui/components/bot-mark"
import type { BotShape, BotTone } from "@evie/ui/components/bot-mark"
import { useRuntime } from "~/lib/runtime.ts"
import { NewBotScreen, type ArchivedBot } from "~/screens/new-bot.tsx"

/**
 * Making a bot.
 *
 * A route rather than a modal because in the design it is a place you are, not
 * something you are trapped in -- the rail stays beside it and the
 * conversations you already have are one click away.
 *
 * The form is the one piece of state here that stays in React. A name being
 * typed does not belong in the address bar: it would write on every keystroke,
 * and losing a half-typed name to a refresh is what every form on the web does.
 */
export const Route = createFileRoute("/_app/new")({
  /*
   * Archived bots are fetched here rather than carried on the fleet stream:
   * the fleet is what the rail draws every frame, and a deleted bot has no
   * business in it. This screen is the one place they surface -- the way back
   * from delete lives next to the way in -- so this route asks for them when
   * you arrive, and asks again after a restore.
   */
  loader: async ({ context }): Promise<readonly ArchivedBot[]> => {
    const bots = await context.runtime.store.client.rpc((c) =>
      c["bots.list"]({ includeArchived: true }),
    )
    return bots
      .filter((bot) => bot.archivedAt !== null)
      .map((bot) => ({ id: bot.id, name: bot.name, ...markOf(bot) }))
  },
  component: NewBotRoute,
})

function NewBotRoute() {
  const runtime = useRuntime()
  const navigate = useNavigate()
  const router = useRouter()
  const archived = Route.useLoaderData()

  const [name, setName] = useState("")
  const [shape, setShape] = useState<BotShape>("circle")
  const [tone, setTone] = useState<BotTone>(1)
  const [creating, setCreating] = useState(false)

  const createBot = async () => {
    setCreating(true)
    try {
      const receipt = await runtime.commands.createBot({
        name: name.trim(),
        model: DEFAULT_MODEL,
        avatar: `${shape}:${tone}`,
      })
      // The bot arrives on the fleet stream; the receipt only tells us which id
      // to open so the user lands in the conversation they just created.
      const opened = receipt.resourceId
        ? await runtime.commands.openThread([receipt.resourceId as BotId])
        : null
      setName("")
      await (opened?.resourceId
        ? navigate({ to: "/chat/$threadId", params: { threadId: opened.resourceId as ThreadId } })
        : navigate({ to: "/" }))
    } finally {
      setCreating(false)
    }
  }

  return (
    <NewBotScreen
      name={name}
      onNameChange={setName}
      shape={shape}
      tone={tone}
      onShapeChange={setShape}
      onToneChange={setTone}
      onCreate={() => void createBot()}
      onPickSuggestion={(suggestion) => {
        setName(suggestion.name)
        setShape(suggestion.shape)
        setTone(suggestion.tone)
      }}
      creating={creating}
      archived={archived}
      onRestore={(botId) =>
        void runtime.commands.unarchiveBot(botId).then(() => router.invalidate())
      }
    />
  )
}

/** The model a new bot starts on. Changeable per bot the moment it exists. */
const DEFAULT_MODEL = "anthropic/claude-opus-4.8"
