import { memo } from "react"
import type { Part, TimelineItem } from "@evie/contracts/timeline"
import { ApprovalCard } from "@evie/ui/components/approval-card"
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@evie/ui/components/attachment"
import { FileIcon } from "@evie/ui/components/icon"
import { AuthorizationCard } from "@evie/ui/components/authorization-card"
import { Markdown } from "@evie/ui/components/markdown"
import { AssistantBubble, UserBubble } from "@evie/ui/components/message"
import { ReasoningRow } from "@evie/ui/components/reasoning-row"
import { ErrorRow, SystemRow } from "@evie/ui/components/system-row"
import { ToolCallRow } from "@evie/ui/components/tool-call-row"

/**
 * One row of the timeline.
 *
 * **Memoized on the item object's identity.** That is the contract with
 * `@evie/client-runtime`'s store: a delta replaces exactly one item and leaves
 * every other one referentially identical, so React reconciles the streaming
 * row and skips the other 1,999. Getting this wrong does not look like a bug --
 * it looks like the app being slow with a thread open, which is the single
 * regression class this codebase watches hardest.
 *
 * The row is presentational. It receives an item and callbacks; it never
 * touches the store. The subscription lives in `apps/web`'s row wrapper.
 */

export interface TimelineRowCallbacks {
  readonly onAnswerInput?: (requestId: string, optionId: string, scope: "once" | "always") => void
  readonly onDismissInput?: (requestId: string) => void
  readonly onWatchReasoning?: (itemId: string, watching: boolean) => void
  readonly onFetchToolPayload?: (itemId: string) => void
  readonly onRetry?: (itemId: string) => void
  readonly onFixCredentials?: () => void
}

export interface TimelineRowProps extends TimelineRowCallbacks {
  readonly item: TimelineItem
  /** The signed-in member. Decides whether an auth card is a button or a notice. */
  readonly viewerId: string
  /** Resolves a user id to a display name for attribution and auth notices. */
  readonly nameOf?: (userId: string) => string | undefined
  /** True while this item is the one receiving deltas. */
  readonly streaming?: boolean
}

function renderParts(
  parts: readonly Part[],
  itemId: string,
  live: boolean,
  onWatchReasoning?: (itemId: string, watching: boolean) => void,
) {
  return parts.map((part, i) => {
    switch (part.type) {
      case "text":
        return <Markdown key={i} source={part.text} />
      case "reasoning":
        return (
          <ReasoningRow
            key={i}
            tokens={part.tokens}
            text={part.text}
            live={live}
            onWatch={(watching) => onWatchReasoning?.(itemId, watching)}
          />
        )
      case "file":
        return (
          <Attachment key={i} size="sm">
            <AttachmentMedia>
              <FileIcon />
            </AttachmentMedia>
            <AttachmentContent>
              <AttachmentTitle>{part.filename ?? part.mediaType}</AttachmentTitle>
              {part.filename && <AttachmentDescription>{part.mediaType}</AttachmentDescription>}
            </AttachmentContent>
          </Attachment>
        )
    }
  })
}

export const TimelineRow = memo(function TimelineRow({
  item,
  viewerId,
  nameOf,
  streaming = false,
  onAnswerInput,
  onDismissInput,
  onWatchReasoning,
  onFetchToolPayload,
  onRetry,
  onFixCredentials,
}: TimelineRowProps) {
  switch (item.kind) {
    case "user":
      return (
        <UserBubble>
          {renderParts(item.parts, item.id, false, onWatchReasoning)}
        </UserBubble>
      )

    case "assistant":
      return (
        <AssistantBubble streaming={streaming}>
          {renderParts(item.parts, item.id, streaming, onWatchReasoning)}
        </AssistantBubble>
      )

    case "tool":
      return (
        <ToolCallRow
          name={item.name}
          summary={typeof item.input === "string" ? item.input : undefined}
          state={item.state}
          durationMs={item.durationMs}
          body={typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? null, null, 2)}
          truncated={item.truncated ?? false}
          onFetchFull={item.blobId ? () => onFetchToolPayload?.(item.id) : undefined}
        />
      )

    case "input":
      return (
        <ApprovalCard
          prompt={item.prompt}
          options={item.options ?? []}
          state={item.state}
          answeredWith={item.answeredWith}
          answeredBy={item.answeredBy ? nameOf?.(item.answeredBy) : undefined}
          toolName={item.toolName}
          onAnswer={(optionId, scope) => onAnswerInput?.(item.requestId, optionId, scope)}
          onDismiss={() => onDismissInput?.(item.requestId)}
        />
      )

    case "auth":
      return (
        <AuthorizationCard
          displayName={item.displayName}
          state={item.state}
          isMine={item.forUserId === viewerId}
          forName={nameOf?.(item.forUserId)}
          url={item.url}
          userCode={item.userCode}
        />
      )

    case "subagent":
      // A nested run, collapsed. The child stream attaches on expand in Phase 3;
      // until then the row is honest about being a summary rather than pretending
      // there is nothing to see.
      return (
        <p className="text-metadata text-fg-muted">
          {item.state === "running" ? `Running ${item.name}` : `${item.name} finished`}
        </p>
      )

    case "system":
      return <SystemRow event={item.event} detail={item.detail} />

    case "error":
      return (
        <ErrorRow
          message={item.message}
          retryable={item.retryable}
          onRetry={() => onRetry?.(item.id)}
          onFix={item.code === "CredentialProblem" ? onFixCredentials : undefined}
        />
      )
  }
})
