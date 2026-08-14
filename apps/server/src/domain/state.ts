import type { SandboxBackend } from "@evie/contracts/bot"
import type { EvieEvent } from "@evie/contracts/events"
import type { OrgId, UserId } from "@evie/contracts/ids"
import type { MemberRole } from "@evie/contracts/org"

/**
 * The state of ONE aggregate, folded from its own product events. Pure data,
 * no Effect, no IO -- what makes the decider testable with no model, no
 * process, and no socket.
 *
 * A fold only tracks what a decision reads. Events an aggregate's decisions
 * never consult (receipts it does not gate on, another aggregate's rows) fall
 * through the fold unchanged, deliberately.
 */

/** Resolved from the session before the command is admitted. Never from the payload. */
export interface Actor {
  readonly userId: UserId
  readonly orgId: OrgId
  readonly role: MemberRole
}

export interface RoutineState {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  readonly runAs: string | null
}

export interface ConnectionState {
  readonly id: string
  readonly name: string
  readonly scope: string
  /** Linked grants, keyed by user id -- `''` for the single org-scope grant. */
  readonly grants: Set<string>
}

export interface BotState {
  readonly id: string
  readonly slug: string
  name: string
  teamId: string | null
  model: string
  reasoning: string | null
  archived: boolean
  backend: SandboxBackend
  readonly routines: Map<string, RoutineState>
  readonly connections: Map<string, ConnectionState>
}

export interface ThreadState {
  readonly id: string
  title: string | null
  archived: boolean
  snoozedUntil: number | null
  readonly participants: Set<string>
  defaultBot: string | null
  /** Client-minted keys already folded. A retried send is the same message. */
  readonly seenIdempotencyKeys: Set<string>
  readonly answeredInputs: Set<string>
  readonly activeTurns: Set<string>
}

/** The org aggregate sees every product event in the org: it owns the uniqueness checks. */
export interface OrgState {
  readonly bots: Map<string, { slug: string; archived: boolean }>
  readonly teams: Set<string>
  /**
   * Secrets that exist, as `scope` and `name` joined by a NUL. NUL rather
   * than a printable separator because a scope is `bot:<ulid>` and a name is
   * user-supplied -- any character a user can type is a character that can
   * forge a collision. Values never fold; they never enter the log.
   */
  readonly secrets: Set<string>
}

export type AggregateState =
  | { readonly kind: "bot"; readonly state: BotState | null; readonly version: number }
  | { readonly kind: "thread"; readonly state: ThreadState | null; readonly version: number }
  | { readonly kind: "org"; readonly state: OrgState; readonly version: number }

/** See `OrgState.secrets`. The escape is spelled out so this file stays text. */
export const secretKey = (scope: string, name: string): string => `${scope}\u0000${name}`

const foldBot = (state: BotState | null, event: EvieEvent): BotState | null => {
  if (event._tag === "BotCreated") {
    return {
      id: event.botId,
      slug: event.slug,
      name: event.name,
      teamId: event.teamId,
      model: event.model,
      reasoning: null,
      archived: false,
      backend: "docker",
      routines: new Map(),
      connections: new Map(),
    }
  }
  if (state === null) return null
  switch (event._tag) {
    case "BotRenamed":
      state.name = event.name
      return state
    case "BotMovedToTeam":
      state.teamId = event.teamId
      return state
    case "BotArchived":
      state.archived = true
      return state
    case "BotUnarchived":
      state.archived = false
      return state
    case "ModelChanged":
      state.model = event.model
      state.reasoning = event.reasoning
      return state
    case "SandboxBackendChanged":
      state.backend = event.backend
      return state
    case "RoutineCreated":
      state.routines.set(event.routineId, {
        id: event.routineId,
        name: event.name,
        enabled: true,
        runAs: event.runAs,
      })
      return state
    case "RoutineEnabled": {
      const routine = state.routines.get(event.routineId)
      if (routine) state.routines.set(event.routineId, { ...routine, enabled: event.enabled })
      return state
    }
    case "RoutineRunAsChanged": {
      const routine = state.routines.get(event.routineId)
      if (routine) state.routines.set(event.routineId, { ...routine, runAs: event.runAs })
      return state
    }
    case "RoutineDeleted":
      state.routines.delete(event.routineId)
      return state
    case "ServiceConnected":
      state.connections.set(event.connectionId, {
        id: event.connectionId,
        name: event.name,
        scope: event.scope,
        grants: new Set(),
      })
      return state
    case "ServiceDisconnected":
      state.connections.delete(event.connectionId)
      return state
    case "GrantLinked":
      state.connections.get(event.connectionId)?.grants.add(event.userId ?? "")
      return state
    case "GrantRevoked":
      state.connections.get(event.connectionId)?.grants.delete(event.userId ?? "")
      return state
    default:
      return state
  }
}

const foldThread = (state: ThreadState | null, event: EvieEvent): ThreadState | null => {
  if (event._tag === "ThreadOpened") {
    return {
      id: event.threadId,
      title: event.title,
      archived: false,
      snoozedUntil: null,
      participants: new Set(event.participants),
      defaultBot: event.participants[0] ?? null,
      seenIdempotencyKeys: new Set(),
      answeredInputs: new Set(),
      activeTurns: new Set(),
    }
  }
  if (state === null) return null
  switch (event._tag) {
    case "ParticipantAdded":
      state.participants.add(event.botId)
      state.defaultBot ??= event.botId
      return state
    case "ParticipantRemoved":
      state.participants.delete(event.botId)
      if (state.defaultBot === event.botId) {
        state.defaultBot = state.participants.values().next().value ?? null
      }
      return state
    case "MessageSent":
      state.seenIdempotencyKeys.add(event.idempotencyKey)
      return state
    case "InputAnswered":
      state.answeredInputs.add(event.requestId)
      return state
    case "ThreadSnoozed":
      state.snoozedUntil = event.until
      return state
    case "ThreadUnsnoozed":
      state.snoozedUntil = null
      return state
    case "ThreadArchived":
      state.archived = true
      return state
    case "ThreadUnarchived":
      state.archived = false
      return state
    case "ThreadRenamed":
      state.title = event.title
      return state
    case "TurnDispatched":
      state.activeTurns.add(event.turnId)
      return state
    case "TurnSettled":
      state.activeTurns.delete(event.turnId)
      return state
    default:
      return state
  }
}

const foldOrg = (state: OrgState, event: EvieEvent): OrgState => {
  switch (event._tag) {
    case "BotCreated":
      state.bots.set(event.botId, { slug: event.slug, archived: false })
      return state
    case "BotArchived": {
      const bot = state.bots.get(event.botId)
      if (bot) bot.archived = true
      return state
    }
    case "BotUnarchived": {
      const bot = state.bots.get(event.botId)
      if (bot) bot.archived = false
      return state
    }
    case "TeamCreated":
      state.teams.add(event.teamId)
      return state
    case "TeamDeleted":
      state.teams.delete(event.teamId)
      return state
    case "SecretSet":
      state.secrets.add(secretKey(event.scope, event.name))
      return state
    case "SecretRemoved":
      state.secrets.delete(secretKey(event.scope, event.name))
      return state
    default:
      return state
  }
}

export const emptyOrgState = (): OrgState => ({
  bots: new Map(),
  teams: new Set(),
  secrets: new Set(),
})

/**
 * Folds one aggregate's product events, exactly as `EventStore.readAggregate`
 * returned them. `version` is the event count -- the number `append` checks
 * `expectedVersion` against.
 */
export const foldAggregate = (
  kind: AggregateState["kind"],
  events: ReadonlyArray<EvieEvent>,
): AggregateState => {
  switch (kind) {
    case "bot": {
      let state: BotState | null = null
      for (const event of events) state = foldBot(state, event)
      return { kind, state, version: events.length }
    }
    case "thread": {
      let state: ThreadState | null = null
      for (const event of events) state = foldThread(state, event)
      return { kind, state, version: events.length }
    }
    case "org": {
      let state = emptyOrgState()
      for (const event of events) state = foldOrg(state, event)
      return { kind, state, version: events.length }
    }
  }
}
