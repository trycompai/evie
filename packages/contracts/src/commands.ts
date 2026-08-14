import { Schema } from "effect"
import { CreateBotInput, ModelRef, NetworkPolicy, ReasoningEffort, SandboxBackend } from "./bot.ts"
import {
  BlobId,
  BotId,
  ConnectionId,
  Millis,
  RoutineId,
  TeamId,
  ThreadId,
  TurnId,
  UserId,
} from "./ids.ts"
import { MemberRole } from "./org.ts"

/**
 * The client's entire vocabulary.
 *
 * Note the pairs. `AGENTS.md`'s reverse-state rule is enforced here rather than
 * remembered later: a one-way door does not get a command. Invite has revoke,
 * snooze has unsnooze, archive has unarchive, link has unlink, promote has
 * demote. If you add a command and cannot name its inverse, you are adding a
 * bug with a nice label on it.
 *
 * Every command names exactly one **aggregate** -- a bot, a thread, or the
 * organization. `aggregateOf` below is the single place that mapping lives,
 * because it decides what serializes against what.
 */

/* --- bots ---------------------------------------------------------------- */

export const CreateBot = Schema.TaggedStruct("CreateBot", { input: CreateBotInput })
export const RenameBot = Schema.TaggedStruct("RenameBot", {
  botId: BotId,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
})
export const MoveBotToTeam = Schema.TaggedStruct("MoveBotToTeam", {
  botId: BotId,
  /** Null moves it back to org-wide. The inverse is the same command. */
  teamId: Schema.NullOr(TeamId),
})
export const ArchiveBot = Schema.TaggedStruct("ArchiveBot", { botId: BotId })
export const UnarchiveBot = Schema.TaggedStruct("UnarchiveBot", { botId: BotId })
export const SetModel = Schema.TaggedStruct("SetModel", {
  botId: BotId,
  model: ModelRef,
  reasoning: Schema.optional(Schema.NullOr(ReasoningEffort)),
})
export const SetSandboxBackend = Schema.TaggedStruct("SetSandboxBackend", {
  botId: BotId,
  backend: SandboxBackend,
})
export const SetNetworkPolicy = Schema.TaggedStruct("SetNetworkPolicy", {
  botId: BotId,
  policy: NetworkPolicy,
})
export const SetInstructions = Schema.TaggedStruct("SetInstructions", {
  botId: BotId,
  instructions: Schema.String,
})

/* --- threads and turns --------------------------------------------------- */

export const OpenThread = Schema.TaggedStruct("OpenThread", {
  /** The bots in the room at creation. The first is the default participant. */
  participants: Schema.Array(BotId).check(Schema.isMinLength(1)),
  title: Schema.optional(Schema.String),
})
export const AddParticipant = Schema.TaggedStruct("AddParticipant", {
  threadId: ThreadId,
  botId: BotId,
})
export const RemoveParticipant = Schema.TaggedStruct("RemoveParticipant", {
  threadId: ThreadId,
  botId: BotId,
})
export const SendMessage = Schema.TaggedStruct("SendMessage", {
  threadId: ThreadId,
  text: Schema.String,
  /** Explicit `@mentions`. Empty means the thread's default participant. */
  mentions: Schema.Array(BotId),
  attachments: Schema.Array(BlobId),
  /**
   * Minted client-side so a retry after a dropped socket is the same message
   * rather than a second one. The decider folds on it.
   */
  idempotencyKey: Schema.String,
})
export const CancelTurn = Schema.TaggedStruct("CancelTurn", {
  threadId: ThreadId,
  turnId: TurnId,
})
export const AnswerInput = Schema.TaggedStruct("AnswerInput", {
  threadId: ThreadId,
  requestId: Schema.String,
  /** One of the offered option ids, or null when answering freeform. */
  optionId: Schema.NullOr(Schema.String),
  text: Schema.optional(Schema.String),
  /**
   * Approval scope, made explicit. `always` is a real grant for the rest of the
   * session and the card says so rather than hiding it behind a third button.
   */
  scope: Schema.optional(Schema.Literals(["once", "always", "never"])),
})
export const CompactSession = Schema.TaggedStruct("CompactSession", {
  threadId: ThreadId,
  botId: BotId,
})
export const ClearSession = Schema.TaggedStruct("ClearSession", {
  threadId: ThreadId,
  botId: BotId,
})
export const SnoozeThread = Schema.TaggedStruct("SnoozeThread", {
  threadId: ThreadId,
  until: Millis,
})
export const UnsnoozeThread = Schema.TaggedStruct("UnsnoozeThread", { threadId: ThreadId })
export const ArchiveThread = Schema.TaggedStruct("ArchiveThread", { threadId: ThreadId })
export const UnarchiveThread = Schema.TaggedStruct("UnarchiveThread", { threadId: ThreadId })
export const RenameThread = Schema.TaggedStruct("RenameThread", {
  threadId: ThreadId,
  title: Schema.NullOr(Schema.String),
})
export const RestoreCheckpoint = Schema.TaggedStruct("RestoreCheckpoint", {
  threadId: ThreadId,
  checkpointId: Schema.String,
})

/* --- routines ------------------------------------------------------------ */

export const CreateRoutine = Schema.TaggedStruct("CreateRoutine", {
  botId: BotId,
  name: Schema.String,
  /** 5-field cron. */
  cron: Schema.String,
  /**
   * IANA zone, stored per routine and never inherited from the host. A laptop
   * that crosses a timezone would otherwise silently shift every schedule --
   * the kind of bug nobody reports and everybody stops trusting.
   */
  tz: Schema.String,
  prompt: Schema.String,
  threadId: Schema.optional(ThreadId),
  /**
   * Required once the bot has a member-scoped connection: a scheduled run has
   * no human behind it, and eve fails with `principal_required` rather than
   * silently borrowing someone's grant.
   */
  runAs: Schema.optional(UserId),
})
export const SetRoutineEnabled = Schema.TaggedStruct("SetRoutineEnabled", {
  routineId: RoutineId,
  botId: BotId,
  enabled: Schema.Boolean,
})
export const SetRoutineRunAs = Schema.TaggedStruct("SetRoutineRunAs", {
  routineId: RoutineId,
  botId: BotId,
  runAs: Schema.NullOr(UserId),
})
export const DeleteRoutine = Schema.TaggedStruct("DeleteRoutine", {
  routineId: RoutineId,
  botId: BotId,
})

/* --- connections --------------------------------------------------------- */

export const ConnectService = Schema.TaggedStruct("ConnectService", {
  botId: BotId,
  /** Becomes `agent/connections/<name>.ts`. */
  name: Schema.String,
  kind: Schema.Literals(["mcp", "openapi"]),
  /** `org` is one shared credential; `member` resolves each person's own account. */
  scope: Schema.Literals(["org", "member"]),
  config: Schema.Unknown,
  authKind: Schema.Literals(["none", "token", "interactive"]),
})
export const DisconnectService = Schema.TaggedStruct("DisconnectService", {
  botId: BotId,
  connectionId: ConnectionId,
})
/** A member authorizing their own account. The one connection write `member` holds. */
export const LinkMyGrant = Schema.TaggedStruct("LinkMyGrant", {
  botId: BotId,
  connectionId: ConnectionId,
  /** Present for static-token connections; interactive OAuth arrives by callback. */
  token: Schema.optional(Schema.String),
})
export const RevokeGrant = Schema.TaggedStruct("RevokeGrant", {
  botId: BotId,
  connectionId: ConnectionId,
  /** Null revokes the caller's own. An admin may revoke another's; never read it. */
  userId: Schema.NullOr(UserId),
})

/* --- secrets ------------------------------------------------------------- */

export const SetSecret = Schema.TaggedStruct("SetSecret", {
  scope: Schema.Literals(["org", "bot", "user"]),
  botId: Schema.optional(BotId),
  name: Schema.String,
  value: Schema.String,
})
export const RemoveSecret = Schema.TaggedStruct("RemoveSecret", {
  scope: Schema.Literals(["org", "bot", "user"]),
  botId: Schema.optional(BotId),
  name: Schema.String,
})

/* --- organization -------------------------------------------------------- */

/**
 * These delegate to Better Auth rather than the decider, and still go through
 * the same RPC middleware as every other command -- that middleware is where
 * `hasPermission` runs and where the active organization is read from the
 * session instead of the payload. An org mutation that bypasses it is an org
 * mutation nobody authorized.
 */
export const InviteMember = Schema.TaggedStruct("InviteMember", {
  email: Schema.String,
  role: MemberRole,
  teamId: Schema.optional(TeamId),
})
export const RevokeInvitation = Schema.TaggedStruct("RevokeInvitation", {
  invitationId: Schema.String,
})
export const SetMemberRole = Schema.TaggedStruct("SetMemberRole", {
  userId: UserId,
  role: MemberRole,
})
export const RemoveMember = Schema.TaggedStruct("RemoveMember", { userId: UserId })
export const CreateTeam = Schema.TaggedStruct("CreateTeam", { name: Schema.String })
export const DeleteTeam = Schema.TaggedStruct("DeleteTeam", { teamId: TeamId })
export const SetActiveOrg = Schema.TaggedStruct("SetActiveOrg", { orgId: Schema.String })

export const Command = Schema.Union([
  CreateBot,
  RenameBot,
  MoveBotToTeam,
  ArchiveBot,
  UnarchiveBot,
  SetModel,
  SetSandboxBackend,
  SetNetworkPolicy,
  SetInstructions,
  OpenThread,
  AddParticipant,
  RemoveParticipant,
  SendMessage,
  CancelTurn,
  AnswerInput,
  CompactSession,
  ClearSession,
  SnoozeThread,
  UnsnoozeThread,
  ArchiveThread,
  UnarchiveThread,
  RenameThread,
  RestoreCheckpoint,
  CreateRoutine,
  SetRoutineEnabled,
  SetRoutineRunAs,
  DeleteRoutine,
  ConnectService,
  DisconnectService,
  LinkMyGrant,
  RevokeGrant,
  SetSecret,
  RemoveSecret,
  InviteMember,
  RevokeInvitation,
  SetMemberRole,
  RemoveMember,
  CreateTeam,
  DeleteTeam,
  SetActiveOrg,
])
export type Command = typeof Command.Type

/**
 * Which aggregate a command locks.
 *
 * The aggregate is a bot or a thread, never the whole organization: loading
 * whole-org state to rename one bot would not survive an org with a few hundred
 * bots, and it would make every command contend with every other one.
 *
 * Routines and connections fold into their owning bot rather than being their
 * own aggregate -- they are edited through the bot's settings and never in
 * isolation, so a separate lock would buy contention without independence.
 *
 * Commands that *create* a thing name the organization, because the aggregate
 * they would otherwise name does not exist yet. That is the one case where
 * org-level serialization is correct rather than lazy, and it is also where the
 * uniqueness checks live.
 */
export type AggregateRef =
  | { readonly kind: "bot"; readonly id: string }
  | { readonly kind: "thread"; readonly id: string }
  | { readonly kind: "org" }

export const aggregateOf = (command: Command): AggregateRef => {
  switch (command._tag) {
    case "RenameBot":
    case "MoveBotToTeam":
    case "ArchiveBot":
    case "UnarchiveBot":
    case "SetModel":
    case "SetSandboxBackend":
    case "SetNetworkPolicy":
    case "SetInstructions":
    case "CreateRoutine":
    case "SetRoutineEnabled":
    case "SetRoutineRunAs":
    case "DeleteRoutine":
    case "ConnectService":
    case "DisconnectService":
    case "LinkMyGrant":
    case "RevokeGrant":
      return { kind: "bot", id: command.botId }

    case "AddParticipant":
    case "RemoveParticipant":
    case "SendMessage":
    case "CancelTurn":
    case "AnswerInput":
    case "CompactSession":
    case "ClearSession":
    case "SnoozeThread":
    case "UnsnoozeThread":
    case "ArchiveThread":
    case "UnarchiveThread":
    case "RenameThread":
    case "RestoreCheckpoint":
      return { kind: "thread", id: command.threadId }

    default:
      return { kind: "org" }
  }
}

/**
 * The permission each command requires, or `null` when there is no permission
 * in the *current* organization that could gate it.
 *
 * `null` is not "allow anyone". It means the check belongs somewhere else:
 * `SetActiveOrg` targets a different organization than the one the session is
 * scoped to, so asking `hasPermission` against the current org answers the
 * wrong question entirely. The middleware must instead verify membership of
 * the org being switched to. Returning a plausible-looking statement here --
 * `bot:read`, say -- would make that check pass for the wrong reason and look
 * correct in review.
 */
export const permissionOf = (command: Command): string | null => {
  switch (command._tag) {
    case "CreateBot":
      return "bot:create"
    case "ArchiveBot":
    case "UnarchiveBot":
      return "bot:delete"
    case "RenameBot":
    case "MoveBotToTeam":
    case "SetModel":
    case "SetSandboxBackend":
    case "SetNetworkPolicy":
    case "SetInstructions":
      return "bot:update"
    case "CreateRoutine":
    case "SetRoutineEnabled":
    case "SetRoutineRunAs":
    case "DeleteRoutine":
      return "routine:manage"
    case "ConnectService":
    case "DisconnectService":
      return "connection:manage"
    case "LinkMyGrant":
    case "RevokeGrant":
      return "connection:link"
    case "SetSecret":
    case "RemoveSecret":
      return "secret:manage"
    case "InviteMember":
    case "RevokeInvitation":
    case "SetMemberRole":
    case "RemoveMember":
    case "CreateTeam":
    case "DeleteTeam":
      return "member:manage"
    case "SetActiveOrg":
      // Scoped to the TARGET org, not this one. See the note above.
      return null
    default:
      return "thread:write"
  }
}
