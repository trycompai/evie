import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Bot } from "./bot.ts"
import { Command } from "./commands.ts"
import { EvieError } from "./errors.ts"
import { BlobId, BotId, EventId, Millis, ThreadId, UserId } from "./ids.ts"
import { Invitation, Member, SessionInfo, Team } from "./org.ts"
import { Routine } from "./routine.ts"
import { Thread } from "./thread.ts"
import { TimelineFrame, TimelineItem } from "./timeline.ts"

/**
 * The wire.
 *
 * `RpcServer` over a WebSocket with `RpcSerialization.msgPack`. MsgPack rather
 * than JSON because the timeline is the hot path and text deltas plus tool
 * payloads dominate the byte budget.
 *
 * There is **one** command RPC rather than forty. Every command goes through
 * the same middleware -- that is where the version handshake, the actor
 * resolution, and `hasPermission` live -- and adding a command should not mean
 * adding a place those three can be forgotten. The client still gets named,
 * typed senders; they live in `@evie/client-runtime/commands` and are one line
 * each. What crosses the wire is the tagged union.
 */

/**
 * What a command returns. A receipt, never a rendered result: the change
 * arrives through the subscription the client already holds, so returning it
 * twice would mean two code paths that can disagree about what happened.
 */
export const Receipt = Schema.Struct({
  /** The event that settled this command. Tests wait on it; so does the client. */
  eventId: EventId,
  /** Post-append version of the aggregate the command named. */
  aggregateVersion: Schema.Int,
  /** Set when the command created something the caller now needs to address. */
  resourceId: Schema.optional(Schema.String),
  at: Millis,
})
export type Receipt = typeof Receipt.Type

/** Fleet-level deltas: bot health, thread ordering, unread. One per connection. */
export const FleetFrame = Schema.Struct({
  bots: Schema.optional(Schema.Array(Bot)),
  threads: Schema.optional(Schema.Array(Thread)),
  /** Threads whose rows should disappear from the rail (archived, deleted). */
  removedThreads: Schema.optional(Schema.Array(ThreadId)),
})
export type FleetFrame = typeof FleetFrame.Type

/** A connectable service in the Plugins marketplace. */
export const PluginListing = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  blurb: Schema.String,
  category: Schema.String,
  kind: Schema.Literals(["mcp", "openapi"]),
  scope: Schema.Literals(["org", "member"]),
  featured: Schema.Boolean,
  /** Hosts this plugin adds to the sandbox allow-list when enabled. */
  hosts: Schema.Array(Schema.String),
})
export type PluginListing = typeof PluginListing.Type

/** One node in the Computer pane's file tree. Children are fetched on expand. */
export const FileNode = Schema.Struct({
  path: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["file", "dir"]),
  size: Schema.optional(Schema.Int),
})
export type FileNode = typeof FileNode.Type

export class EvieRpc extends RpcGroup.make(
  /**
   * Must be the first call on a fresh connection. Everything else fails with
   * `HandshakeRequired` until it succeeds, and a `contractVersion` mismatch
   * fails with `ContractMismatch` naming both -- which the client renders as
   * "Update Evie to keep using this environment" rather than as a decode
   * failure twenty frames later.
   */
  Rpc.make("session.hello", {
    payload: { contractVersion: Schema.Number },
    success: SessionInfo,
    error: EvieError,
  }),

  Rpc.make("command", {
    payload: { command: Command },
    success: Receipt,
    error: EvieError,
  }),

  /* --- queries ----------------------------------------------------------- */

  Rpc.make("bots.list", {
    payload: { includeArchived: Schema.optional(Schema.Boolean) },
    success: Schema.Array(Bot),
    error: EvieError,
  }),

  Rpc.make("threads.list", {
    payload: {
      filter: Schema.optional(Schema.Literals(["active", "snoozed", "archived"])),
      before: Schema.optional(Millis),
      limit: Schema.optional(Schema.Int),
    },
    success: Schema.Struct({
      items: Schema.Array(Thread),
      nextBefore: Schema.NullOr(Millis),
    }),
    error: EvieError,
  }),

  /**
   * Paged by the projection's own monotonic `seq`, which is the table's paging
   * key. Not by `MessageId`: tool, input, auth, and system rows have ids that
   * are not message ids.
   */
  Rpc.make("threads.timeline", {
    payload: {
      threadId: ThreadId,
      before: Schema.optional(Schema.Int),
      limit: Schema.optional(Schema.Int),
    },
    success: Schema.Struct({
      items: Schema.Array(TimelineItem),
      nextBefore: Schema.NullOr(Schema.Int),
    }),
    error: EvieError,
  }),

  Rpc.make("org.members", {
    success: Schema.Struct({
      members: Schema.Array(Member),
      invitations: Schema.Array(Invitation),
      teams: Schema.Array(Team),
    }),
    error: EvieError,
  }),

  /**
   * A client receives `{ name, hint, configured }`. Never the value, not to an
   * owner, not over loopback. Re-entry is cheap; a leaked secret in a logged
   * WebSocket frame is not.
   */
  Rpc.make("secrets.list", {
    payload: { botId: Schema.optional(BotId) },
    success: Schema.Array(
      Schema.Struct({
        scope: Schema.String,
        name: Schema.String,
        hint: Schema.NullOr(Schema.String),
        configured: Schema.Boolean,
      }),
    ),
    error: EvieError,
  }),

  /**
   * Every routine the caller's organization owns, newest first, optionally
   * narrowed to one bot.
   *
   * A read rather than a slice of `FleetFrame`: routines change when someone
   * edits one, which is rare, and putting them on the fleet subscription would
   * spend the frame budget on a table almost nobody has open. The dialog
   * refetches when it opens and after each command's receipt.
   */
  Rpc.make("routines.list", {
    payload: { botId: Schema.optional(BotId) },
    success: Schema.Array(Routine),
    error: EvieError,
  }),

  Rpc.make("plugins.catalog", {
    payload: { botId: Schema.optional(BotId) },
    success: Schema.Struct({
      listings: Schema.Array(PluginListing),
      /** Plugin ids already connected on this bot, so the row says *Added*. */
      installed: Schema.Array(Schema.String),
    }),
    error: EvieError,
  }),

  /** The Computer pane's file tree, one level at a time. */
  Rpc.make("computer.list", {
    payload: { botId: BotId, path: Schema.String },
    success: Schema.Array(FileNode),
    error: EvieError,
  }),

  /**
   * Bytes never cross this socket and there is no RPC that returns them. This
   * mints a short-lived signed token; the client then does `GET /blob/:id`,
   * which checks the token against the caller's active organization -- never
   * against knowledge of the id alone, since a content hash is guessable.
   */
  Rpc.make("blobs.grant", {
    payload: { blobId: BlobId },
    success: Schema.Struct({ url: Schema.String, expiresAt: Millis }),
    error: EvieError,
  }),

  /* --- subscriptions ----------------------------------------------------- */

  /**
   * One per open thread. `since` resumes from the client's last seen `seq`, so
   * a reconnect replays the gap instead of refetching the thread.
   */
  Rpc.make("threads.subscribe", {
    payload: { threadId: ThreadId, since: Schema.optional(Schema.Int) },
    success: TimelineFrame,
    error: EvieError,
    stream: true,
  }),

  /** One per connection. Bot health, thread ordering, unread. */
  Rpc.make("fleet.subscribe", {
    success: FleetFrame,
    error: EvieError,
    stream: true,
  }),

  /**
   * Reasoning is opt-in per block and only while it is live. Expanding a block
   * on a running turn subscribes to it and the server starts including its
   * deltas; expanding one on a thread reopened next month gets the token count
   * and a row that says the text was not kept.
   */
  Rpc.make("reasoning.watch", {
    payload: { threadId: ThreadId, itemId: Schema.String, watching: Schema.Boolean },
    error: EvieError,
  }),

  /** Which threads this client has open. Drives subscription lifecycle and idle-stop. */
  Rpc.make("presence.set", {
    payload: { openThreads: Schema.Array(ThreadId) },
    error: EvieError,
  }),
) {}

/** The actor every handler runs as. Resolved from the session, never the payload. */
export const Actor = Schema.Struct({
  userId: UserId,
  orgId: Schema.String,
  role: Schema.String,
})
export type Actor = typeof Actor.Type
