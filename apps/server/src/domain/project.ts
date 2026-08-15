import type { BotHealth, SandboxConfig } from "@evie/contracts/bot"
import type { StoredEvent } from "@evie/contracts/events"
import type { BlobId, BotId, SessionId, ThreadId } from "@evie/contracts/ids"
import type {
  AuthState,
  FinishReason,
  InputOption,
  Part,
  TimelineItem,
} from "@evie/contracts/timeline"

/**
 * The projector: `apply(model, event)` folds one stored event into the read
 * model and returns the rows that changed, so the caller can persist exactly
 * those -- on the ingestion flush tick, batched, in one transaction. The
 * projector itself never writes.
 *
 * It is deterministic on `(model, event)` and does no IO; the one concession
 * to the streaming hot path is that it updates `model` in place rather than
 * copying maps per delta.
 *
 * eve retries interrupted steps under fresh `meta.id`s but the same
 * `(turnId, stepIndex, sequence)`, so the mirror can legitimately hold both
 * attempts. The visible assistant message is keyed by that triple,
 * last-writer-wins: the retry overwrites the interrupted attempt's row.
 */

/* --- rows ------------------------------------------------------------------ */

export interface BotRow {
  readonly id: BotId
  readonly orgId: string
  teamId: string | null
  slug: string
  name: string
  description: string | null
  avatar: string | null
  model: string
  reasoning: string | null
  runtimeMode: "dev" | "built"
  sandbox: SandboxConfig
  health: BotHealth
  readonly createdBy: string | null
  readonly createdAt: number
  archivedAt: number | null
}

export interface ThreadRow {
  readonly id: ThreadId
  readonly orgId: string
  title: string | null
  readonly createdBy: string | null
  readonly createdAt: number
  lastActivity: number
  snoozedUntil: number | null
  archivedAt: number | null
}

export interface ParticipantRow {
  readonly threadId: ThreadId
  readonly botId: BotId
  eveSessionId: string | null
  /** The next `startIndex` to request from eve: last mirrored index + 1. */
  streamIndex: number
  isDefault: boolean
}

export interface RoutineRow {
  readonly id: string
  readonly orgId: string
  readonly botId: BotId
  readonly threadId: string | null
  name: string
  cron: string
  tz: string
  prompt: string
  runAs: string | null
  enabled: boolean
  blockedReason: string | null
  lastRunAt: number | null
}

export interface ConnectionRow {
  readonly id: string
  readonly orgId: string
  readonly botId: BotId
  readonly name: string
  readonly kind: string
  readonly scope: string
  readonly config: unknown
  readonly authKind: string
}

export interface TimelineRow {
  readonly threadId: ThreadId
  readonly item: TimelineItem
  readonly actorUserId: string | null
}

export type RowChange =
  | { readonly kind: "bot"; readonly row: BotRow }
  | { readonly kind: "thread"; readonly row: ThreadRow }
  | { readonly kind: "participant"; readonly row: ParticipantRow }
  | { readonly kind: "participantRemoved"; readonly threadId: ThreadId; readonly botId: BotId }
  | { readonly kind: "routine"; readonly row: RoutineRow }
  | { readonly kind: "routineDeleted"; readonly id: string }
  | { readonly kind: "connection"; readonly row: ConnectionRow }
  | { readonly kind: "connectionDeleted"; readonly id: string }
  | { readonly kind: "timeline"; readonly row: TimelineRow }

/* --- model ------------------------------------------------------------------ */

/**
 * Where a new row goes in its thread.
 *
 * Deliberately NOT part of a `ThreadTimeline`, which is per-model. Two
 * projections write `timeline_item` -- this one folding the event log, the
 * adapter folding a live eve stream -- and a counter inside each model agrees
 * with the other only until one of them projects an event the other never sees
 * (a user message, a checkpoint row). From then on they hand out the same
 * number for different rows.
 *
 * The database refuses that, so the insert clamps the position to the next
 * free one and the row lands correctly either way. What it cannot fix is the
 * number already sent to clients on the live frame: the two drifted apart, one
 * row per unshared event, until the position a client sorted by and the
 * position the server paged by were different numbers for the same row. Rows
 * tied, `since` cursors compared across the two, and every reconnect re-sent
 * rows the client already had.
 *
 * One allocator per process, seeded from the table, is the whole fix: both
 * projections predict the same position, and it is the one the row gets.
 */
export interface ThreadPositions {
  /** The next free position in this thread. Advances on every call. */
  readonly allocate: (threadId: string) => number
  /** Records a position already taken, so the next allocation clears it. */
  readonly observe: (threadId: string, seq: number) => void
}

export const makeThreadPositions = (): ThreadPositions => {
  const next = new Map<string, number>()
  return {
    allocate: (threadId) => {
      const seq = next.get(threadId) ?? 1
      next.set(threadId, seq + 1)
      return seq
    },
    observe: (threadId, seq) => {
      if (seq >= (next.get(threadId) ?? 1)) next.set(threadId, seq + 1)
    },
  }
}

interface ThreadTimeline {
  readonly items: Map<string, TimelineRow>
  /** callId -> item id */
  readonly toolByCall: Map<string, string>
  /** requestId -> item id */
  readonly inputByRequest: Map<string, string>
  /** `${botId}/${service name}` -> item id, for authorization.completed */
  readonly authByName: Map<string, string>
  /** childSessionId -> item id */
  readonly subagentBySession: Map<string, string>
}

export interface ReadModel {
  readonly bots: Map<string, BotRow>
  readonly threads: Map<string, ThreadRow>
  /** `${threadId}/${botId}` */
  readonly participants: Map<string, ParticipantRow>
  readonly routines: Map<string, RoutineRow>
  readonly connections: Map<string, ConnectionRow>
  readonly timelines: Map<string, ThreadTimeline>
  /** Shared with every other projection that writes `timeline_item`. */
  readonly positions: ThreadPositions
}

/** The shared allocator is an argument because sharing it is the point. */
export const emptyReadModel = (
  positions: ThreadPositions = makeThreadPositions(),
): ReadModel => ({
  bots: new Map(),
  threads: new Map(),
  participants: new Map(),
  routines: new Map(),
  connections: new Map(),
  timelines: new Map(),
  positions,
})

/* --- tolerant readers for eve payloads ----------------------------------------
 * The adapter stores the NDJSON line's `data` object as `payload`. eve owns
 * that shape; we read the handful of fields the timeline needs and treat
 * anything missing as absent rather than failing the whole projection. */

const rec = (u: unknown): Record<string, unknown> =>
  typeof u === "object" && u !== null ? (u as Record<string, unknown>) : {}
const str = (u: unknown): string | undefined => (typeof u === "string" ? u : undefined)
const num = (u: unknown): number | undefined => (typeof u === "number" ? u : undefined)
const arr = (u: unknown): ReadonlyArray<unknown> => (Array.isArray(u) ? u : [])

/**
 * The tool an input request is gating.
 *
 * eve nests it under `action` (`{ kind: "tool-call", toolName, callId, input }`),
 * and a question-kind request has no tool at all. Read both shapes and treat
 * absence as absent -- a request with no tool simply cannot be granted.
 */
const toolNameOf = (request: Record<string, unknown>): string | undefined =>
  str(rec(request["action"])["toolName"]) ?? str(request["toolName"])

const FINISH_REASONS: ReadonlyArray<FinishReason> = [
  "stop",
  "length",
  "tool-calls",
  "content-filter",
  "error",
  "other",
]
const finishReason = (u: unknown): FinishReason => {
  const value = str(u)
  return FINISH_REASONS.find((reason) => reason === value) ?? "other"
}

/* --- helpers ------------------------------------------------------------------ */

const timelineOf = (model: ReadModel, threadId: string): ThreadTimeline => {
  let timeline = model.timelines.get(threadId)
  if (timeline === undefined) {
    timeline = {
      items: new Map(),
      toolByCall: new Map(),
      inputByRequest: new Map(),
      authByName: new Map(),
      subagentBySession: new Map(),
    }
    model.timelines.set(threadId, timeline)
  }
  return timeline
}

/** `Omit` that distributes over the `TimelineItem` union instead of collapsing it. */
type ItemSansSeq = TimelineItem extends infer T ? (T extends TimelineItem ? Omit<T, "seq"> : never) : never

/**
 * Upserts by item id: a known id keeps its seq (last-writer-wins), a new one
 * takes the next.
 *
 * It keeps its `at` too, which is not just cosmetic. A streaming reply is one
 * row re-projected on every delta, and eve stamps each delta with its own
 * time, so a moving `at` made the row a different row every 50 ms: the
 * gateway's diff (`gateway/pump.ts`) compares everything except the text to
 * decide between a text suffix and a full replace, and a timestamp that always
 * moved meant it always chose replace. The whole cumulative message went over
 * the socket once per delta -- quadratic in the length of the reply, on the one
 * path that has to stay cheap (03, "Frame budget"). The honest value is when
 * the row first appeared; a message does not change the time it was sent while
 * it is still being written.
 */
const putItem = (
  model: ReadModel,
  threadId: ThreadId,
  actorUserId: string | null,
  item: ItemSansSeq,
): RowChange => {
  const timeline = timelineOf(model, threadId)
  const existing = timeline.items.get(item.id)
  const seq = existing?.item.seq ?? model.positions.allocate(threadId)
  const at = existing?.item.at ?? item.at
  const row: TimelineRow = {
    threadId,
    actorUserId,
    item: { ...item, seq, at } as TimelineItem,
  }
  timeline.items.set(item.id, row)
  return { kind: "timeline", row }
}

const getItem = (model: ReadModel, threadId: string, itemId: string): TimelineRow | undefined =>
  model.timelines.get(threadId)?.items.get(itemId)

const touchThread = (model: ReadModel, threadId: string, at: number): RowChange[] => {
  const thread = model.threads.get(threadId)
  if (thread === undefined || thread.lastActivity >= at) return []
  thread.lastActivity = at
  return [{ kind: "thread", row: thread }]
}

const participantKey = (threadId: string, botId: string) => `${threadId}/${botId}`

/** Evie's default: deny-all plus an allow-list, docker isolation. */
const defaultSandbox = (): SandboxConfig => ({
  backend: "docker",
  network: { mode: "deny-all", allow: [], enforced: "coarse" },
})

const enforcedFor = (backend: SandboxConfig["backend"]): SandboxConfig["network"]["enforced"] =>
  backend === "just-bash" ? "none" : backend === "docker" ? "coarse" : "domain"

/**
 * What a turn did to the files, as one line.
 *
 * The sha stays on the front so the row remains a handle to the checkpoint,
 * and the counts follow when there are any -- a checkpoint with no measured
 * changes reads as the bare sha rather than as "0 files changed", which is a
 * sentence nobody needs to read.
 */
const changeSummary = (data: {
  readonly sha: string
  readonly files: number
  readonly insertions: number
  readonly deletions: number
}): string => {
  if (data.files === 0) return data.sha
  const files = `${data.files} file${data.files === 1 ? "" : "s"} changed`
  return `${data.sha} \u00b7 ${files}, +${data.insertions} \u2212${data.deletions}`
}

/* --- the projector -------------------------------------------------------------- */

export const apply = (model: ReadModel, event: StoredEvent): ReadonlyArray<RowChange> => {
  const data = event.data
  switch (data._tag) {
    /* --- bots --- */
    case "BotCreated": {
      const row: BotRow = {
        id: data.botId,
        orgId: event.orgId,
        teamId: data.teamId,
        slug: data.slug,
        name: data.name,
        description: null,
        avatar: data.avatar,
        model: data.model,
        reasoning: data.reasoning,
        runtimeMode: "dev",
        sandbox: defaultSandbox(),
        health: { kind: "starting" },
        createdBy: event.actorUserId,
        createdAt: event.at,
        archivedAt: null,
      }
      model.bots.set(data.botId, row)
      return [{ kind: "bot", row }]
    }
    case "BotRenamed": {
      const bot = model.bots.get(data.botId)
      if (bot === undefined) return []
      bot.name = data.name
      bot.description = data.description
      return [{ kind: "bot", row: bot }]
    }
    case "BotMovedToTeam": {
      const bot = model.bots.get(data.botId)
      if (bot === undefined) return []
      bot.teamId = data.teamId
      return [{ kind: "bot", row: bot }]
    }
    case "BotArchived": {
      const bot = model.bots.get(data.botId)
      if (bot === undefined) return []
      bot.archivedAt = event.at
      return [{ kind: "bot", row: bot }]
    }
    case "BotUnarchived": {
      const bot = model.bots.get(data.botId)
      if (bot === undefined) return []
      bot.archivedAt = null
      return [{ kind: "bot", row: bot }]
    }
    case "ModelChanged": {
      const bot = model.bots.get(data.botId)
      if (bot === undefined) return []
      bot.model = data.model
      bot.reasoning = data.reasoning
      return [{ kind: "bot", row: bot }]
    }
    case "SandboxBackendChanged": {
      const bot = model.bots.get(data.botId)
      if (bot === undefined) return []
      bot.sandbox = {
        backend: data.backend,
        network: { ...bot.sandbox.network, enforced: enforcedFor(data.backend) },
      }
      return [{ kind: "bot", row: bot }]
    }
    case "NetworkPolicyChanged": {
      const bot = model.bots.get(data.botId)
      if (bot === undefined) return []
      bot.sandbox = { ...bot.sandbox, network: data.policy }
      return [{ kind: "bot", row: bot }]
    }
    case "RuntimeReady": {
      const bot = model.bots.get(data.botId)
      if (bot === undefined) return []
      bot.health = { kind: "ready" }
      return [{ kind: "bot", row: bot }]
    }
    case "RuntimeStopped": {
      const bot = model.bots.get(data.botId)
      if (bot === undefined) return []
      bot.health = { kind: "idle" }
      return [{ kind: "bot", row: bot }]
    }

    /*
     * Provisioning. A new bot's project is written and `npm install`ed by the
     * supervisor reactor, which can take minutes on a cold cache. The row
     * exists from `BotCreated` so the rail is never empty for a bot that
     * exists, and `starting` is what stops the chip claiming `idle` while an
     * install is running -- the label has to be true, not reassuring.
     */
    case "BotProvisioned": {
      const bot = model.bots.get(data.botId)
      if (bot === undefined) return []
      bot.health = { kind: "idle" }
      return [{ kind: "bot", row: bot }]
    }
    case "BotProvisionFailed": {
      const bot = model.bots.get(data.botId)
      if (bot === undefined) return []
      // A bot that cannot be provisioned will never answer. Saying so beats a
      // bot that looks fine and silently does nothing on the first message.
      bot.health = { kind: "unhealthy", reason: data.reason, stderr: data.stderr }
      return [{ kind: "bot", row: bot }]
    }

    /* --- threads --- */
    case "ThreadOpened": {
      const row: ThreadRow = {
        id: data.threadId,
        orgId: event.orgId,
        title: data.title,
        createdBy: event.actorUserId,
        createdAt: event.at,
        lastActivity: event.at,
        snoozedUntil: null,
        archivedAt: null,
      }
      model.threads.set(data.threadId, row)
      const changes: RowChange[] = [{ kind: "thread", row }]
      data.participants.forEach((botId, index) => {
        const participant: ParticipantRow = {
          threadId: data.threadId,
          botId,
          eveSessionId: null,
          streamIndex: 0,
          isDefault: index === 0,
        }
        model.participants.set(participantKey(data.threadId, botId), participant)
        changes.push({ kind: "participant", row: participant })
      })
      return changes
    }
    case "ParticipantAdded": {
      const participant: ParticipantRow = {
        threadId: data.threadId,
        botId: data.botId,
        eveSessionId: null,
        streamIndex: 0,
        isDefault: false,
      }
      model.participants.set(participantKey(data.threadId, data.botId), participant)
      return [{ kind: "participant", row: participant }]
    }
    case "ParticipantRemoved": {
      model.participants.delete(participantKey(data.threadId, data.botId))
      return [{ kind: "participantRemoved", threadId: data.threadId, botId: data.botId }]
    }
    case "ThreadSnoozed": {
      const thread = model.threads.get(data.threadId)
      if (thread === undefined) return []
      thread.snoozedUntil = data.until
      return [{ kind: "thread", row: thread }]
    }
    case "ThreadUnsnoozed": {
      const thread = model.threads.get(data.threadId)
      if (thread === undefined) return []
      thread.snoozedUntil = null
      return [{ kind: "thread", row: thread }]
    }
    case "ThreadArchived": {
      const thread = model.threads.get(data.threadId)
      if (thread === undefined) return []
      thread.archivedAt = event.at
      return [{ kind: "thread", row: thread }]
    }
    case "ThreadUnarchived": {
      const thread = model.threads.get(data.threadId)
      if (thread === undefined) return []
      thread.archivedAt = null
      return [{ kind: "thread", row: thread }]
    }
    case "ThreadRenamed": {
      const thread = model.threads.get(data.threadId)
      if (thread === undefined) return []
      thread.title = data.title
      return [{ kind: "thread", row: thread }]
    }

    /* --- messages and turns --- */
    case "MessageSent": {
      if (event.actorUserId === null) return []
      const changes: RowChange[] = []
      /*
       * A message sent while a question is pending overtakes it: the turn
       * reactor dispatches with `turnPolicy: "steer"`, so the bot abandons the
       * request and takes the reply as the answer, in the user's own words.
       * A card left pending after that invites a second answer to a question
       * the bot has already moved past -- the same sweep `turn.cancelled`
       * does, for the same reason.
       */
      const timeline = model.timelines.get(data.threadId)
      if (timeline !== undefined) {
        for (const row of timeline.items.values()) {
          if (row.item.kind === "input" && row.item.state === "pending") {
            changes.push(
              putItem(model, data.threadId, row.actorUserId, { ...row.item, state: "cancelled" }),
            )
          }
        }
      }
      const parts: Part[] = [{ type: "text", text: data.text }]
      for (const blobId of data.attachments) {
        // Media type lives on the blob row; the item carries the reference.
        parts.push({
          type: "file",
          mediaType: "application/octet-stream",
          blobId: blobId as BlobId,
        })
      }
      changes.push(
        putItem(model, data.threadId, event.actorUserId, {
          kind: "user",
          id: event.id,
          threadId: data.threadId,
          at: event.at,
          authorId: event.actorUserId,
          parts,
        }),
        ...touchThread(model, data.threadId, event.at),
      )
      return changes
    }
    case "InputAnswered": {
      const timeline = model.timelines.get(data.threadId)
      const itemId = timeline?.inputByRequest.get(data.requestId)
      const row = itemId === undefined ? undefined : getItem(model, data.threadId, itemId)
      if (row === undefined || row.item.kind !== "input") return []
      return [
        putItem(model, data.threadId, event.actorUserId, {
          ...row.item,
          state: "answered",
          ...(data.optionId === null ? {} : { answeredWith: data.optionId }),
          ...(event.actorUserId === null ? {} : { answeredBy: event.actorUserId }),
        }),
      ]
    }
    case "TurnDispatched": {
      const participant = model.participants.get(participantKey(data.threadId, data.botId))
      const changes: RowChange[] = touchThread(model, data.threadId, event.at)
      if (participant !== undefined && participant.eveSessionId !== data.sessionId) {
        participant.eveSessionId = data.sessionId
        changes.push({ kind: "participant", row: participant })
      }
      return changes
    }
    case "TurnSettled":
      return touchThread(model, data.threadId, event.at)
    case "CheckpointWritten": {
      const thread = model.threads.get(data.threadId)
      if (thread === undefined) return []
      return [
        putItem(model, data.threadId, null, {
          kind: "system",
          id: `${event.id}/checkpoint`,
          threadId: data.threadId,
          at: event.at,
          event: "checkpoint",
          detail: changeSummary(data),
        }),
      ]
    }
    /*
     * The ask alone puts nothing in the timeline. The reactor does the work and
     * appends `CheckpointRestored`; until then there is nothing true to say.
     */
    case "CheckpointRestoreRequested":
      return []
    case "CheckpointRestored": {
      const thread = model.threads.get(data.threadId)
      if (thread === undefined) return []
      return [
        putItem(model, data.threadId, event.actorUserId, {
          kind: "system",
          id: `${event.id}/restored`,
          threadId: data.threadId,
          at: event.at,
          event: "restored",
          detail: data.checkpointId,
        }),
      ]
    }

    /* --- routines --- */
    case "RoutineCreated": {
      const row: RoutineRow = {
        id: data.routineId,
        orgId: event.orgId,
        botId: data.botId,
        threadId: data.threadId,
        name: data.name,
        cron: data.cron,
        tz: data.tz,
        prompt: data.prompt,
        runAs: data.runAs,
        enabled: true,
        blockedReason: null,
        lastRunAt: null,
      }
      model.routines.set(data.routineId, row)
      return [{ kind: "routine", row }]
    }
    case "RoutineEnabled": {
      const routine = model.routines.get(data.routineId)
      if (routine === undefined) return []
      routine.enabled = data.enabled
      return [{ kind: "routine", row: routine }]
    }
    case "RoutineRunAsChanged": {
      const routine = model.routines.get(data.routineId)
      if (routine === undefined) return []
      routine.runAs = data.runAs
      // A new run-as clears the block a departed member left behind.
      routine.blockedReason = null
      return [{ kind: "routine", row: routine }]
    }
    case "RoutineBlocked": {
      const routine = model.routines.get(data.routineId)
      if (routine === undefined) return []
      routine.blockedReason = data.reason
      return [{ kind: "routine", row: routine }]
    }
    case "RoutineDeleted": {
      model.routines.delete(data.routineId)
      return [{ kind: "routineDeleted", id: data.routineId }]
    }
    case "RoutineFired": {
      const routine = model.routines.get(data.routineId)
      if (routine === undefined) return []
      routine.lastRunAt = event.at
      return [{ kind: "routine", row: routine }]
    }

    /* --- connections --- */
    case "ServiceConnected": {
      const row: ConnectionRow = {
        id: data.connectionId,
        orgId: event.orgId,
        botId: data.botId,
        name: data.name,
        kind: data.kind,
        scope: data.scope,
        config: data.config,
        authKind: data.authKind,
      }
      model.connections.set(data.connectionId, row)
      return [{ kind: "connection", row }]
    }
    case "ServiceDisconnected": {
      model.connections.delete(data.connectionId)
      return [{ kind: "connectionDeleted", id: data.connectionId }]
    }

    /* --- the eve mirror --- */
    case "EveMirrored":
      return applyMirror(model, event, data)

    default:
      return []
  }
}

/* --- eve mirror events ------------------------------------------------------- */

type Mirrored = Extract<StoredEvent["data"], { readonly _tag: "EveMirrored" }>

const applyMirror = (
  model: ReadModel,
  event: StoredEvent,
  data: Mirrored,
): ReadonlyArray<RowChange> => {
  const changes: RowChange[] = []

  // Every mirrored event advances the participant's resume cursor.
  const participant = model.participants.get(participantKey(data.threadId, data.botId))
  if (participant !== undefined && participant.streamIndex <= data.streamIndex) {
    participant.streamIndex = data.streamIndex + 1
    if (participant.eveSessionId !== data.sessionId) participant.eveSessionId = data.sessionId
    changes.push({ kind: "participant", row: participant })
  }

  const payload = rec(data.payload)
  const threadId = data.threadId
  const turnId = str(payload["turnId"])
  const stepIndex = num(payload["stepIndex"]) ?? 0
  const sequence = num(payload["sequence"]) ?? 0

  switch (data.eveType) {
    case "message.appended":
    case "message.completed": {
      if (turnId === undefined) break
      // The visible message id IS the (turnId, stepIndex, sequence) triple, so
      // a retried step's re-emission lands on the same row: last writer wins.
      const id = `${turnId}/${stepIndex}/${sequence}`
      /*
       * eve names the reply differently on each event, and neither name is
       * `text`: an append carries `messageSoFar` (cumulative, which is why the
       * adapter can drop all but the last one in a flush window) alongside the
       * incremental `messageDelta`, and a completion carries `message`.
       * Reading `text` produced a correctly-shaped assistant row with an empty
       * body -- a reply the user could not see, for a turn they were billed
       * for. The cumulative field is always preferred; `messageDelta` is a last
       * resort so a delta-only shape still shows something.
       */
      const text =
        str(payload["message"]) ??
        str(payload["messageSoFar"]) ??
        str(payload["text"]) ??
        str(payload["messageDelta"]) ??
        ""
      changes.push(
        putItem(model, threadId, event.actorUserId, {
          kind: "assistant",
          id,
          threadId,
          at: event.at,
          botId: data.botId,
          turnId,
          parts: [{ type: "text", text }],
          ...(data.eveType === "message.completed"
            ? { finishReason: finishReason(payload["finishReason"]) }
            : {}),
        }),
      )
      break
    }

    case "reasoning.completed": {
      // The count persists; the words never do (03, "Retention").
      if (turnId === undefined) break
      const tokens =
        num(payload["tokens"]) ?? num(rec(payload["usage"])["reasoningTokens"]) ?? 0
      changes.push(
        putItem(model, threadId, event.actorUserId, {
          kind: "assistant",
          id: `${turnId}/${stepIndex}/${sequence}/reasoning`,
          threadId,
          at: event.at,
          botId: data.botId,
          turnId,
          parts: [{ type: "reasoning", tokens }],
        }),
      )
      break
    }

    case "actions.requested": {
      if (turnId === undefined) break
      const timeline = timelineOf(model, threadId)
      const calls = arr(payload["actions"] ?? payload["calls"] ?? payload["toolCalls"])
      for (const call of calls) {
        const c = rec(call)
        const callId = str(c["callId"]) ?? str(c["id"])
        if (callId === undefined) continue
        const id = `tool/${callId}`
        timeline.toolByCall.set(callId, id)
        const input = c["input"] ?? c["args"]
        changes.push(
          putItem(model, threadId, event.actorUserId, {
            kind: "tool",
            id,
            threadId,
            at: event.at,
            botId: data.botId,
            turnId,
            callId,
            name: str(c["toolName"]) ?? str(c["name"]) ?? "tool",
            state: "pending",
            ...(input === undefined ? {} : { input }),
          }),
        )
      }
      break
    }

    case "action.partial":
    case "action.result": {
      const callId = str(payload["callId"])
      if (callId === undefined) break
      const timeline = model.timelines.get(threadId)
      const itemId = timeline?.toolByCall.get(callId)
      const row = itemId === undefined ? undefined : getItem(model, threadId, itemId)
      if (row === undefined || row.item.kind !== "tool") break
      const output = payload["output"] ?? payload["result"]
      const durationMs = num(payload["durationMs"])
      changes.push(
        putItem(model, threadId, event.actorUserId, {
          ...row.item,
          state:
            data.eveType === "action.partial"
              ? "running"
              : payload["error"] === undefined
                ? "ok"
                : "error",
          ...(output === undefined ? {} : { output }),
          ...(durationMs === undefined ? {} : { durationMs }),
        }),
      )
      break
    }

    case "input.requested": {
      const timeline = timelineOf(model, threadId)
      for (const request of arr(payload["requests"])) {
        const r = rec(request)
        const requestId = str(r["requestId"])
        if (requestId === undefined) continue
        const id = `input/${requestId}`
        timeline.inputByRequest.set(requestId, id)
        const options: InputOption[] = []
        for (const option of arr(r["options"])) {
          const o = rec(option)
          const optionId = str(o["id"])
          if (optionId === undefined) continue
          options.push({ id: optionId, label: str(o["label"]) ?? optionId })
        }
        changes.push(
          putItem(model, threadId, event.actorUserId, {
            kind: "input",
            id,
            threadId,
            at: event.at,
            botId: data.botId,
            requestId,
            prompt: str(r["prompt"]) ?? str(r["question"]) ?? str(r["toolName"]) ?? "Approve?",
            ...(options.length === 0 ? {} : { options }),
            // eve nests the tool under `action`; older shapes put it at the top.
            ...(toolNameOf(r) === undefined ? {} : { toolName: toolNameOf(r) }),
            allowFreeform: str(r["kind"]) === "question",
            state: "pending",
          }),
        )
      }
      break
    }

    case "authorization.required": {
      if (event.actorUserId === null) break
      const name = str(payload["name"]) ?? "service"
      const authorization = rec(payload["authorization"])
      const id = `auth/${event.id}`
      timelineOf(model, threadId).authByName.set(`${data.botId}/${name}`, id)
      const url = str(authorization["url"])
      const userCode = str(authorization["userCode"])
      changes.push(
        putItem(model, threadId, event.actorUserId, {
          kind: "auth",
          id,
          threadId,
          at: event.at,
          botId: data.botId,
          forUserId: event.actorUserId,
          displayName: name,
          ...(url === undefined ? {} : { url }),
          ...(userCode === undefined ? {} : { userCode }),
          state: "pending",
        }),
      )
      break
    }

    case "authorization.completed": {
      const name = str(payload["name"]) ?? "service"
      const timeline = model.timelines.get(threadId)
      const itemId = timeline?.authByName.get(`${data.botId}/${name}`)
      const row = itemId === undefined ? undefined : getItem(model, threadId, itemId)
      if (row === undefined || row.item.kind !== "auth") break
      const outcome = str(payload["outcome"])
      const state: AuthState =
        outcome === "authorized" ? "completed" : outcome === "declined" ? "cancelled" : "failed"
      changes.push(putItem(model, threadId, event.actorUserId, { ...row.item, state }))
      break
    }

    case "subagent.called": {
      const childSessionId = str(payload["childSessionId"])
      if (childSessionId === undefined) break
      const id = `subagent/${childSessionId}`
      timelineOf(model, threadId).subagentBySession.set(childSessionId, id)
      changes.push(
        putItem(model, threadId, event.actorUserId, {
          kind: "subagent",
          id,
          threadId,
          at: event.at,
          botId: data.botId,
          childSessionId: childSessionId as SessionId,
          name: str(payload["name"]) ?? "subagent",
          state: "running",
        }),
      )
      break
    }

    case "subagent.completed": {
      const childSessionId = str(payload["childSessionId"])
      const timeline = model.timelines.get(threadId)
      const itemId =
        childSessionId === undefined ? undefined : timeline?.subagentBySession.get(childSessionId)
      const row = itemId === undefined ? undefined : getItem(model, threadId, itemId)
      if (row === undefined || row.item.kind !== "subagent") break
      changes.push(
        putItem(model, threadId, event.actorUserId, {
          ...row.item,
          state: payload["error"] === undefined ? "completed" : "failed",
        }),
      )
      break
    }

    case "compaction.completed":
      changes.push(
        putItem(model, threadId, null, {
          kind: "system",
          id: `${event.id}/compacted`,
          threadId,
          at: event.at,
          event: "compacted",
        }),
      )
      break

    case "context.cleared":
      changes.push(
        putItem(model, threadId, null, {
          kind: "system",
          id: `${event.id}/cleared`,
          threadId,
          at: event.at,
          event: "cleared",
        }),
      )
      break

    case "turn.cancelled": {
      // A cancelled turn must not leave rows claiming to run forever: sweep its
      // pending tools and inputs. Its stopped state itself is status, not a row.
      const timeline = model.timelines.get(threadId)
      if (timeline === undefined) break
      for (const row of timeline.items.values()) {
        const item = row.item
        if (
          item.kind === "tool" &&
          (turnId === undefined || item.turnId === turnId) &&
          (item.state === "pending" || item.state === "running")
        ) {
          changes.push(putItem(model, threadId, row.actorUserId, { ...item, state: "cancelled" }))
        }
        if (item.kind === "input" && item.state === "pending") {
          changes.push(putItem(model, threadId, row.actorUserId, { ...item, state: "cancelled" }))
        }
      }
      break
    }

    case "step.failed":
    case "turn.failed":
    case "session.failed":
      changes.push(
        putItem(model, threadId, event.actorUserId, {
          kind: "error",
          id: `error/${event.id}`,
          threadId,
          at: event.at,
          code: str(payload["code"]) ?? "unknown",
          message: str(payload["message"]) ?? "The turn failed.",
          retryable: data.eveType !== "session.failed",
        }),
      )
      break

    // reasoning.appended is streamed live by the gateway and never projected;
    // the remaining lifecycle events (session.*, turn.started, step.*) drive
    // status, which is in-memory, not a row.
    default:
      break
  }

  changes.push(...touchThread(model, threadId, event.at))
  return changes
}
