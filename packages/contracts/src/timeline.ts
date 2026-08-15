import { Schema } from "effect"
import { BlobId, BotId, Millis, SessionId, ThreadId, UserId } from "./ids.ts"
import { ThreadStatus } from "./thread.ts"

/**
 * The projected model the UI renders. Deliberately flatter than eve's stream.
 *
 * Three invariants hold here and are worth defending in review:
 *
 * 1. A tool call is a first-class item, not a message part. It has its own row,
 *    its own lifecycle, and its own expansion state, so collapsing tools is a
 *    list operation rather than a re-parse.
 * 2. Reasoning carries a count, and sometimes a body. The count persists so the
 *    UI can say *thought for 4.2k tokens* months later; the body exists only in
 *    flight. `text` is optional rather than the row carrying `collapsed: true`,
 *    because expansion is client state and a field that can only ever hold one
 *    value is a field that will be lied to later.
 * 3. An `auth` row names its subject. `forUserId` is what lets the client show
 *    an actionable button to Ana and an inert "waiting for Ana" row to everyone
 *    else. Without it on the wire that distinction cannot be made.
 */

/** Arbitrary tool input/output. Closing this union would mean shipping Evie to add a tool. */
const Json = Schema.Unknown

export const FinishReason = Schema.Literals([
  "stop",
  "length",
  "tool-calls",
  "content-filter",
  "error",
  "other",
])
export type FinishReason = typeof FinishReason.Type

export const TextPart = Schema.Struct({
  type: Schema.tag("text"),
  text: Schema.String,
})

export const ReasoningPart = Schema.Struct({
  type: Schema.tag("reasoning"),
  tokens: Schema.Int,
  /**
   * Present only while the turn is live and only for a client that opted into
   * this block. Never persisted, so a reopened thread always decodes to the
   * count alone -- and the row has to say so plainly rather than spinning
   * forever on a fetch that can never resolve.
   */
  text: Schema.optional(Schema.String),
})

export const FilePart = Schema.Struct({
  type: Schema.tag("file"),
  mediaType: Schema.String,
  filename: Schema.optional(Schema.String),
  size: Schema.optional(Schema.Int),
  blobId: Schema.optional(BlobId),
})

export const Part = Schema.Union([TextPart, ReasoningPart, FilePart])
export type Part = typeof Part.Type

export const ToolState = Schema.Literals(["pending", "running", "ok", "error", "cancelled"])
export type ToolState = typeof ToolState.Type

export const InputState = Schema.Literals(["pending", "answered", "cancelled", "expired"])
export type InputState = typeof InputState.Type

export const AuthState = Schema.Literals(["pending", "completed", "failed", "cancelled"])
export type AuthState = typeof AuthState.Type

export const SubagentState = Schema.Literals(["running", "completed", "failed"])
export type SubagentState = typeof SubagentState.Type

export const InputOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  /** The keyboard letter the design puts in a bordered square: A, B, C, D. */
  hotkey: Schema.optional(Schema.String),
  /** Approvals colour their destructive branch; plain questions do not. */
  tone: Schema.optional(Schema.Literals(["default", "primary", "danger"])),
})
export type InputOption = typeof InputOption.Type

/** Fields every variant carries. Spelled once, spread into each. */
const base = {
  id: Schema.String,
  threadId: ThreadId,
  /** Monotonic within the thread. The paging key, and the store's index key. */
  seq: Schema.Int,
  at: Millis,
} as const

export const UserItem = Schema.Struct({
  kind: Schema.tag("user"),
  ...base,
  authorId: UserId,
  parts: Schema.Array(Part),
})

/**
 * The provider's own turn reference, as it appears on the provider's stream.
 *
 * NOT `TurnId`. Evie's `TurnId` is a ULID it mints when it dispatches a turn;
 * eve numbers its turns `turn_1`, `turn_2`, and the two are different
 * identifiers for related things. Typing this as `TurnId` type-checked -- the
 * projector cast to it -- and then threw at the schema boundary on every
 * assistant message, which rolled back the ingest transaction, left the stream
 * cursor unadvanced, and silently discarded every reply the bot ever produced.
 *
 * It is only ever compared against other provider ids (grouping a turn's rows,
 * sweeping them on `turn.cancelled`), so an opaque string is the honest type.
 */
export const ProviderTurnRef = Schema.String
export type ProviderTurnRef = typeof ProviderTurnRef.Type

export const AssistantItem = Schema.Struct({
  kind: Schema.tag("assistant"),
  ...base,
  botId: BotId,
  turnId: ProviderTurnRef,
  parts: Schema.Array(Part),
  /** Distinguishes narration from a terminal reply. Absent while streaming. */
  finishReason: Schema.optional(FinishReason),
})

export const ToolItem = Schema.Struct({
  kind: Schema.tag("tool"),
  ...base,
  botId: BotId,
  turnId: ProviderTurnRef,
  callId: Schema.String,
  name: Schema.String,
  state: ToolState,
  input: Schema.optional(Json),
  output: Schema.optional(Json),
  /**
   * Set when the payload exceeded 8 KiB. `input`/`output` then hold the first
   * and last 2 KiB and the client fetches the rest on expand -- `blobs.grant`
   * then `GET /blob/:id`. Bytes never cross the RPC socket.
   */
  blobId: Schema.optional(BlobId),
  truncated: Schema.optional(Schema.Boolean),
  durationMs: Schema.optional(Schema.Int),
})

export const InputItem = Schema.Struct({
  kind: Schema.tag("input"),
  ...base,
  botId: BotId,
  requestId: Schema.String,
  prompt: Schema.String,
  options: Schema.optional(Schema.Array(InputOption)),
  /**
   * The tool this request is gating, when it is gating one.
   *
   * Present so the card can name what an "always allow" would grant -- a
   * session-long approval for an unnamed action is not a decision anyone can
   * make. It is also the key the grant is stored under, so the two cannot
   * describe different things.
   */
  toolName: Schema.optional(Schema.String),
  allowFreeform: Schema.Boolean,
  state: InputState,
  /** Which option won, once answered. Keeps the resolved card readable. */
  answeredWith: Schema.optional(Schema.String),
  answeredBy: Schema.optional(UserId),
})

export const AuthItem = Schema.Struct({
  kind: Schema.tag("auth"),
  ...base,
  botId: BotId,
  /** The member this card is for. Everyone else sees a quiet waiting row. */
  forUserId: UserId,
  displayName: Schema.String,
  url: Schema.optional(Schema.String),
  userCode: Schema.optional(Schema.String),
  state: AuthState,
})

export const SubagentItem = Schema.Struct({
  kind: Schema.tag("subagent"),
  ...base,
  botId: BotId,
  childSessionId: SessionId,
  name: Schema.String,
  state: SubagentState,
})

export const SystemItem = Schema.Struct({
  kind: Schema.tag("system"),
  ...base,
  event: Schema.Literals(["compacted", "cleared", "checkpoint", "restored", "budgetReached"]),
  detail: Schema.optional(Schema.String),
})

export const ErrorItem = Schema.Struct({
  kind: Schema.tag("error"),
  ...base,
  code: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean,
})

export const TimelineItem = Schema.Union([
  UserItem,
  AssistantItem,
  ToolItem,
  InputItem,
  AuthItem,
  SubagentItem,
  SystemItem,
  ErrorItem,
])
export type TimelineItem = typeof TimelineItem.Type

/* ---------------------------------------------------------------------------
 * Frames
 *
 * The wire never carries a rebuilt timeline. It carries operations against one
 * the client already holds, batched at most once per 50 ms per subscriber.
 * eve's raw stream re-sends the cumulative text on every delta; forwarding that
 * verbatim is the single easiest way to make Evie feel slow.
 * ------------------------------------------------------------------------- */

export const TimelineOp = Schema.Union([
  /** A row the client has not seen. Carries the whole item once. */
  Schema.Struct({ op: Schema.tag("insert"), item: TimelineItem }),
  /**
   * The hot path. `chunk` is the suffix since the last frame, never the
   * cumulative text: a 4 KB reply streamed cumulatively is ~800 KB on the wire,
   * and the budget is 40 KB/s for the whole turn.
   */
  Schema.Struct({
    op: Schema.tag("appendText"),
    id: Schema.String,
    partIndex: Schema.Int,
    chunk: Schema.String,
  }),
  /**
   * Reasoning always advances the count; `chunk` rides along only for a client
   * that expanded this block on a live turn. Decision 011.
   */
  Schema.Struct({
    op: Schema.tag("appendReasoning"),
    id: Schema.String,
    partIndex: Schema.Int,
    tokens: Schema.Int,
    chunk: Schema.optional(Schema.String),
  }),
  /**
   * State transitions on small rows -- a tool finishing, an approval answered.
   * A field-level patch would need a partial schema per variant to buy nothing:
   * these rows are small, and swapping the object gives the store exactly the
   * identity change it needs to re-render one row and no others.
   */
  Schema.Struct({ op: Schema.tag("replace"), item: TimelineItem }),
])
export type TimelineOp = typeof TimelineOp.Type

export const TimelineFrame = Schema.Struct({
  threadId: ThreadId,
  ops: Schema.Array(TimelineOp),
  /** Coalesced: only the last status in the window is sent, never the path taken. */
  status: Schema.optional(ThreadStatus),
  /** Highest `seq` included. The client resumes from here after a reconnect. */
  seq: Schema.Int,
  /**
   * `summary` means this subscriber overflowed three consecutive windows and is
   * now getting turn boundaries only. Saying so is the difference between a
   * *catching up* chip and a thread that looks frozen.
   */
  mode: Schema.Literals(["full", "summary"]),
})
export type TimelineFrame = typeof TimelineFrame.Type
