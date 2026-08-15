import { useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import type { BotId, ThreadId } from "@evie/contracts/ids"
import type { BotShape, BotTone } from "@evie/ui/components/bot-mark"
import { useRuntime } from "~/lib/runtime.ts"
import { NewBotScreen } from "~/screens/new-bot.tsx"

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
  component: NewBotRoute,
})

function NewBotRoute() {
  const runtime = useRuntime()
  const navigate = useNavigate()

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
    />
  )
}

/** The model a new bot starts on. Changeable per bot the moment it exists. */
const DEFAULT_MODEL = "anthropic/claude-opus-4.8"
