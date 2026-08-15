import { SqliteMigrator } from "@effect/sql-sqlite-node"
import { Effect } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Evie's migrations. The schema is 03's "SQLite schema" section, verbatim.
 *
 * Two migration owners share `state.sqlite`. Better Auth owns its tables
 * (`user`, `session`, `account`, `verification`, `passkey`, `organization`,
 * `member`, `invitation`, `team`, `teamMember`) and runs its own programmatic
 * `getMigrations()` BEFORE these at boot -- the auth layer owns that call.
 * Evie's tables reference auth rows only by `user.id`, `organization.id`, and
 * `team.id`, never with a foreign key across the boundary.
 *
 * Every Evie row is org-scoped from the first migration. There is no
 * single-owner variant that teams get bolted onto later.
 */

const initial = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // Bots -----------------------------------------------------------------
  yield* sql`
    create table bot (
      id            text primary key,
      org_id        text not null,
      team_id       text,
      slug          text not null,
      name          text not null,
      description   text,
      avatar        text,
      dir           text not null,
      model         text not null,
      reasoning     text,
      runtime_mode  text not null default 'dev',
      sandbox       text not null,
      health        text not null default 'idle',
      created_by    text not null,
      created_at    integer not null,
      archived_at   integer,
      unique (org_id, slug)
    )`
  yield* sql`create index bot_org on bot(org_id, archived_at)`

  // Threads --------------------------------------------------------------
  yield* sql`
    create table thread (
      id            text primary key,
      org_id        text not null,
      title         text,
      created_by    text not null,
      created_at    integer not null,
      last_activity integer not null,
      snoozed_until integer,
      archived_at   integer
    )`
  yield* sql`create index thread_activity on thread(org_id, archived_at, last_activity desc)`

  yield* sql`
    create table thread_participant (
      thread_id      text not null references thread(id) on delete cascade,
      bot_id         text not null references bot(id),
      eve_session_id text,
      stream_index   integer not null default 0,
      is_default     integer not null default 0,
      primary key (thread_id, bot_id)
    )`

  // Timeline projection ----------------------------------------------------
  // `body` is the whole TimelineItem as json -- right for a read model the UI
  // renders wholesale. Rows are written on the ingestion flush tick, batched,
  // never per delta.
  yield* sql`
    create table timeline_item (
      id            text primary key,
      thread_id     text not null references thread(id) on delete cascade,
      seq           integer not null,
      kind          text not null,
      bot_id        text,
      actor_user_id text,
      turn_id       text,
      body          text not null,
      at            integer not null
    )`
  yield* sql`create unique index timeline_seq on timeline_item(thread_id, seq)`

  // Event mirror -----------------------------------------------------------
  // The key is (session_id, id), not id: `id` can be a ULID minted by a runtime
  // we supervise but do not control, and rows insert `on conflict do nothing`,
  // so a bare global key would turn any collision into a silent disappearance.
  yield* sql`
    create table event (
      id            text not null,
      session_id    text not null default '',
      seq           integer not null,
      org_id        text not null,
      thread_id     text,
      bot_id        text,
      actor_user_id text,
      stream_index  integer,
      type          text not null,
      data          text not null,
      at            integer not null,
      primary key (session_id, id)
    )`
  yield* sql`create unique index event_seq on event(seq)`
  yield* sql`create index event_session on event(session_id, stream_index)`
  yield* sql`create index event_thread on event(thread_id, at)`
  yield* sql`create index event_actor on event(org_id, actor_user_id, at)`
  yield* sql`create index event_at on event(at)`

  // Reactor cursors ----------------------------------------------------------
  // `event.seq` is monotonic but NOT contiguous. Reactors read
  // `where seq > last_seq order by seq` and never wait for a specific value.
  yield* sql`
    create table reactor_cursor (
      reactor       text primary key,
      last_seq      integer not null default 0,
      updated_at    integer not null
    )`

  // Routines -----------------------------------------------------------------
  // `tz` is stored per routine, never inherited from the host; `next_run_at`
  // is a cache, recomputed from (cron, tz), never trusted across a restart.
  yield* sql`
    create table routine (
      id             text primary key,
      org_id         text not null,
      bot_id         text not null references bot(id) on delete cascade,
      thread_id      text,
      name           text not null,
      cron           text not null,
      tz             text not null,
      prompt         text not null,
      run_as         text,
      enabled        integer not null default 1,
      blocked_reason text,
      last_run_at    integer,
      next_run_at    integer,
      last_status    text
    )`
  yield* sql`create index routine_due on routine(enabled, next_run_at)`

  // Connections ---------------------------------------------------------------
  yield* sql`
    create table connection (
      id            text primary key,
      org_id        text not null,
      bot_id        text not null references bot(id) on delete cascade,
      name          text not null,
      kind          text not null,
      scope         text not null default 'org',
      config        text not null,
      auth_kind     text not null,
      unique (bot_id, name)
    )`

  // One row per member who linked a member-scoped connection; an org-scoped
  // connection has exactly one row with user_id ''.
  yield* sql`
    create table connection_grant (
      connection_id text not null references connection(id) on delete cascade,
      user_id       text not null default '',
      state         text not null default 'unauthorized',
      secret_id     text references secret(id),
      linked_at     integer,
      primary key (connection_id, user_id)
    )`

  // Secrets ---------------------------------------------------------------------
  yield* sql`
    create table secret (
      id            text primary key,
      scope         text not null,
      name          text not null,
      nonce         blob not null,
      ciphertext    blob not null,
      hint          text,
      created_at    integer not null,
      unique (scope, name)
    )`

  // Checkpoints -------------------------------------------------------------------
  yield* sql`
    create table checkpoint (
      id            text primary key,
      thread_id     text not null references thread(id) on delete cascade,
      turn_id       text not null,
      sha           text not null,
      created_at    integer not null
    )`

  // Blobs ---------------------------------------------------------------------------
  // Content and ownership are two facts, two tables: a blob id is a content
  // hash, so content dedupes across orgs while access stays per-org.
  yield* sql`
    create table blob (
      id            text primary key,
      media_type    text not null,
      size          integer not null,
      path          text not null,
      created_at    integer not null
    )`

  yield* sql`
    create table blob_ref (
      blob_id       text not null references blob(id) on delete cascade,
      org_id        text not null,
      created_at    integer not null,
      primary key (blob_id, org_id)
    )`
  yield* sql`create index blob_ref_org on blob_ref(org_id)`

  // Devices ------------------------------------------------------------------------------
  yield* sql`
    create table device (
      id            text primary key,
      user_id       text not null,
      kind          text not null,
      label         text,
      push_endpoint text,
      last_seen     integer not null,
      revoked_at    integer
    )`
})

/**
 * Session-scoped approval grants.
 *
 * "Always allow for this session" cannot be forwarded to the provider: eve's
 * `inputResponseSchema` is strict and carries exactly `requestId`, `optionId`,
 * and `text`. So the grant is Evie's to keep, which is the right place for it
 * anyway -- Evie owns the approval surface, and a grant the user can see is a
 * grant the user can revoke.
 *
 * Keyed by (session, tool) because that is the promise the card makes: this
 * action, this session. A grant does not outlive the session it was given in.
 */
const inputGrant = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    create table input_grant (
      session_id text not null,
      tool_name  text not null,
      option_id  text not null,
      granted_by text not null,
      granted_at integer not null,
      primary key (session_id, tool_name)
    )`
})

/**
 * The per-turn file summary, beside the sha it describes.
 *
 * Defaulted rather than backfilled: an existing checkpoint's numbers are
 * recoverable from git at any time, and zero reads honestly as "we did not
 * measure this one" in a UI that only shows the line when files > 0.
 */
const checkpointStats = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`alter table checkpoint add column files integer not null default 0`
  yield* sql`alter table checkpoint add column insertions integer not null default 0`
  yield* sql`alter table checkpoint add column deletions integer not null default 0`
})

/**
 * Realigns each row's stored `seq` with the position it actually holds.
 *
 * A timeline row carries its position twice: the `seq` column the server pages
 * and resumes by, and a copy inside the JSON body, which is what the client
 * reads and sorts on. Two projections used to number rows from their own
 * in-memory counters, and the insert clamped the column to the next free
 * position without touching the body -- so the two drifted apart, one row per
 * event that only one of the projections saw.
 *
 * Rows then tied with each other in the client's ordering, and a `since`
 * cursor taken from a body was compared against columns, which made every
 * reconnect replay rows the client already had. Writers now derive the body
 * from the column; this brings the rows written before that in line.
 */
const timelineSeqBody = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    update timeline_item set body = json_set(body, '$.seq', seq)
    where json_extract(body, '$.seq') is not seq`
})

export const migrations = {
  "1_initial": initial,
  "2_input_grant": inputGrant,
  "3_checkpoint_stats": checkpointStats,
  "4_timeline_seq_body": timelineSeqBody,
}

/** Runs after Better Auth's own migrations. Requires `SqlClient` -- provide `Db.layer` under it. */
export const MigrationsLive = SqliteMigrator.layer({
  loader: SqliteMigrator.fromRecord(migrations),
})
