# 03 — Contracts and data

## `packages/contracts`

Everything that crosses the wire is an Effect Schema in `@evie/contracts`. Change the schema and the
server, web, and desktop all follow or fail to compile. No heavy runtime logic lives here — schemas,
branded ids, and the `RpcGroup` definitions only.

```
packages/contracts/src/
  ids.ts          branded ids: OrgId, UserId, BotId, ThreadId, MessageId, TurnId, SessionId,
                  RoutineId, BlobId
  version.ts      CONTRACT_VERSION — bumped whenever any schema here changes shape
  bot.ts          Bot, BotHealth, ModelRef, SandboxBackend, NetworkPolicy
  thread.ts       Thread, Participant, ThreadStatus
  timeline.ts     TimelineItem and its parts — the projected message model
  eve.ts          eve stream event schemas (mirrors eve's wire format; adapter-internal)
  commands.ts     the command vocabulary
  rpc.ts          RpcGroup definitions
  errors.ts       Schema.TaggedError types shared by client and server
```

**Schemas are the source; types are derived.** Every model in here is declared once as an Effect
Schema, and its TypeScript type is `typeof Thing.Type` — never a hand-written `interface` sitting
next to the schema. Two declarations of the same shape drift, and the drift shows up as a runtime
decode failure in production rather than a compile error in review. This is the one rule in
`packages/contracts` worth enforcing in code review.

### Transport

`RpcServer` over a WebSocket, `RpcSerialization.msgPack`. MsgPack rather than JSON because the
timeline is the hot path and text deltas plus tool payloads dominate the byte budget.

Three RPC shapes:

- **Commands** — request/response. Return a receipt id, never a rendered result.
- **Queries** — request/response, cursor-paged.
- **Subscriptions** — `RpcSchema.Stream`. One per open thread, plus a fleet-level one.

```ts
// packages/contracts/src/rpc.ts (shape, not final)
import { Schema } from "effect"
import { Rpc, RpcGroup, RpcSchema } from "effect/unstable/rpc"

export class EvieRpc extends RpcGroup.make(
  // Must be the first call on a fresh connection. Everything else fails with
  // HandshakeRequired until it succeeds.
  Rpc.make("session.hello", {
    payload: Schema.Struct({ contractVersion: Schema.Number }),
    success: Schema.Struct({ contractVersion: Schema.Number, orgId: OrgId, userId: UserId }),
    error: EvieError,
  }),
  Rpc.make("bots.list", { success: Schema.Array(Bot), error: EvieError }),
  Rpc.make("bots.create", { payload: CreateBot, success: BotId, error: EvieError }),
  Rpc.make("threads.timeline", {
    // Paged by the projection's own monotonic seq, which is the table's paging key.
    // Not by MessageId: tool, input, auth, and system rows have ids that are not message ids.
    payload: Schema.Struct({
      threadId: ThreadId,
      before: Schema.optional(Schema.Number),
      limit: Schema.optional(Schema.Number),
    }),
    success: Schema.Struct({ items: Schema.Array(TimelineItem), nextBefore: Schema.NullOr(Schema.Number) }),
    error: EvieError,
  }),
  Rpc.make("threads.subscribe", {
    payload: Schema.Struct({ threadId: ThreadId, since: Schema.optional(Schema.Number) }),
    success: RpcSchema.Stream(TimelineFrame, EvieError),
  }),
  Rpc.make("threads.send", { payload: SendMessage, success: TurnId, error: EvieError }),
  Rpc.make("turns.cancel", {
    payload: Schema.Struct({ threadId: ThreadId, turnId: TurnId }),
    error: EvieError,
  }),
  Rpc.make("input.respond", { payload: AnswerInput, error: EvieError }),
  // Bytes never cross this socket. `blobs.grant` mints a short-lived signed token,
  // the client then does GET /blob/:id with it. See the frame budget below.
  Rpc.make("blobs.grant", {
    payload: BlobId,
    success: Schema.Struct({ url: Schema.String, expiresAt: Schema.Number }),
    error: EvieError,
  }),
) {}
```

### The handshake

`session.hello` carries `CONTRACT_VERSION` from `@evie/contracts`, compiled into both sides. The
server compares it to its own and refuses a mismatch with a typed `ContractMismatch` error naming
both versions, which the client renders as *"Update Evie to keep using this environment"* rather
than as a decode failure twenty frames later.

This is what makes [04's](./04-clients.md#desktop-specifics) "a client is never newer than its
server" enforceable instead of aspirational. It matters most for the remote surfaces: a browser tab
on tryevie.ai can easily be a version ahead of the environment it dials into.

### Frame budget

A `TimelineFrame` is a batch of deltas for one thread, emitted at most once per **50 ms** per
subscriber. The server holds the cumulative text eve already gives it and sends only the suffix.

Rules the gateway enforces, per subscriber:

| Rule                        | Value                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| Frame cadence               | **Demand-scheduled, not periodic.** The first pending delta arms a 50 ms timeout; the flush sends the frame and disarms it. An idle thread has no timer at all. |
| Reasoning text              | Not sent unless the client has opted into that specific reasoning block                      |
| Tool payloads               | > 8 KiB → first 2 KiB + last 2 KiB + `blobId`; the client calls `blobs.grant` and fetches the rest over HTTP on expand |
| Attachment and blob bytes   | Never on the RPC socket, and there is no RPC that returns them. `GET /blob/:id` with a signed, short-lived token from `blobs.grant`, checked against the caller's active organization — never on knowledge of the id alone. |
| Backpressure                | Bounded mailbox per subscriber. On overflow, **coalesce** — merge pending deltas, drop nothing that changes final state. Never grow the queue. |
| Slow consumer               | Three consecutive overflow windows → downgrade to *summary mode* (turn boundaries only) and tell the client, which shows a *catching up* chip. |

The cadence rule is worth stating precisely because the obvious implementation — a `setInterval`
per subscriber — quietly breaks [04's](./04-clients.md#performance-budget) *"idle CPU ~0%, no
timers, no polling"* budget. A user with eight threads open and nothing running would be waking the
process 160 times a second to decide it has nothing to say. Arm on demand, disarm on flush.

This is the concrete answer to `AGENTS.md`'s "sending too much data over websockets" regression
class. eve's raw stream is chatty by design — every reasoning delta carries the cumulative text so
far — and forwarding it verbatim would be the single easiest way to make Evie feel slow.

## Timeline model

The projected model the UI renders. Deliberately flatter than eve's event stream.

Declared as a `Schema.Union` of tagged structs in `timeline.ts`; the shape below is the decoded
type, which is `typeof TimelineItem.Type` and is never written out by hand. Every variant carries
`id`, `threadId`, `seq`, and `at`, elided here for readability.

```ts
type TimelineItem =
  | { kind: "user";     authorId: UserId; parts: Part[] }
  | { kind: "assistant";botId: BotId; turnId: TurnId; parts: Part[]; finishReason?: FinishReason }
  | { kind: "tool";     botId: BotId; turnId: TurnId; callId: string; name: string
                        state: ToolState; input?: Json; output?: Json; blobId?: BlobId }
  | { kind: "input";    botId: BotId; requestId: string; prompt: string
                        options?: InputOption[]; allowFreeform: boolean; state: InputState }
  | { kind: "auth";     botId: BotId; forUserId: UserId; displayName: string
                        url?: string; userCode?: string; state: AuthState }
  | { kind: "subagent"; botId: BotId; childSessionId: SessionId; name: string; state: SubagentState }
  | { kind: "system";   event: "compacted" | "cleared" | "checkpoint" | "restored" }
  | { kind: "error";    code: string; message: string; retryable: boolean }

type Part =
  | { type: "text"; text: string }
  // `text` is present only while the turn is live and only for a client that opted into this
  // block. It is never persisted, so a reopened thread always decodes to the count alone.
  | { type: "reasoning"; tokens: number; text?: string }
  | { type: "file"; mediaType: string; filename?: string; size?: number; blobId?: BlobId }
```

Three invariants:

- **A tool call is a first-class item, not a message part.** It has its own row, its own lifecycle,
  and its own expansion state. Collapsing tools is then a list operation, not a re-parse.
- **Reasoning carries a count, and sometimes a body.** The count always persists so the UI can size
  the row and say *thought for 4.2k tokens* months later; the body exists only in flight. Note that
  `text` is optional rather than the row carrying `collapsed: true` — expansion is client state, and
  a field that can only ever hold one value is a field that will be lied to later.
- **An `auth` row names its subject.** `forUserId` is what lets the client render an actionable
  sign-in button for Ana and an inert "waiting for Ana" row for everyone else
  ([04](./04-clients.md#the-chat-view)). Without it on the wire, that distinction cannot be made.

## SQLite schema

One file, `state.sqlite`, WAL mode, `busy_timeout=250`, `synchronous=NORMAL`, `foreign_keys=ON`.
`node:sqlite` via `@effect/sql-sqlite-node` — no native module, so Electron needs no rebuild step,
and eve already requires Node 24 so the runtime is guaranteed.

**One connection writes this file.** `node:sqlite` is synchronous, so a second writer in the same
process turns lock contention into an event-loop stall that freezes every stream at once. The full
argument and the fallback are in
[02](./02-architecture.md#one-writer-and-why-that-is-a-hard-rule); the consequence here is that
`busy_timeout` is 250 ms rather than the 5 s a two-writer design would need, and that Better Auth
executes through `Db` rather than opening the file itself.

Two migration owners share the file. Better Auth owns its tables — `user`, `session`, `account`,
`verification`, `passkey`, and from the organization plugin `organization`, `member`, `invitation`,
`team`, `teamMember` — and Evie owns the rest. Better Auth's migrations run first at boot via its
programmatic `getMigrations()`; `SqliteMigrator` then runs Evie's. Evie migrations never reference
auth tables except by `user.id`, `organization.id`, and `team.id`.

**Every Evie row is org-scoped from the first migration.** There is no single-owner variant of this
schema that teams get bolted onto later; `local` mode is just an organization with one member.

```sql
-- Bots -----------------------------------------------------------------
create table bot (
  id            text primary key,           -- ULID
  org_id        text not null,              -- organization.id
  team_id       text,                       -- team.id, or null for org-wide
  slug          text not null,
  name          text not null,
  description   text,
  avatar        text,
  dir           text not null,              -- <home>/userdata/orgs/<org_id>/bots/<id>
  model         text not null,              -- AI Gateway model id, e.g. "anthropic/claude-opus-4.8"
  reasoning     text,                       -- none|minimal|low|medium|high|xhigh
  runtime_mode  text not null default 'dev',-- dev|built
  sandbox       text not null,              -- json: backend + resolved network policy
  health        text not null default 'idle',
  created_by    text not null,              -- user.id
  created_at    integer not null,
  archived_at   integer,                    -- reverse state for archive
  unique (org_id, slug)
);
create index bot_org on bot(org_id, archived_at);

-- Threads --------------------------------------------------------------
create table thread (
  id            text primary key,
  org_id        text not null,
  title         text,
  created_by    text not null,              -- user.id
  created_at    integer not null,
  last_activity integer not null,
  snoozed_until integer,                    -- reverse state for snooze
  archived_at   integer
);
create index thread_activity on thread(org_id, archived_at, last_activity desc);

create table thread_participant (
  thread_id     text not null references thread(id) on delete cascade,
  bot_id        text not null references bot(id),
  eve_session_id text,                      -- null until the first turn
  stream_index  integer not null default 0, -- ingestion cursor into eve's stream
  is_default    integer not null default 0,
  primary key (thread_id, bot_id)
);

-- Timeline projection --------------------------------------------------
-- `body` is the whole TimelineItem as json. That is right for a read model the UI renders
-- wholesale, and wrong if it is rewritten per delta: a streaming reply would rewrite the same
-- row hundreds of times a second. Rows are written on the ingestion flush tick, batched with
-- everything else in that transaction -- see 02, Ingestion.
create table timeline_item (
  id            text primary key,
  thread_id     text not null references thread(id) on delete cascade,
  seq           integer not null,           -- monotonic within thread; the paging key
  kind          text not null,
  bot_id        text,
  actor_user_id text,                       -- who sent it, for user rows
  turn_id       text,
  body          text not null,              -- json TimelineItem
  at            integer not null
);
create unique index timeline_seq on timeline_item(thread_id, seq);

-- Event mirror ---------------------------------------------------------
-- The key is (session_id, id), not id. `id` is a ULID minted by a runtime we supervise but do
-- not control, and these rows are inserted `on conflict do nothing` -- so a bare global primary
-- key would turn any collision into an event silently disappearing. Evie-minted product events
-- use session_id = '' and are unique on their own.
create table event (
  id            text not null,              -- eve meta.id (ULID) or an Evie-minted ULID
  session_id    text not null default '',   -- '' for Evie's own product events
  seq           integer not null,           -- process-wide monotonic; what reactor_cursor tracks
  org_id        text not null,
  thread_id     text,
  bot_id        text,
  actor_user_id text,                       -- the member this turn acted as; null for system events
  stream_index  integer,                    -- absolute position in eve's stream
  type          text not null,
  data          text not null,              -- json
  at            integer not null,
  primary key (session_id, id)
);
create unique index event_seq on event(seq);
create index event_session on event(session_id, stream_index);
create index event_thread on event(thread_id, at);
create index event_actor on event(org_id, actor_user_id, at);
create index event_at on event(at);         -- the retention sweep's access path

-- Reactor cursors ------------------------------------------------------
-- Why reactors are durable subscriptions rather than in-memory queues: 02, Reactors resume.
-- `event.seq` is monotonic but NOT contiguous: a duplicate that loses to `on conflict do nothing`
-- consumes a seq and leaves a gap. Reactors read `where seq > last_seq order by seq` and must
-- never wait for a specific next value.
create table reactor_cursor (
  reactor       text primary key,           -- turn|routine|checkpoint|notify|supervisor
  last_seq      integer not null default 0, -- last event.seq fully handled
  updated_at    integer not null
);

-- Routines (Bot's "routines panel") ------------------------------------
create table routine (
  id            text primary key,
  org_id        text not null,
  bot_id        text not null references bot(id) on delete cascade,
  thread_id     text,                       -- deliver into an existing thread, or null for a new one
  name          text not null,
  cron          text not null,              -- 5-field
  tz            text not null,              -- IANA zone, e.g. 'America/New_York'
  prompt        text not null,
  run_as        text,                       -- user.id; REQUIRED once the bot has a member-scoped
                                            -- connection, else eve fails with principal_required
  enabled       integer not null default 1,
  blocked_reason text,                      -- e.g. run_as member left the org
  last_run_at   integer,
  next_run_at   integer,
  last_status   text
);
create index routine_due on routine(enabled, next_run_at);
-- `tz` is stored per routine, not inherited from the host. A laptop that crosses a timezone, a
-- DST transition, or an environment moved to a new machine would otherwise silently shift every
-- schedule -- and `next_run_at` is a cache, always recomputed from (cron, tz), never trusted
-- across a restart.

-- Connections ----------------------------------------------------------
create table connection (
  id            text primary key,
  org_id        text not null,
  bot_id        text not null references bot(id) on delete cascade,
  name          text not null,              -- becomes agent/connections/<name>.ts
  kind          text not null,              -- mcp|openapi
  scope         text not null default 'org',-- org (principalType app) | member (principalType user)
  config        text not null,              -- json: url/spec, filters, approval policy
  auth_kind     text not null,              -- none|token|interactive
  unique (bot_id, name)
);

-- One row per member who has linked a member-scoped connection.
-- An org-scoped connection has exactly one row with user_id null.
create table connection_grant (
  connection_id text not null references connection(id) on delete cascade,
  user_id       text not null default '',   -- '' for org scope; SQLite has no nullable PK column
  state         text not null default 'unauthorized',
  secret_id     text references secret(id),
  linked_at     integer,
  primary key (connection_id, user_id)
);

-- Secrets --------------------------------------------------------------
create table secret (
  id            text primary key,
  scope         text not null,              -- org:<id> | bot:<id> | user:<id>
  name          text not null,              -- AI_GATEWAY_API_KEY, LINEAR_API_TOKEN, ...
  nonce         blob not null,
  ciphertext    blob not null,
  hint          text,                       -- last 4 chars, safe to show a client
  created_at    integer not null,
  unique (scope, name)
);

-- Checkpoints ----------------------------------------------------------
create table checkpoint (
  id            text primary key,
  thread_id     text not null references thread(id) on delete cascade,
  turn_id       text not null,
  sha           text not null,
  created_at    integer not null
);

-- Blobs ----------------------------------------------------------------
-- Content and ownership are two different facts and need two tables. A blob id is a content
-- hash, so two organizations that upload the same file produce the same id -- putting org_id on
-- the content row makes that a primary-key conflict, and resolving it with `on conflict do
-- nothing` would silently leave org B's attachment owned by org A. Content is deduped; access
-- is per-org.
create table blob (
  id            text primary key,           -- content hash
  media_type    text not null,
  size          integer not null,
  path          text not null,              -- content-addressed path under userdata/blobs/
  created_at    integer not null
);

-- One row per organization that has a claim on this content. /blob/:id is an HTTP route and a
-- content hash is guessable enough that "you knew the id" must never be the authorization check:
-- the route resolves the caller's active org and requires a matching row here.
create table blob_ref (
  blob_id       text not null references blob(id) on delete cascade,
  org_id        text not null,
  created_at    integer not null,
  primary key (blob_id, org_id)
);
create index blob_ref_org on blob_ref(org_id);

-- Devices --------------------------------------------------------------
create table device (
  id            text primary key,
  user_id       text not null,
  kind          text not null,              -- web|desktop
  label         text,
  push_endpoint text,
  last_seen     integer not null,
  revoked_at    integer                     -- reverse state for pairing
);
```

### Retention, and why reasoning is never written down

Modern models "think" before they answer, and eve streams that thinking as its own event type. It is
often longer than the answer itself, and every delta carries the full cumulative text so far, so it
is by far the largest thing flowing through the system.

**Decision: reasoning text is streamed live and then discarded.** It is never written to the `event`
mirror and never stored in a `timeline_item`. What persists is a count — so the UI can still say
*thought for 4.2k tokens* on a thread you reopen next month, it just cannot replay the words.

Three reasons, in order of weight:

1. **It is the most sensitive text the model produces.** Thinking is where a model works through
   half-formed guesses about the user, the data, and the task. eve's own docs flag the privacy and
   confidentiality implications of storing or transmitting it. In a team environment, one member's
   reasoning transcript becoming durable, admin-readable history is a real problem.
2. **It dominates disk for almost no value.** Nobody reopens a two-month-old thread to reread the
   thinking.
3. **You still get it when it matters** — live, while the turn runs, which is when it is actually
   useful for spotting a bot going off the rails.

If someone wants it back, it is one branch in the ingestion path plus a Settings toggle. The default
is off.

Everything else:

- `event` rows older than 30 days are deleted for threads with no activity in that window (the
  sweep runs over `event_at`); the `timeline_item` projection is kept. A thread whose events are
  gone can still render — it just can't rebuild a projection from scratch.
  - The sweep never deletes past the lowest `reactor_cursor.last_seq`. A reactor that has not yet
    caught up still needs the events it owes work on, and 30 days of downtime is not a reason to
    drop them silently.
- Blobs are swept weekly in two steps, matching the two tables: a `blob_ref` is dropped when no
  `timeline_item` in that organization references it, and the underlying `blob` and its file are
  removed only when its last `blob_ref` is gone. Deleting an org's attachment must never delete
  the bytes another org still points at.
- `VACUUM INTO` is the only supported way to snapshot the database, including for test data. A
  plain `cp` of a live file is a corrupt copy.

## Test data

Per `AGENTS.md`: an empty database is a bad test. Seed a worktree's `.evie/userdata` from the
developer's real `~/.evie/userdata` with `VACUUM INTO`, which is safe while a server holds the
source open. Copy in, never symlink; never start a server against `~/.evie`.
