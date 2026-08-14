import type { Command } from "@evie/contracts/commands"
import { InvalidCommand, PolicyViolation } from "@evie/contracts/errors"
import {
  BotCreated,
  BotArchived,
  BotMovedToTeam,
  BotRenamed,
  BotUnarchived,
  CheckpointRestoreRequested,
  type EvieEvent,
  GrantLinked,
  GrantRevoked,
  InputAnswered,
  InstructionsChanged,
  MessageSent,
  ModelChanged,
  NetworkPolicyChanged,
  ParticipantAdded,
  ParticipantRemoved,
  RoutineCreated,
  RoutineDeleted,
  RoutineEnabled,
  RoutineRunAsChanged,
  SandboxBackendChanged,
  SecretRemoved,
  SecretSet,
  ServiceConnected,
  ServiceDisconnected,
  SessionClearRequested,
  SessionCompactRequested,
  ThreadArchived,
  ThreadOpened,
  ThreadRenamed,
  ThreadSnoozed,
  ThreadUnarchived,
  ThreadUnsnoozed,
  TurnCancelRequested,
} from "@evie/contracts/events"
import type { BotId, ConnectionId, RoutineId, ThreadId } from "@evie/contracts/ids"
import { uniqueSlug } from "@evie/shared/slug"
import type { Actor, AggregateState, BotState, OrgState, ThreadState } from "./state.ts"
import { secretKey } from "./state.ts"

/**
 * The pure decider. Authorization already ran in RPC middleware; this function
 * concerns itself only with whether the command makes sense given the state.
 * Keeping those apart is what stops permission logic leaking into business
 * rules and becoming untestable.
 *
 * Refusals are **thrown** `InvalidCommand` / `PolicyViolation` instances --
 * plain Error subclasses, so purity holds and a test is
 * `expect(() => decide(...)).toThrow()`. Commands that repeat an already-true
 * state (archive an archived bot) return `[]`: a no-op success, not an error,
 * because two clients double-clicking is not a defect.
 */

/** Everything impure a decision needs, injected so tests control all of it. */
export interface DecideEnv {
  readonly now: number
  /** Mints a ULID. Called once per id the decision creates. */
  readonly newId: () => string
  /** Member count of the acting organization. Auth-owned; arrives resolved. */
  readonly orgMemberCount: number
}

const reject = (reason: string): never => {
  throw new InvalidCommand({ reason })
}

const policy = (name: string, reason: string, remedy: string): never => {
  throw new PolicyViolation({ policy: name, reason, remedy })
}

const requireBot = (state: AggregateState, forWhat: string): BotState => {
  if (state.kind !== "bot" || state.state === null) {
    return reject(`${forWhat}: the bot does not exist in this organization`)
  }
  if (state.state.archived) return reject(`${forWhat}: the bot is archived; unarchive it first`)
  return state.state
}

const requireThread = (state: AggregateState, forWhat: string): ThreadState => {
  if (state.kind !== "thread" || state.state === null) {
    return reject(`${forWhat}: the thread does not exist in this organization`)
  }
  return state.state
}

const requireOrg = (state: AggregateState): OrgState => {
  if (state.kind !== "org") return reject("command was routed to the wrong aggregate")
  return state.state
}

const hasMemberScopedConnection = (bot: BotState): boolean => {
  for (const connection of bot.connections.values()) {
    if (connection.scope === "member") return true
  }
  return false
}

const requireRoutine = (bot: BotState, routineId: string, forWhat: string) =>
  bot.routines.get(routineId) ?? reject(`${forWhat}: no such routine on this bot`)

const RUN_AS_REMEDY = "Pick a run-as member in the routine editor."

const secretScopeKey = (
  scope: "org" | "bot" | "user",
  botId: BotId | undefined,
  actor: Actor,
): string => {
  switch (scope) {
    case "org":
      return `org:${actor.orgId}`
    case "bot":
      return botId === undefined
        ? reject("a bot-scoped secret needs a botId")
        : `bot:${botId}`
    case "user":
      return `user:${actor.userId}`
  }
}

export const decide = (
  state: AggregateState,
  command: Command,
  actor: Actor,
  env: DecideEnv,
): ReadonlyArray<EvieEvent> => {
  switch (command._tag) {
    /* --- bots -------------------------------------------------------------- */

    case "CreateBot": {
      const org = requireOrg(state)
      const taken = new Set<string>()
      for (const bot of org.bots.values()) taken.add(bot.slug)
      return [
        BotCreated.make({
          botId: env.newId() as BotId,
          slug: uniqueSlug(command.input.name, taken),
          name: command.input.name,
          teamId: command.input.teamId ?? null,
          model: command.input.model,
          avatar: command.input.avatar ?? null,
          reasoning: command.input.reasoning ?? null,
        }),
      ]
    }
    case "RenameBot": {
      requireBot(state, "RenameBot")
      return [
        BotRenamed.make({
          botId: command.botId,
          name: command.name,
          description: command.description ?? null,
        }),
      ]
    }
    case "MoveBotToTeam": {
      const bot = requireBot(state, "MoveBotToTeam")
      if (bot.teamId === command.teamId) return []
      return [BotMovedToTeam.make({ botId: command.botId, teamId: command.teamId })]
    }
    case "ArchiveBot": {
      if (state.kind !== "bot" || state.state === null) {
        return reject("ArchiveBot: the bot does not exist in this organization")
      }
      if (state.state.archived) return []
      return [BotArchived.make({ botId: command.botId })]
    }
    case "UnarchiveBot": {
      if (state.kind !== "bot" || state.state === null) {
        return reject("UnarchiveBot: the bot does not exist in this organization")
      }
      if (!state.state.archived) return []
      return [BotUnarchived.make({ botId: command.botId })]
    }
    case "SetModel": {
      const bot = requireBot(state, "SetModel")
      return [
        ModelChanged.make({
          botId: command.botId,
          model: command.model,
          // Omitted means unchanged; null clears. The event always carries the
          // full resulting value so the projection never has to look back.
          reasoning: command.reasoning === undefined ? bot.reasoning : command.reasoning,
        }),
      ]
    }
    case "SetSandboxBackend": {
      const bot = requireBot(state, "SetSandboxBackend")
      if (command.backend === "just-bash" && env.orgMemberCount > 1) {
        // 05, refusal 3: "switch the sandbox, then invite" and "invite, then
        // switch the sandbox" must reach the same answer.
        return policy(
          "sandbox-isolation",
          "just-bash has no isolation and cannot be selected once the organization has more than one member",
          "Use docker, microsandbox, or vercel, or remove the other members first.",
        )
      }
      if (bot.backend === command.backend) return []
      return [SandboxBackendChanged.make({ botId: command.botId, backend: command.backend })]
    }
    case "SetNetworkPolicy": {
      requireBot(state, "SetNetworkPolicy")
      return [NetworkPolicyChanged.make({ botId: command.botId, policy: command.policy })]
    }
    case "SetInstructions": {
      requireBot(state, "SetInstructions")
      // The event carries the text. The file is still the source of truth the
      // agent reads, but the reactor that writes it has no other way to learn
      // what the user typed -- and a content-free event meant this command
      // succeeded while silently changing nothing.
      return [
        InstructionsChanged.make({
          botId: command.botId,
          instructions: command.instructions,
        }),
      ]
    }

    /* --- routines ---------------------------------------------------------- */

    case "CreateRoutine": {
      const bot = requireBot(state, "CreateRoutine")
      if (command.cron.trim().split(/\s+/).length !== 5) {
        return reject("CreateRoutine: cron must have exactly 5 fields")
      }
      if (command.runAs === undefined && hasMemberScopedConnection(bot)) {
        // 05, "The routine trap": a scheduled run has no human behind it, and
        // eve refuses to borrow someone's grant.
        return policy(
          "routine-run-as",
          "this bot has a member-scoped connection, so a scheduled run must pin the member it acts as",
          RUN_AS_REMEDY,
        )
      }
      return [
        RoutineCreated.make({
          routineId: env.newId() as RoutineId,
          botId: command.botId,
          name: command.name,
          cron: command.cron,
          tz: command.tz,
          prompt: command.prompt,
          threadId: command.threadId ?? null,
          runAs: command.runAs ?? null,
        }),
      ]
    }
    case "SetRoutineEnabled": {
      const bot = requireBot(state, "SetRoutineEnabled")
      const routine = requireRoutine(bot, command.routineId, "SetRoutineEnabled")
      if (routine.enabled === command.enabled) return []
      if (command.enabled && routine.runAs === null && hasMemberScopedConnection(bot)) {
        return policy(
          "routine-run-as",
          "enabling this routine needs a run-as member: the bot has a member-scoped connection",
          RUN_AS_REMEDY,
        )
      }
      return [
        RoutineEnabled.make({
          routineId: command.routineId,
          botId: command.botId,
          enabled: command.enabled,
        }),
      ]
    }
    case "SetRoutineRunAs": {
      const bot = requireBot(state, "SetRoutineRunAs")
      requireRoutine(bot, command.routineId, "SetRoutineRunAs")
      if (command.runAs === null && hasMemberScopedConnection(bot)) {
        return policy(
          "routine-run-as",
          "this bot has a member-scoped connection, so the routine must keep a run-as member",
          RUN_AS_REMEDY,
        )
      }
      return [
        RoutineRunAsChanged.make({
          routineId: command.routineId,
          botId: command.botId,
          runAs: command.runAs,
        }),
      ]
    }
    case "DeleteRoutine": {
      const bot = requireBot(state, "DeleteRoutine")
      requireRoutine(bot, command.routineId, "DeleteRoutine")
      return [RoutineDeleted.make({ routineId: command.routineId, botId: command.botId })]
    }

    /* --- connections ------------------------------------------------------- */

    case "ConnectService": {
      const bot = requireBot(state, "ConnectService")
      for (const connection of bot.connections.values()) {
        if (connection.name === command.name) {
          return reject(`ConnectService: a connection named "${command.name}" already exists`)
        }
      }
      return [
        ServiceConnected.make({
          botId: command.botId,
          connectionId: env.newId() as ConnectionId,
          name: command.name,
          kind: command.kind,
          scope: command.scope,
          config: command.config,
          authKind: command.authKind,
        }),
      ]
    }
    case "DisconnectService": {
      const bot = requireBot(state, "DisconnectService")
      if (!bot.connections.has(command.connectionId)) {
        return reject("DisconnectService: no such connection on this bot")
      }
      return [
        ServiceDisconnected.make({ botId: command.botId, connectionId: command.connectionId }),
      ]
    }
    case "LinkMyGrant": {
      const bot = requireBot(state, "LinkMyGrant")
      const connection = bot.connections.get(command.connectionId)
      if (connection === undefined) return reject("LinkMyGrant: no such connection on this bot")
      // An org-scoped connection has one shared grant; member scope links the
      // caller's own. The token itself goes to Secrets, never into the event.
      const grantUser = connection.scope === "member" ? actor.userId : null
      return [
        GrantLinked.make({
          botId: command.botId,
          connectionId: command.connectionId,
          userId: grantUser,
        }),
      ]
    }
    case "RevokeGrant": {
      const bot = requireBot(state, "RevokeGrant")
      const connection = bot.connections.get(command.connectionId)
      if (connection === undefined) return reject("RevokeGrant: no such connection on this bot")
      const grantUser =
        connection.scope === "member" ? (command.userId ?? actor.userId) : null
      if (!connection.grants.has(grantUser ?? "")) {
        return reject("RevokeGrant: that grant is not linked")
      }
      return [
        GrantRevoked.make({
          botId: command.botId,
          connectionId: command.connectionId,
          userId: grantUser,
        }),
      ]
    }

    /* --- threads and turns --------------------------------------------------- */

    case "OpenThread": {
      const org = requireOrg(state)
      const distinct = new Set(command.participants)
      if (distinct.size !== command.participants.length) {
        return reject("OpenThread: duplicate participants")
      }
      for (const botId of command.participants) {
        const bot = org.bots.get(botId)
        if (bot === undefined) return reject(`OpenThread: bot ${botId} does not exist`)
        if (bot.archived) return reject(`OpenThread: bot ${botId} is archived`)
      }
      return [
        ThreadOpened.make({
          threadId: env.newId() as ThreadId,
          participants: command.participants,
          title: command.title ?? null,
        }),
      ]
    }
    case "AddParticipant": {
      const thread = requireThread(state, "AddParticipant")
      if (thread.archived) return reject("AddParticipant: the thread is archived")
      if (thread.participants.has(command.botId)) return []
      return [ParticipantAdded.make({ threadId: command.threadId, botId: command.botId })]
    }
    case "RemoveParticipant": {
      const thread = requireThread(state, "RemoveParticipant")
      if (!thread.participants.has(command.botId)) {
        return reject("RemoveParticipant: that bot is not in the thread")
      }
      if (thread.participants.size === 1) {
        return reject("RemoveParticipant: a thread keeps at least one participant")
      }
      return [ParticipantRemoved.make({ threadId: command.threadId, botId: command.botId })]
    }
    case "SendMessage": {
      const thread = requireThread(state, "SendMessage")
      if (thread.archived) return reject("SendMessage: the thread is archived")
      // A retry after a dropped socket is the same message, not a second one.
      if (thread.seenIdempotencyKeys.has(command.idempotencyKey)) return []
      for (const botId of command.mentions) {
        if (!thread.participants.has(botId)) {
          return reject(`SendMessage: @mentioned bot ${botId} is not in the thread`)
        }
      }
      return [
        MessageSent.make({
          threadId: command.threadId,
          text: command.text,
          mentions: command.mentions,
          attachments: command.attachments,
          idempotencyKey: command.idempotencyKey,
        }),
      ]
    }
    case "CancelTurn": {
      const thread = requireThread(state, "CancelTurn")
      // Cancelling a turn that already settled is a race, not a mistake.
      if (!thread.activeTurns.has(command.turnId)) return []
      return [TurnCancelRequested.make({ threadId: command.threadId, turnId: command.turnId })]
    }
    case "AnswerInput": {
      const thread = requireThread(state, "AnswerInput")
      if (thread.answeredInputs.has(command.requestId)) {
        return reject("AnswerInput: this request was already answered")
      }
      return [
        InputAnswered.make({
          threadId: command.threadId,
          requestId: command.requestId,
          optionId: command.optionId,
          scope: command.scope ?? null,
        }),
      ]
    }
    case "CompactSession": {
      const thread = requireThread(state, "CompactSession")
      if (!thread.participants.has(command.botId)) {
        return reject("CompactSession: that bot is not in the thread")
      }
      return [SessionCompactRequested.make({ threadId: command.threadId, botId: command.botId })]
    }
    case "ClearSession": {
      const thread = requireThread(state, "ClearSession")
      if (!thread.participants.has(command.botId)) {
        return reject("ClearSession: that bot is not in the thread")
      }
      return [SessionClearRequested.make({ threadId: command.threadId, botId: command.botId })]
    }
    case "SnoozeThread": {
      const thread = requireThread(state, "SnoozeThread")
      if (thread.archived) return reject("SnoozeThread: the thread is archived")
      if (command.until <= env.now) return reject("SnoozeThread: `until` is in the past")
      return [ThreadSnoozed.make({ threadId: command.threadId, until: command.until })]
    }
    case "UnsnoozeThread": {
      const thread = requireThread(state, "UnsnoozeThread")
      if (thread.snoozedUntil === null) return []
      return [ThreadUnsnoozed.make({ threadId: command.threadId })]
    }
    case "ArchiveThread": {
      const thread = requireThread(state, "ArchiveThread")
      if (thread.archived) return []
      return [ThreadArchived.make({ threadId: command.threadId })]
    }
    case "UnarchiveThread": {
      const thread = requireThread(state, "UnarchiveThread")
      if (!thread.archived) return []
      return [ThreadUnarchived.make({ threadId: command.threadId })]
    }
    case "RenameThread": {
      requireThread(state, "RenameThread")
      return [ThreadRenamed.make({ threadId: command.threadId, title: command.title })]
    }
    case "RestoreCheckpoint": {
      requireThread(state, "RestoreCheckpoint")
      // Checkpoint existence is the reactor's fact (its ids never enter the
      // fold); a missing one fails the restore there, loudly.
      return [
        CheckpointRestoreRequested.make({
          threadId: command.threadId,
          checkpointId: command.checkpointId,
        }),
      ]
    }

    /* --- secrets ------------------------------------------------------------- */

    case "SetSecret": {
      requireOrg(state)
      const scope = secretScopeKey(command.scope, command.botId, actor)
      return [
        // Name and hint only. The value goes to Secrets for encryption and is
        // never in the log, not even ciphertext.
        SecretSet.make({ scope, name: command.name, hint: command.value.slice(-4) }),
      ]
    }
    case "RemoveSecret": {
      const org = requireOrg(state)
      const scope = secretScopeKey(command.scope, command.botId, actor)
      if (!org.secrets.has(secretKey(scope, command.name))) {
        return reject(`RemoveSecret: no secret named "${command.name}" in that scope`)
      }
      return [SecretRemoved.make({ scope, name: command.name })]
    }

    /* --- organization ---------------------------------------------------------- */
    // These delegate to Better Auth in the RPC layer. Reaching the decider
    // means the routing broke; say so loudly instead of guessing.

    case "InviteMember":
    case "RevokeInvitation":
    case "SetMemberRole":
    case "RemoveMember":
    case "CreateTeam":
    case "DeleteTeam":
    case "SetActiveOrg":
      return reject(
        `${command._tag} is an organization command: it delegates to Better Auth and must never reach the decider`,
      )
  }
}
