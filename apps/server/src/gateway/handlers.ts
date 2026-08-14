import { readdir, stat } from "node:fs/promises"
import { join, normalize } from "node:path"
import { Bot } from "@evie/contracts/bot"
import { aggregateOf, type Command } from "@evie/contracts/commands"
import {
  InvalidCommand,
  NotFound,
  PolicyViolation,
  StorageUnavailable,
} from "@evie/contracts/errors"
import type { EvieEvent } from "@evie/contracts/events"
import { EventId } from "@evie/contracts/ids"
import type { FileNode, Receipt } from "@evie/contracts/rpc"
import { Thread } from "@evie/contracts/thread"
import { TimelineItem } from "@evie/contracts/timeline"
import { CONTRACT_VERSION } from "@evie/contracts/version"
import { botDir } from "@evie/shared/home"
import { preview } from "@evie/shared/truncate"
import { ulid } from "@evie/shared/ulid"
import { Effect, Schema, Semaphore, Stream } from "effect"
import { SqlError } from "effect/unstable/sql/SqlError"
import { EvieConfig } from "../config.ts"
import { Db } from "../db/Db.ts"
import { decide } from "../domain/decide.ts"
import { foldAggregate, type Actor } from "../domain/state.ts"
import { ReactorWake } from "../reactors/runtime.ts"
import { Secrets, type SecretScope } from "../secrets/Secrets.ts"
import { EventStore, type AggregateKey } from "../store/EventStore.ts"
import { Hub } from "./hub.ts"
import { grantBlobUrl } from "./http.ts"
import { Auth, ConnectionState, EvieRpcAuthed, type OrgCommand } from "./middleware.ts"

/**
 * Every RPC in `EvieRpc`, implemented. Commands serialize per aggregate, fold,
 * decide, and append with the folded version; queries read the projections;
 * subscriptions attach to the hub. Authorization already ran in middleware --
 * nothing here checks a permission, only org scoping.
 */

const decodeEventId = Schema.decodeSync(EventId)
const decodeBot = Schema.decodeUnknownSync(Bot)
const decodeThread = Schema.decodeUnknownSync(Thread)
const decodeItem = Schema.decodeUnknownSync(TimelineItem)

const ORG_COMMAND_TAGS: ReadonlySet<string> = new Set([
  "InviteMember",
  "RevokeInvitation",
  "SetMemberRole",
  "RemoveMember",
  "CreateTeam",
  "DeleteTeam",
  "SetActiveOrg",
])

const isOrgCommand = (command: Command): command is OrgCommand =>
  ORG_COMMAND_TAGS.has(command._tag)

const makeReceipt = (eventId: EventId, aggregateVersion: number, resourceId?: string): Receipt => ({
  eventId,
  aggregateVersion,
  at: Date.now(),
  ...(resourceId === undefined ? {} : { resourceId }),
})

/** The id the caller now needs to address, when the command created something. */
const resourceIdOf = (event: EvieEvent): string | undefined => {
  switch (event._tag) {
    case "BotCreated":
      return event.botId
    case "ThreadOpened":
      return event.threadId
    case "RoutineCreated":
      return event.routineId
    case "ServiceConnected":
      return event.connectionId
    default:
      return undefined
  }
}

const appendInputOf = (event: EvieEvent, actor: Actor) => ({
  data: event,
  orgId: actor.orgId,
  threadId: "threadId" in event ? (event.threadId ?? null) : null,
  botId: "botId" in event ? event.botId : null,
  actorUserId: actor.userId,
})

/** The pure decider, with its refusals lifted from throws into typed failures. */
const decideEffect = (
  state: ReturnType<typeof foldAggregate>,
  command: Command,
  actor: Actor,
  orgMemberCount: number,
): Effect.Effect<ReadonlyArray<EvieEvent>, InvalidCommand | PolicyViolation> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(decide(state, command, actor, { now: Date.now(), newId: ulid, orgMemberCount }))
    } catch (error) {
      return error instanceof InvalidCommand || error instanceof PolicyViolation
        ? Effect.fail(error)
        : Effect.die(error)
    }
  })

/** Lock timeouts and busy writes degrade to a typed error, never a defect. */
const orStorage = <A, E, R>(
  effect: Effect.Effect<A, E | SqlError, R>,
): Effect.Effect<A, Exclude<E, SqlError> | StorageUnavailable, R> =>
  Effect.catch(effect, (error): Effect.Effect<never, Exclude<E, SqlError> | StorageUnavailable> =>
    error instanceof SqlError
      ? Effect.fail(new StorageUnavailable({ reason: error.message }))
      : Effect.fail(error as Exclude<E, SqlError>),
  )

export const HandlersLive = EvieRpcAuthed.toLayer(
  Effect.gen(function* () {
    const config = yield* EvieConfig
    const db = yield* Db
    const store = yield* EventStore
    const hub = yield* Hub
    const auth = yield* Auth
    const wake = yield* ReactorWake
    const secrets = yield* Secrets
    const sql = db.sql

    /**
     * The decider records that a secret exists; the VALUE never enters the
     * event log, so it has to land in the encrypted store here, from the
     * command payload, right after the append that recorded it. Grant tokens
     * are keyed `grant:<connectionId>` under the scope the event resolved.
     */
    const persistSecretPayloads = (
      decided: ReadonlyArray<EvieEvent>,
      command: Command,
      actor: Actor,
    ) =>
      Effect.forEach(
        decided,
        (event) => {
          switch (event._tag) {
            case "SecretSet":
              return command._tag === "SetSecret"
                ? secrets.set(event.scope as SecretScope, event.name, command.value)
                : Effect.void
            case "SecretRemoved":
              return secrets.remove(event.scope as SecretScope, event.name)
            case "GrantLinked": {
              if (command._tag !== "LinkMyGrant" || command.token === undefined) return Effect.void
              const scope: SecretScope =
                event.userId === null ? `org:${actor.orgId}` : `user:${event.userId}`
              return secrets.set(scope, `grant:${event.connectionId}`, command.token)
            }
            case "GrantRevoked": {
              const scope: SecretScope =
                event.userId === null ? `org:${actor.orgId}` : `user:${event.userId}`
              return secrets.remove(scope, `grant:${event.connectionId}`)
            }
            default:
              return Effect.void
          }
        },
        { discard: true },
      )

    /* --- command plumbing ------------------------------------------------- */

    // One mutex per aggregate, so at most one decider runs against it at a
    // time. Entries are a closure and a queue; a process's lifetime of
    // aggregates is small enough that the map never needs eviction.
    const semaphores = new Map<string, Semaphore.Semaphore>()
    const semaphoreFor = (key: string): Semaphore.Semaphore => {
      let semaphore = semaphores.get(key)
      if (semaphore === undefined) {
        semaphore = Semaphore.makeUnsafe(1)
        semaphores.set(key, semaphore)
      }
      return semaphore
    }

    /**
     * The aggregate must belong to the actor's ACTIVE org. Checked against the
     * event log rather than a projection so a just-created aggregate is
     * addressable before the projector's next flush. A miss and a foreign org
     * answer identically: existence is not leaked across organizations.
     */
    const ownedBy = Effect.fn("gateway.ownedBy")(function* (
      ref: { readonly kind: "bot" | "thread"; readonly id: string },
      orgId: string,
    ) {
      const rows = yield* orStorage(sql<{ org_id: string }>`
        select org_id from event
        where session_id = '' and ${sql.literal(ref.kind === "bot" ? "bot_id" : "thread_id")} = ${ref.id}
        limit 1`)
      if (rows[0]?.org_id !== orgId) {
        return yield* new NotFound({ resource: ref.kind, id: ref.id })
      }
    })

    const orgVersion = Effect.fn("gateway.orgVersion")(function* (orgId: string) {
      const rows = yield* orStorage(sql<{ n: number | bigint }>`
        select count(*) as n from event where session_id = '' and org_id = ${orgId}`)
      return Number(rows[0]?.n ?? 0)
    })

    const dispatch = Effect.fn("gateway.dispatch")(function* (actor: Actor, command: Command) {
      const ref = aggregateOf(command)
      const key: AggregateKey = ref.kind === "org" ? { kind: "org", id: actor.orgId } : ref
      if (ref.kind !== "org") yield* ownedBy(ref, actor.orgId)
      const orgMemberCount = yield* auth.memberCount(actor.orgId)

      // The whole fold-decide-append cycle, so the one retry after a
      // ConcurrencyConflict refolds against the moved aggregate.
      const cycle = Effect.gen(function* () {
        const { events, version } = yield* orStorage(store.readAggregate(key))
        const folded = foldAggregate(key.kind, events.map((stored) => stored.data))
        const decided = yield* decideEffect(folded, command, actor, orgMemberCount)
        if (decided.length === 0) {
          // An already-true state is a no-op success. There is no event to
          // point at, so the receipt carries a fresh id at the same version.
          return makeReceipt(decodeEventId(ulid()), version)
        }
        const stored = yield* orStorage(
          store.append(
            decided.map((event) => appendInputOf(event, actor)),
            { aggregate: key, expectedVersion: version },
          ),
        )
        // Reactors sleep on a latch; the append is what they are waiting for.
        yield* wake.notify
        yield* orStorage(db.retryLocked(persistSecretPayloads(decided, command, actor)))
        const last = stored[stored.length - 1]
        return makeReceipt(
          last === undefined ? decodeEventId(ulid()) : last.id,
          version + decided.length,
          decided[0] === undefined ? undefined : resourceIdOf(decided[0]),
        )
      })

      return yield* Semaphore.withPermit(
        semaphoreFor(`${key.kind}:${key.id}`),
        db.retryConflict(cycle),
      )
    })

    /* --- shared row readers ------------------------------------------------ */

    interface BotRow {
      readonly id: string
      readonly org_id: string
      readonly team_id: string | null
      readonly slug: string
      readonly name: string
      readonly description: string | null
      readonly avatar: string | null
      readonly model: string
      readonly reasoning: string | null
      readonly runtime_mode: string
      readonly sandbox: string
      readonly health: string
      readonly created_by: string
      readonly created_at: number | bigint
      readonly archived_at: number | bigint | null
    }

    // The projector persists `sandbox` and `health` as JSON; the migration's
    // 'idle' default predates the first health write, hence the fallback.
    const jsonOr = (text: string, fallback: unknown): unknown => {
      try {
        return text.startsWith("{") ? JSON.parse(text) : fallback
      } catch {
        return fallback
      }
    }

    const botOf = (row: BotRow): ReadonlyArray<Bot> => {
      try {
        return [
          decodeBot({
            id: row.id,
            orgId: row.org_id,
            teamId: row.team_id,
            slug: row.slug,
            name: row.name,
            description: row.description,
            avatar: row.avatar,
            model: row.model,
            reasoning: row.reasoning,
            runtimeMode: row.runtime_mode,
            sandbox: jsonOr(row.sandbox, {
              backend: "docker",
              network: { mode: "deny-all", allow: [], enforced: "coarse" },
            }),
            health: jsonOr(row.health, { kind: row.health }),
            createdBy: row.created_by,
            createdAt: Number(row.created_at),
            archivedAt: row.archived_at === null ? null : Number(row.archived_at),
          }),
        ]
      } catch {
        // A row this build cannot decode is skipped, never fatal for the list.
        return []
      }
    }

    const previewOf = (body: string | null): string | null => {
      if (body === null) return null
      try {
        const item = JSON.parse(body) as {
          kind?: string
          name?: string
          message?: string
          parts?: ReadonlyArray<{ type?: string; text?: string }>
        }
        if (item.kind === "user" || item.kind === "assistant") {
          const text = item.parts?.find((part) => part.type === "text" && typeof part.text === "string")
          return text?.text === undefined || text.text.length === 0 ? null : preview(text.text)
        }
        if (item.kind === "tool" && typeof item.name === "string") return preview(`Ran ${item.name}`)
        if (item.kind === "error" && typeof item.message === "string") return preview(item.message)
        return null
      } catch {
        return null
      }
    }

    const threadInOrg = Effect.fn("gateway.threadInOrg")(function* (threadId: string, orgId: string) {
      yield* ownedBy({ kind: "thread", id: threadId }, orgId)
    })

    /* --- the handlers ------------------------------------------------------ */

    return {
      "session.hello": (_payload, options) =>
        Effect.gen(function* () {
          // Version + auth already passed in middleware, or we would not be here.
          const info = yield* auth.sessionInfo(options.headers)
          return { contractVersion: CONTRACT_VERSION, mode: config.mode, ...info }
        }),

      command: (payload, options) =>
        Effect.gen(function* () {
          const conn = yield* ConnectionState
          const command = payload.command

          if (isOrgCommand(command)) {
            // Better Auth is the authority here, not the decider. Its mutation
            // runs exactly once; the event is a record, so it appends without
            // an expectedVersion (there is no decision left to guard).
            const result = yield* auth.executeOrgCommand(command, options.headers)
            if (result.actor !== undefined) conn.actor = result.actor
            const orgId: string = conn.actor.orgId
            let eventId = decodeEventId(ulid())
            if (result.event !== null) {
              const stored = yield* orStorage(
                store.append([appendInputOf(result.event, conn.actor)], {
                  aggregate: { kind: "org", id: orgId },
                }),
              )
              if (stored[0] !== undefined) eventId = stored[0].id
              yield* wake.notify
            }
            const version = yield* orgVersion(orgId)
            return makeReceipt(eventId, version, result.resourceId)
          }

          return yield* dispatch(conn.actor, command)
        }),

      /* --- queries --------------------------------------------------------- */

      "bots.list": (payload) =>
        Effect.gen(function* () {
          const conn = yield* ConnectionState
          const rows = yield* orStorage(sql<BotRow>`
            select * from bot
            where org_id = ${conn.actor.orgId}
              and (${payload.includeArchived === true ? sql`1 = 1` : sql`archived_at is null`})
            order by created_at asc`)
          return rows.flatMap(botOf)
        }),

      "threads.list": (payload) =>
        Effect.gen(function* () {
          const conn = yield* ConnectionState
          const filter = payload.filter ?? "active"
          const before = payload.before ?? Number.MAX_SAFE_INTEGER
          const limit = Math.min(Math.max(payload.limit ?? 50, 1), 200)
          const now = Date.now()
          const filterClause =
            filter === "archived"
              ? sql`archived_at is not null`
              : filter === "snoozed"
                ? sql`archived_at is null and snoozed_until is not null and snoozed_until > ${now}`
                : sql`archived_at is null and (snoozed_until is null or snoozed_until <= ${now})`

          interface ThreadRow {
            readonly id: string
            readonly org_id: string
            readonly title: string | null
            readonly created_by: string
            readonly created_at: number | bigint
            readonly last_activity: number | bigint
            readonly snoozed_until: number | bigint | null
            readonly archived_at: number | bigint | null
            readonly last_body: string | null
          }
          const rows = yield* orStorage(sql<ThreadRow>`
            select t.*, (
              select body from timeline_item i
              where i.thread_id = t.id order by i.seq desc limit 1
            ) as last_body
            from thread t
            where t.org_id = ${conn.actor.orgId} and t.last_activity < ${before} and (${filterClause})
            order by t.last_activity desc limit ${limit}`)

          interface ParticipantRow {
            readonly thread_id: string
            readonly bot_id: string
            readonly eve_session_id: string | null
            readonly stream_index: number | bigint
            readonly is_default: number | bigint
          }
          const participantRows =
            rows.length === 0
              ? []
              : yield* orStorage(sql<ParticipantRow>`
                  select * from thread_participant
                  where ${sql.in("thread_id", rows.map((row) => row.id))}`)
          const participantsByThread = new Map<string, Array<ParticipantRow>>()
          for (const row of participantRows) {
            const list = participantsByThread.get(row.thread_id) ?? []
            list.push(row)
            participantsByThread.set(row.thread_id, list)
          }

          const items = rows.flatMap((row): ReadonlyArray<Thread> => {
            try {
              return [
                decodeThread({
                  id: row.id,
                  orgId: row.org_id,
                  title: row.title,
                  participants: (participantsByThread.get(row.id) ?? []).map((participant) => ({
                    botId: participant.bot_id,
                    eveSessionId: participant.eve_session_id,
                    streamIndex: Number(participant.stream_index),
                    isDefault: Number(participant.is_default) === 1,
                  })),
                  status: hub.statusOf(row.id),
                  preview: previewOf(row.last_body),
                  createdBy: row.created_by,
                  createdAt: Number(row.created_at),
                  lastActivity: Number(row.last_activity),
                  snoozedUntil: row.snoozed_until === null ? null : Number(row.snoozed_until),
                  archivedAt: row.archived_at === null ? null : Number(row.archived_at),
                }),
              ]
            } catch {
              return []
            }
          })

          const lastRow = rows[rows.length - 1]
          return {
            items,
            nextBefore: rows.length === limit && lastRow !== undefined ? Number(lastRow.last_activity) : null,
          }
        }),

      "threads.timeline": (payload) =>
        Effect.gen(function* () {
          const conn = yield* ConnectionState
          yield* threadInOrg(payload.threadId, conn.actor.orgId)
          const before = payload.before ?? Number.MAX_SAFE_INTEGER
          const limit = Math.min(Math.max(payload.limit ?? 100, 1), 500)
          const rows = yield* orStorage(sql<{ body: string; seq: number | bigint }>`
            select body, seq from timeline_item
            where thread_id = ${payload.threadId} and seq < ${before}
            order by seq desc limit ${limit}`)
          const items: Array<TimelineItem> = []
          for (const row of rows) {
            try {
              items.push(decodeItem(JSON.parse(row.body)))
            } catch {
              // A row this build cannot decode is skipped, not fatal.
            }
          }
          items.reverse()
          const oldest = rows[rows.length - 1]
          return {
            items,
            nextBefore: rows.length === limit && oldest !== undefined ? Number(oldest.seq) : null,
          }
        }),

      "org.members": (_payload, options) => auth.members(options.headers),

      "secrets.list": (payload) =>
        Effect.gen(function* () {
          const conn = yield* ConnectionState
          const scopes = [`org:${conn.actor.orgId}`, `user:${conn.actor.userId}`]
          if (payload.botId !== undefined) {
            yield* ownedBy({ kind: "bot", id: payload.botId }, conn.actor.orgId)
            scopes.push(`bot:${payload.botId}`)
          }
          const rows = yield* orStorage(sql<{ scope: string; name: string; hint: string | null }>`
            select scope, name, hint from secret
            where ${sql.in("scope", scopes)}
            order by scope asc, name asc`)
          // Name and hint only. The value never crosses this socket -- not to
          // an owner, not over loopback.
          return rows.map((row) => ({
            scope: row.scope,
            name: row.name,
            hint: row.hint,
            configured: true,
          }))
        }),

      "plugins.catalog": (payload) =>
        Effect.gen(function* () {
          const conn = yield* ConnectionState
          const rows = yield* orStorage(
            payload.botId === undefined
              ? sql<{ name: string }>`
                  select distinct name from connection where org_id = ${conn.actor.orgId}`
              : sql<{ name: string }>`
                  select name from connection
                  where org_id = ${conn.actor.orgId} and bot_id = ${payload.botId}`,
          )
          // The curated marketplace ships with the connections catalog (specs/06, Phase 2).
          return { listings: [], installed: rows.map((row) => row.name) }
        }),

      "computer.list": (payload) =>
        Effect.gen(function* () {
          const conn = yield* ConnectionState
          yield* ownedBy({ kind: "bot", id: payload.botId }, conn.actor.orgId)
          const base = botDir(config.home, conn.actor.orgId, payload.botId)
          // `join("/", …)` pins the request path under the bot dir: whatever
          // `..` games the path plays resolve before it is joined to `base`.
          const relative = normalize(join("/", payload.path))
          const target = join(base, relative)
          const nodes = yield* Effect.tryPromise({
            try: async (): Promise<Array<FileNode>> => {
              const entries = await readdir(target, { withFileTypes: true })
              return Promise.all(
                entries.map(async (entry): Promise<FileNode> => {
                  const path = join(relative, entry.name)
                  if (entry.isDirectory()) return { path, name: entry.name, kind: "dir" }
                  const size = await stat(join(target, entry.name))
                    .then((s) => s.size)
                    .catch(() => undefined)
                  return {
                    path,
                    name: entry.name,
                    kind: "file",
                    ...(size === undefined ? {} : { size }),
                  }
                }),
              )
            },
            catch: () => new NotFound({ resource: "path", id: payload.path }),
          })
          return nodes.sort((a, b) =>
            a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1,
          )
        }),

      "blobs.grant": (payload) =>
        Effect.gen(function* () {
          const conn = yield* ConnectionState
          // The caller's ACTIVE org must hold a reference. Knowing the id --
          // a guessable content hash -- is never the authorization.
          const rows = yield* orStorage(sql<{ blob_id: string }>`
            select blob_id from blob_ref
            where blob_id = ${payload.blobId} and org_id = ${conn.actor.orgId}`)
          if (rows.length === 0) {
            return yield* new NotFound({ resource: "blob", id: payload.blobId })
          }
          return grantBlobUrl(payload.blobId, conn.actor.orgId)
        }),

      /* --- subscriptions ---------------------------------------------------- */

      "threads.subscribe": (payload) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const conn = yield* ConnectionState
            yield* threadInOrg(payload.threadId, conn.actor.orgId)
            return hub.subscribeThread(payload.threadId, {
              ...(payload.since === undefined ? {} : { since: payload.since }),
              // Read live so a `reasoning.watch` mid-turn takes effect on the
              // next delta, not the next subscription.
              watching: (itemId) => conn.watchedReasoning.has(`${payload.threadId}/${itemId}`),
            })
          }),
        ),

      "fleet.subscribe": () =>
        Stream.unwrap(Effect.map(ConnectionState, (conn) => hub.subscribeFleet(conn.actor.orgId))),

      "reasoning.watch": (payload) =>
        Effect.gen(function* () {
          const conn = yield* ConnectionState
          const key = `${payload.threadId}/${payload.itemId}`
          if (payload.watching) {
            conn.watchedReasoning.add(key)
          } else {
            conn.watchedReasoning.delete(key)
          }
        }),

      "presence.set": (payload) =>
        Effect.gen(function* () {
          const conn = yield* ConnectionState
          conn.openThreads = payload.openThreads
        }),
    }
  }),
)
