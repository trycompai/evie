import { Schema } from "effect"
import { BotId, Millis, OrgId, SessionId, ThreadId, TurnId, UserId } from "./ids.ts"

/**
 * A thread has participants. Each `(thread, bot)` pair owns exactly one eve
 * session, shared by every member of the organization who can see the thread.
 */
export const Participant = Schema.Struct({
  botId: BotId,
  /** Null until the first turn -- a session is created lazily, on dispatch. */
  eveSessionId: Schema.NullOr(SessionId),
  /** Absolute position in eve's stream. The resume cursor after a reconnect. */
  streamIndex: Schema.Int,
  /** The bot a bare message addresses when nobody is `@`-mentioned. */
  isDefault: Schema.Boolean,
})
export type Participant = typeof Participant.Type

/**
 * What the thread is doing, in the user's words.
 *
 * 04: "Every spinner is truthful." These variants exist so the UI never says
 * *Thinking* while a turn is parked on a person -- that is the lying spinner,
 * and it is the fastest way to teach a user to stop believing the interface.
 */
export const ThreadStatus = Schema.Union([
  /** `session.waiting`, or no turn in flight. */
  Schema.Struct({ kind: Schema.tag("ready") }),
  /**
   * `turn.started` up to the first token.
   *
   * Both in-flight states carry the turn. `CancelTurn` needs an id, and this is
   * the only place the client can learn it without scanning the timeline for
   * the last assistant row — which would be a guess, and would be wrong the
   * moment a tool row is last. Null when eve did not name a turn; the composer
   * then offers Send (which steers) rather than a Stop that cannot work.
   */
  Schema.Struct({ kind: Schema.tag("thinking"), turnId: Schema.NullOr(TurnId) }),
  /** A tool is executing. Named, because "Running bash" beats a spinner. */
  Schema.Struct({
    kind: Schema.tag("running"),
    tool: Schema.String,
    turnId: Schema.NullOr(TurnId),
  }),
  /** `input.requested`. The composer shows the card; the chip says so. */
  Schema.Struct({ kind: Schema.tag("waitingOnYou") }),
  /** `authorization.required`. Addressed -- inert for everyone but its subject. */
  Schema.Struct({ kind: Schema.tag("waitingOnSignIn"), service: Schema.String, forUserId: UserId }),
  /** Parked on a remote subagent. */
  Schema.Struct({ kind: Schema.tag("waitingOnSubagent"), name: Schema.String }),
  Schema.Struct({ kind: Schema.tag("compacting") }),
  /** The runtime is restarting. Not an error: eve resumes from its last step. */
  Schema.Struct({ kind: Schema.tag("reconnecting") }),
  /**
   * Three consecutive overflow windows downgraded this subscriber to turn
   * boundaries only. The client shows a *catching up* chip rather than
   * silently rendering a thread that has stopped moving.
   */
  Schema.Struct({ kind: Schema.tag("catchingUp") }),
])
export type ThreadStatus = typeof ThreadStatus.Type

export const Thread = Schema.Struct({
  id: ThreadId,
  orgId: OrgId,
  title: Schema.NullOr(Schema.String),
  participants: Schema.Array(Participant),
  status: ThreadStatus,
  /** Preview text for the rail. The last thing that happened, already truncated. */
  preview: Schema.NullOr(Schema.String),
  createdBy: UserId,
  createdAt: Millis,
  lastActivity: Millis,
  /** Reverse state for snooze. Non-null and in the future means snoozed. */
  snoozedUntil: Schema.NullOr(Millis),
  /** Reverse state for archive. */
  archivedAt: Schema.NullOr(Millis),
})
export type Thread = typeof Thread.Type
