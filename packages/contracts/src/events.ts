import { Schema } from "effect"
import { NetworkPolicy, SandboxBackend } from "./bot.ts"
import {
  BotId,
  ConnectionId,
  EventId,
  Millis,
  OrgId,
  RoutineId,
  SessionId,
  TeamId,
  ThreadId,
  TurnId,
  UserId,
} from "./ids.ts"
import { MemberRole } from "./org.ts"

/**
 * The event log.
 *
 * **Evie's log is not a second source of truth for agent execution.** eve owns
 * that -- durably, at step granularity, across process restarts. This log holds
 * two things and nothing else:
 *
 *   - product events the user caused (`BotCreated`, `RoutineEnabled`), and
 *   - a mirror of eve stream events, kept so a client can render a thread
 *     offline and so we can reconnect a stream from a cursor.
 *
 * Never treat the mirror as authoritative for whether work happened. Ask eve.
 */

/* --- product events ------------------------------------------------------ */

export const BotCreated = Schema.TaggedStruct("BotCreated", {
  botId: BotId,
  slug: Schema.String,
  name: Schema.String,
  teamId: Schema.NullOr(TeamId),
  model: Schema.String,
  /**
   * The face the user picked, as `"<shape>:<tone>"`. Carried on the event
   * because the projection is the only thing that can store it and the command
   * is the only thing that knows it -- leaving it off meant the new-bot
   * picker's entire purpose was discarded the moment the bot was created.
   */
  avatar: Schema.NullOr(Schema.String),
  reasoning: Schema.NullOr(Schema.String),
})
export const BotRenamed = Schema.TaggedStruct("BotRenamed", {
  botId: BotId,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
})
export const BotMovedToTeam = Schema.TaggedStruct("BotMovedToTeam", {
  botId: BotId,
  teamId: Schema.NullOr(TeamId),
})
export const BotArchived = Schema.TaggedStruct("BotArchived", { botId: BotId })
export const BotUnarchived = Schema.TaggedStruct("BotUnarchived", { botId: BotId })
export const ModelChanged = Schema.TaggedStruct("ModelChanged", {
  botId: BotId,
  model: Schema.String,
  reasoning: Schema.NullOr(Schema.String),
})
export const SandboxBackendChanged = Schema.TaggedStruct("SandboxBackendChanged", {
  botId: BotId,
  backend: SandboxBackend,
})
export const NetworkPolicyChanged = Schema.TaggedStruct("NetworkPolicyChanged", {
  botId: BotId,
  policy: NetworkPolicy,
})
/**
 * Carries the text. The instructions are a bot-level record the user typed, and
 * the reactor that writes `agent/instructions.md` has no other way to see them
 * -- a content-free event meant the command succeeded and the text was dropped.
 */
export const InstructionsChanged = Schema.TaggedStruct("InstructionsChanged", {
  botId: BotId,
  instructions: Schema.String,
})

export const ThreadOpened = Schema.TaggedStruct("ThreadOpened", {
  threadId: ThreadId,
  participants: Schema.Array(BotId),
  title: Schema.NullOr(Schema.String),
})
export const ParticipantAdded = Schema.TaggedStruct("ParticipantAdded", {
  threadId: ThreadId,
  botId: BotId,
})
export const ParticipantRemoved = Schema.TaggedStruct("ParticipantRemoved", {
  threadId: ThreadId,
  botId: BotId,
})
export const MessageSent = Schema.TaggedStruct("MessageSent", {
  threadId: ThreadId,
  text: Schema.String,
  mentions: Schema.Array(BotId),
  attachments: Schema.Array(Schema.String),
  idempotencyKey: Schema.String,
})
export const TurnCancelRequested = Schema.TaggedStruct("TurnCancelRequested", {
  threadId: ThreadId,
  turnId: TurnId,
})
export const InputAnswered = Schema.TaggedStruct("InputAnswered", {
  threadId: ThreadId,
  requestId: Schema.String,
  optionId: Schema.NullOr(Schema.String),
  scope: Schema.NullOr(Schema.String),
})
export const ThreadSnoozed = Schema.TaggedStruct("ThreadSnoozed", {
  threadId: ThreadId,
  until: Millis,
})
export const ThreadUnsnoozed = Schema.TaggedStruct("ThreadUnsnoozed", { threadId: ThreadId })
export const ThreadArchived = Schema.TaggedStruct("ThreadArchived", { threadId: ThreadId })
export const ThreadUnarchived = Schema.TaggedStruct("ThreadUnarchived", { threadId: ThreadId })
export const ThreadRenamed = Schema.TaggedStruct("ThreadRenamed", {
  threadId: ThreadId,
  title: Schema.NullOr(Schema.String),
})
/** A reactor calls eve's compact endpoint when it sees this; the visible row comes from the mirror. */
export const SessionCompactRequested = Schema.TaggedStruct("SessionCompactRequested", {
  threadId: ThreadId,
  botId: BotId,
})
export const SessionClearRequested = Schema.TaggedStruct("SessionClearRequested", {
  threadId: ThreadId,
  botId: BotId,
})
export const CheckpointRestoreRequested = Schema.TaggedStruct("CheckpointRestoreRequested", {
  threadId: ThreadId,
  checkpointId: Schema.String,
})

export const RoutineCreated = Schema.TaggedStruct("RoutineCreated", {
  routineId: RoutineId,
  botId: BotId,
  name: Schema.String,
  cron: Schema.String,
  tz: Schema.String,
  prompt: Schema.String,
  /** Deliver into an existing thread, or null for a new one per run. */
  threadId: Schema.NullOr(ThreadId),
  runAs: Schema.NullOr(UserId),
})
export const RoutineEnabled = Schema.TaggedStruct("RoutineEnabled", {
  routineId: RoutineId,
  botId: BotId,
  enabled: Schema.Boolean,
})
export const RoutineRunAsChanged = Schema.TaggedStruct("RoutineRunAsChanged", {
  routineId: RoutineId,
  botId: BotId,
  runAs: Schema.NullOr(UserId),
})
export const RoutineBlocked = Schema.TaggedStruct("RoutineBlocked", {
  routineId: RoutineId,
  botId: BotId,
  reason: Schema.String,
})
export const RoutineDeleted = Schema.TaggedStruct("RoutineDeleted", {
  routineId: RoutineId,
  botId: BotId,
})

export const ServiceConnected = Schema.TaggedStruct("ServiceConnected", {
  botId: BotId,
  connectionId: ConnectionId,
  name: Schema.String,
  kind: Schema.String,
  scope: Schema.String,
  /** url/spec, filters, approval policy. Never a credential -- those live in `secret`. */
  config: Schema.Unknown,
  authKind: Schema.Literals(["none", "token", "interactive"]),
})
export const ServiceDisconnected = Schema.TaggedStruct("ServiceDisconnected", {
  botId: BotId,
  connectionId: ConnectionId,
})
export const GrantLinked = Schema.TaggedStruct("GrantLinked", {
  botId: BotId,
  connectionId: ConnectionId,
  userId: Schema.NullOr(UserId),
})
export const GrantRevoked = Schema.TaggedStruct("GrantRevoked", {
  botId: BotId,
  connectionId: ConnectionId,
  userId: Schema.NullOr(UserId),
})

/** Names only. A secret's value is never in the event log, not even encrypted. */
export const SecretSet = Schema.TaggedStruct("SecretSet", {
  scope: Schema.String,
  name: Schema.String,
  hint: Schema.String,
})
export const SecretRemoved = Schema.TaggedStruct("SecretRemoved", {
  scope: Schema.String,
  name: Schema.String,
})

export const MemberInvited = Schema.TaggedStruct("MemberInvited", {
  invitationId: Schema.String,
  email: Schema.String,
  role: MemberRole,
})
export const InvitationRevoked = Schema.TaggedStruct("InvitationRevoked", {
  invitationId: Schema.String,
})
export const MemberRoleChanged = Schema.TaggedStruct("MemberRoleChanged", {
  userId: UserId,
  role: MemberRole,
})
export const MemberRemoved = Schema.TaggedStruct("MemberRemoved", { userId: UserId })
export const TeamCreated = Schema.TaggedStruct("TeamCreated", { teamId: TeamId, name: Schema.String })
export const TeamDeleted = Schema.TaggedStruct("TeamDeleted", { teamId: TeamId })

/* --- receipts ------------------------------------------------------------ */

/**
 * Reactors emit these when a milestone lands. **Tests wait on receipts.** No
 * test sleeps and no test polls -- a test that needs a timeout to pass is
 * testing the timeout.
 */
export const TurnDispatched = Schema.TaggedStruct("TurnDispatched", {
  threadId: ThreadId,
  botId: BotId,
  turnId: TurnId,
  sessionId: SessionId,
  /** Whose identity the per-turn JWT carried. Every turn is attributed. */
  actingAs: UserId,
})
export const TurnSettled = Schema.TaggedStruct("TurnSettled", {
  threadId: ThreadId,
  botId: BotId,
  turnId: TurnId,
  outcome: Schema.Literals(["completed", "cancelled", "failed"]),
})
export const RoutineFired = Schema.TaggedStruct("RoutineFired", {
  routineId: RoutineId,
  botId: BotId,
  threadId: ThreadId,
})
export const CheckpointWritten = Schema.TaggedStruct("CheckpointWritten", {
  threadId: ThreadId,
  turnId: TurnId,
  sha: Schema.String,
})
export const NotificationDelivered = Schema.TaggedStruct("NotificationDelivered", {
  /** Null for notifications about a routine with no delivery thread. */
  threadId: Schema.NullOr(ThreadId),
  userId: UserId,
  reason: Schema.Literals(["turnCompleted", "inputRequested", "routineBlocked"]),
})
export const RuntimeReady = Schema.TaggedStruct("RuntimeReady", {
  botId: BotId,
  /** Loopback only, ephemeral, never logged. Present so the adapter can dial it. */
  port: Schema.Int,
})
export const RuntimeStopped = Schema.TaggedStruct("RuntimeStopped", {
  botId: BotId,
  reason: Schema.Literals(["idle", "crash", "shutdown", "restart"]),
})

/**
 * Provisioning receipts from the supervisor. `BotCreated` folds to
 * `health: starting`; one of these settles it -- `idle` when the project is on
 * disk and installed, `unhealthy` (with the failing step and output tail) when
 * scaffolding failed. Without them a failed scaffold is a bot that looks fine
 * and never answers.
 */
export const BotProvisioned = Schema.TaggedStruct("BotProvisioned", { botId: BotId })
export const BotProvisionFailed = Schema.TaggedStruct("BotProvisionFailed", {
  botId: BotId,
  /** The scaffold step that failed ("install", "git-init"), shown on the health chip. */
  reason: Schema.String,
  /** Tail of the failing step's output, capped by the appender. */
  stderr: Schema.Array(Schema.String),
})

/**
 * The mirror of an eve stream event.
 *
 * Kept as an opaque payload on purpose. eve owns the shape, the adapter is the
 * only module that understands it, and re-declaring it here would make every
 * eve release a change to Evie's wire contract.
 */
export const EveMirrored = Schema.TaggedStruct("EveMirrored", {
  threadId: ThreadId,
  botId: BotId,
  sessionId: SessionId,
  /** Absolute position in eve's stream. The resume cursor. */
  streamIndex: Schema.Int,
  eveType: Schema.String,
  payload: Schema.Unknown,
})

export const EvieEvent = Schema.Union([
  BotCreated,
  BotRenamed,
  BotMovedToTeam,
  BotArchived,
  BotUnarchived,
  ModelChanged,
  SandboxBackendChanged,
  NetworkPolicyChanged,
  InstructionsChanged,
  ThreadOpened,
  ParticipantAdded,
  ParticipantRemoved,
  MessageSent,
  TurnCancelRequested,
  InputAnswered,
  ThreadSnoozed,
  ThreadUnsnoozed,
  ThreadArchived,
  ThreadUnarchived,
  ThreadRenamed,
  SessionCompactRequested,
  SessionClearRequested,
  CheckpointRestoreRequested,
  RoutineCreated,
  RoutineEnabled,
  RoutineRunAsChanged,
  RoutineBlocked,
  RoutineDeleted,
  ServiceConnected,
  ServiceDisconnected,
  GrantLinked,
  GrantRevoked,
  SecretSet,
  SecretRemoved,
  MemberInvited,
  InvitationRevoked,
  MemberRoleChanged,
  MemberRemoved,
  TeamCreated,
  TeamDeleted,
  TurnDispatched,
  TurnSettled,
  RoutineFired,
  CheckpointWritten,
  NotificationDelivered,
  RuntimeReady,
  RuntimeStopped,
  BotProvisioned,
  BotProvisionFailed,
  EveMirrored,
])
export type EvieEvent = typeof EvieEvent.Type

/**
 * An event as it sits in the log.
 *
 * The primary key is `(sessionId, id)`, not `id`. `id` is a ULID minted by a
 * runtime we supervise but do not control, and mirror rows are inserted
 * `on conflict do nothing` -- so a bare global key would turn any collision
 * into an event silently disappearing. Scoping it to the session that produced
 * it makes a collision impossible between bots and merely idempotent within one.
 *
 * `seq` is process-wide monotonic and **not contiguous**: a duplicate that
 * loses to `do nothing` consumes a seq and leaves a gap. Reactors read
 * `where seq > last_seq order by seq` and must never wait for a specific value.
 */
export const StoredEvent = Schema.Struct({
  id: EventId,
  /** Empty string for Evie's own product events. */
  sessionId: Schema.String,
  seq: Schema.Int,
  orgId: OrgId,
  threadId: Schema.NullOr(ThreadId),
  botId: Schema.NullOr(BotId),
  /** The member this turn acted as. Null for system events. Attribution is per-member. */
  actorUserId: Schema.NullOr(UserId),
  streamIndex: Schema.NullOr(Schema.Int),
  data: EvieEvent,
  at: Millis,
})
export type StoredEvent = typeof StoredEvent.Type

/** Every reactor is a durable subscription over this log, not a queue listener. */
export const ReactorName = Schema.Literals([
  "projector",
  "turn",
  "routine",
  "checkpoint",
  "notify",
  "supervisor",
])
export type ReactorName = typeof ReactorName.Type
