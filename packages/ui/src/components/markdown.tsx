import { memo, useMemo } from "react"
import { useSmoothText } from "@evie/ui/lib/smooth-text"
import { cn } from "@evie/ui/lib/utils"

/**
 * Assistant prose.
 *
 * A deliberately small Markdown subset -- paragraphs, fenced code, lists,
 * headings, inline code, bold, italic, links -- rendered as memoized blocks.
 *
 * Why not a library: the perf budget says a streaming reply re-parses only its
 * final block. Every general-purpose Markdown parser takes the whole string and
 * hands back the whole tree, so a 4 KB reply arriving in 200 deltas parses
 * 400 KB of text and rebuilds 200 trees. Splitting on blank lines first and
 * memoizing each block by its own content makes the steady-state cost the size
 * of the paragraph being written, not the size of the message.
 *
 * The subset is the whole feature, not a first pass. If a model emits a table
 * we show the pipes; that is a worse table and a better product than shipping a
 * parser we re-profile every release.
 */

type Block =
  | { readonly kind: "p"; readonly text: string }
  | { readonly kind: "code"; readonly lang: string; readonly text: string }
  | { readonly kind: "ul"; readonly items: readonly string[] }
  | { readonly kind: "ol"; readonly items: readonly string[] }
  | { readonly kind: "h"; readonly level: 1 | 2 | 3; readonly text: string }

const splitBlocks = (source: string): Block[] => {
  const blocks: Block[] = []
  const lines = source.split("\n")
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!

    if (line.trim() === "") {
      i++
      continue
    }

    // Fenced code. An unterminated fence runs to the end, which is what a
    // half-streamed code block is -- closing it ourselves would reflow the
    // whole block the moment the real fence arrives.
    const fence = /^```(\w*)\s*$/.exec(line.trim())
    if (fence) {
      const lang = fence[1] ?? ""
      const body: string[] = []
      i++
      while (i < lines.length && lines[i]!.trim() !== "```") {
        body.push(lines[i]!)
        i++
      }
      i++
      blocks.push({ kind: "code", lang, text: body.join("\n") })
      continue
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push({ kind: "h", level: heading[1]!.length as 1 | 2 | 3, text: heading[2]! })
      i++
      continue
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*[-*]\s+/, ""))
        i++
      }
      blocks.push({ kind: "ul", items })
      continue
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*\d+[.)]\s+/, ""))
        i++
      }
      blocks.push({ kind: "ol", items })
      continue
    }

    const para: string[] = []
    while (i < lines.length && lines[i]!.trim() !== "" && !/^(```|#{1,3}\s|\s*[-*]\s|\s*\d+[.)]\s)/.test(lines[i]!)) {
      para.push(lines[i]!)
      i++
    }
    blocks.push({ kind: "p", text: para.join("\n") })
  }

  return blocks
}

/** `**bold**`, `*em*`, `` `code` ``, `[text](url)`. One pass, no nesting. */
const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]+\]\((https?:\/\/[^\s)]+)\))/g

function inline(text: string): React.ReactNode {
  const out: React.ReactNode[] = []
  let last = 0
  let match: RegExpExecArray | null
  INLINE.lastIndex = 0

  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index))
    const token = match[0]
    const key = `${match.index}`

    if (token.startsWith("`")) {
      out.push(
        <code key={key} className="rounded-[4px] bg-raised-strong px-1 py-px font-mono text-[0.9em]">
          {token.slice(1, -1)}
        </code>,
      )
    } else if (token.startsWith("**")) {
      out.push(
        <strong key={key} className="font-semibold">
          {token.slice(2, -2)}
        </strong>,
      )
    } else if (token.startsWith("*")) {
      out.push(<em key={key}>{token.slice(1, -1)}</em>)
    } else {
      const label = /\[([^\]]+)\]/.exec(token)?.[1] ?? token
      out.push(
        <a
          key={key}
          href={match[5]}
          target="_blank"
          rel="noreferrer noopener"
          className="text-link underline underline-offset-2"
        >
          {label}
        </a>,
      )
    }
    last = match.index + token.length
  }

  if (last < text.length) out.push(text.slice(last))
  return out
}

/**
 * One block. Memoized on its own text, so a delta landing in the last paragraph
 * leaves every earlier block referentially identical and React skips them.
 */
const BlockView = memo(function BlockView({ block }: { readonly block: Block }) {
  switch (block.kind) {
    case "p":
      return <p className="text-body whitespace-pre-wrap">{inline(block.text)}</p>
    case "h":
      return (
        <p
          className={cn(
            "font-medium text-fg",
            block.level === 1 ? "text-subsection" : block.level === 2 ? "text-lede" : "text-body",
          )}
        >
          {inline(block.text)}
        </p>
      )
    case "ul":
      return (
        <ul className="flex list-disc flex-col gap-1 pl-5 text-body">
          {block.items.map((item, i) => (
            <li key={i}>{inline(item)}</li>
          ))}
        </ul>
      )
    case "ol":
      return (
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-body">
          {block.items.map((item, i) => (
            <li key={i}>{inline(item)}</li>
          ))}
        </ol>
      )
    case "code":
      return (
        <pre className="overflow-x-auto rounded-default bg-raised-strong px-3 py-2.5">
          <code className="font-mono text-metadata whitespace-pre">{block.text}</code>
        </pre>
      )
  }
})

export const Markdown = memo(function Markdown({
  source,
  streaming = false,
}: {
  readonly source: string
  /**
   * Set while `source` is receiving deltas. Paces the reveal so the 50 ms
   * lumps the wire delivers read as writing; see `lib/smooth-text.ts`. Costs
   * nothing when false, which is every row but one.
   */
  readonly streaming?: boolean
}) {
  const visible = useSmoothText(source, streaming)
  const blocks = useMemo(() => splitBlocks(visible), [visible])
  return (
    <div className="flex flex-col gap-4">
      {blocks.map((block, i) => (
        // Index as key is correct here and only here: blocks are positional and
        // a streaming message only ever grows at the end, so index IS identity.
        <BlockView key={i} block={block} />
      ))}
    </div>
  )
})
