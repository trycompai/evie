# 02 — Architecture

## Runtime topology

```
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ clients                                                                  │
 │   apps/web        React 19 + Vite + @evie/ui        (browser)            │
 │   apps/desktop    Electron shell -> loads apps/web  (bundles the server) │
 │        both use  packages/client-runtime                                 │
 └───────────────────────────────┬──────────────────────────────────────────┘
                                 │  RPC over WebSocket (MsgPack), one connection
                                 │  + plain HTTP for auth, static assets, blobs
 ┌───────────────────────────────▼──────────────────────────────────────────┐
 │ apps/server — the environment.  THE ONLY NETWORK-EXPOSED SURFACE.        │
 │                                                                          │
 │  HTTP   /api/auth/*   Better Auth                                        │
 │         /blob/:id     attachments + truncated-payload fetches            │
 │         /health       liveness                                           │
 │         /*            static web assets (packaged builds)                │
 │  WS     /rpc          RpcServer(@evie/contracts), MsgPack framing        │
 │                                                                          │
 │  Commands ─▶ Decider (pure) ─▶ Events (SQLite, append-only)              │
 │                                    │                                     │
 │                                    ├─▶ Projector ─▶ read models ─▶ WS    │
 │                                    └─▶ Reactors ─▶ side effects ─▶ receipts
 │                                                                          │
 │  Services: Db · Secrets · Auth · Supervisor · EveAdapter · Scheduler     │
 └───────────────────────────────┬──────────────────────────────────────────┘
                                 │  loopback only, ephemeral port, per-process bearer
 ┌───────────────────────────────▼──────────────────────────────────────────┐
 │ eve runtime, one per ACTIVE bot   (Nitro on 127.0.0.1:<ephemeral>)       │
 │   POST /eve/v1/session            GET /eve/v1/session/:id/stream (NDJSON)│
 │   POST /eve/v1/session/:id        POST .../cancel .../compact .../clear  │
 └───────────────────────────────┬──────────────────────────────────────────┘
                                 │
        ┌────────────────────────┴─────────────────────────┐
        ▼                                                  ▼
 ┌──────────────────────┐                        ┌────────────────────────┐
 │ sandbox per session  │                        │ model calls            │
 │ docker | microsandbox│                        │ Vercel AI Gateway      │
 │ just-bash | vercel   │                        │ or direct provider     │
 └──────────────────────┘                        └────────────────────────┘
```

Three properties fall out of this and they are the reason for the shape:

1. **One exposed port.** Auth, TLS, tunnelling, and rate limiting are solved once. An eve runtime is
   never reachable from a network interface.
2. **One place to throttle.** Every byte the UI sees passes through the Evie server, so coalescing
   and truncation happen before the socket, not after (see [04-clients.md](./04-clients.md)).
3. **One place that knows eve.** `EveAdapter` is the only module that speaks eve's protocol. A second
   provider is a second adapter, not a refactor.

## Evie home

```
~/.evie/                      # or $EVIE_HOME
  userdata/
    state.sqlite              # control plane + Better Auth tables (WAL)
    secrets.key               # 0600, AES-256-GCM key (desktop: OS keychain instead)
    blobs/                    # attachments and overflow tool payloads, content-addressed
    orgs/
     <orgId>/                 # one directory per organization; deleting an org is a directory move
      bots/
       <botId>/               # a complete eve project. `git init`ed on create.
        package.json
        agent/
          agent.ts            # model, reasoning, limits — Evie writes this
          instructions.md     # the bot's persona and rules — the user edits this
          channels/eve.ts     # Evie writes this: verifies the per-turn member JWT
          connections/        # one file per connected service
          skills/             # taught procedures
          tools/
          sandbox/sandbox.ts  # Evie writes this: backend + network policy
        .eve/                 # eve's own build + workflow state. Never touched by Evie.
    settings.json
```

Worktree rule from `AGENTS.md` still applies: a dev server started from a worktree writes to
`<worktree>/.evie`, never `~/.evie`.

## apps/server internals

Effect 4 (`effect@4.0.0-rc.*`, vendored at `.repos/effect` — read `.repos/effect/LLMS.md` before
writing any Effect). Every subsystem is a `Layer`; the process is one `ManagedRuntime`. Nothing
spawns a child process outside a scoped resource.

### Service layers

| Service         | Backed by                                                       | Owns                                                                                     |
| --------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `EvieConfig`    | `Config` + `settings.json`                                      | Evie home, bind address, mode (`local`/`lan`/`tunnel`), feature flags                    |
| `Db`            | `@effect/sql-sqlite-node` (`node:sqlite`, no native module)     | **the process's only SQLite writer.** WAL, `busy_timeout`, migrations via `SqliteMigrator` |
| `EventStore`    | `Db`                                                            | append-only `event` table, idempotent on `(session_id, id)`, cursor reads                 |
| `Projector`     | `EventStore`                                                    | derives `bot`, `thread`, `message`, `routine`, `connection` read models                   |
| `Secrets`       | `node:crypto` + keychain / `secrets.key`                        | AES-256-GCM at rest; plaintext exists only in the spawn env of a child process            |
| `Auth`          | Better Auth + `organization` plugin, **over `Db`'s connection** | users, sessions, passkeys, orgs, members, invitations, teams, and the permission checks   |
| `Supervisor`    | `NodeChildProcessSpawner` + `FiberMap`                          | eve runtime lifecycle: spawn, health, idle-stop, crash restart with backoff               |
| `EveAdapter`    | `HttpClient` + NDJSON decode                                    | eve HTTP calls and stream ingestion; the only eve-aware module                            |
| `Scheduler`     | `Cron` + `Db`                                                   | routine rows -> dispatched turns                                                          |
| `Gateway`       | `NodeHttpServer` + `RpcServer` over `Socket`                    | client connections, subscriptions, per-connection backpressure                            |
| `Notifier`      | Web Push / Electron IPC                                         | out-of-app notification fan-out                                                           |

### One writer, and why that is a hard rule

`node:sqlite` is **synchronous**. `@effect/sql-sqlite-node` says so in its own source: waiting on a
busy database blocks the Node event loop. That single fact decides the shape of our data layer.

If two connections in this process can write — say `Db` and a Better Auth instance that opened the
file itself — then any lock contention parks the event loop for up to `busy_timeout`. Not one
request: *everything*. Every WebSocket stream, the NDJSON ingestion fibers, the supervisor's health
checks, all frozen together. A five-second stall is indistinguishable from a hang, and it would land
squarely on the "performance without compromise" promise.

So:

1. **`Db` holds the only write handle in the process.** Better Auth does not open `state.sqlite`;
   it is handed a Kysely dialect that executes through `Db`'s connection. Verifying that Better Auth
   accepts a custom dialect is a **Phase 0 task with a fallback**: if it will not, Better Auth gets
   its own file (`userdata/auth.sqlite`) rather than a second handle on ours. Two files with one
   writer each is correct; one file with two writers is not.
2. **`busy_timeout` is 250 ms, not 5000.** A blocked event loop is worse than a failed write.
   Contention surfaces as a typed error and the caller retries with jitter, off the hot path.
3. **Reads may use additional read-only connections.** WAL permits concurrent readers, and a reader
   never blocks the writer. Only writes funnel through one place.
4. **No write happens inside a streaming path.** Ingestion batches its appends on the same cadence
   as the frame flush (see [03](./03-contracts-and-data.md#frame-budget)), so a turn producing
   hundreds of deltas a second produces tens of transactions a second.

### Command → event → projection

The decider is a pure function. It is the whole reason the server is testable without a model.

```
decide(state: AggregateState, command: Command, actor: Actor): ReadonlyArray<EvieEvent>
```

`Actor` is `{ userId, orgId, role }`, resolved from the session before the command is admitted —
never from the payload. Authorization runs *before* the decider, in RPC middleware, via
`auth.api.hasPermission`; the decider assumes the actor is allowed and concerns itself only with
whether the command makes sense given the state. Keeping those two apart is what stops permission
logic from leaking into business rules and becoming untestable.

#### The aggregate is the bot or the thread, never the org

Every command names exactly one **aggregate** — a `botId`, a `threadId`, or the organization itself.
`AggregateState` is the state of *that* aggregate, folded from its own events. Loading whole-org
state to rename one bot would not survive an org with a few hundred bots, and it would make every
command contend with every other one.

A routine or a connection folds into its owning bot rather than being its own aggregate: they are
edited through the bot's settings and never in isolation, so a separate lock would buy contention
without buying independence. Commands that *create* a thing — `CreateBot`, `OpenThread` — name the
organization, because the aggregate they would otherwise name does not exist yet. That is the one
case where org-level serialization is correct rather than lazy, and it is also the case where the
uniqueness checks live.

#### Two commands at once

Commands against the same aggregate are **serialized**, and the append is guarded:

- The gateway routes each command through a per-aggregate `Semaphore` held in a `FiberMap`, so at
  most one decider runs per aggregate at a time. Different bots proceed in parallel; two clicks on
  the same bot do not.
- `EventStore.append` takes the `expectedVersion` the state was folded at and fails with a typed
  `ConcurrencyConflict` if the aggregate moved underneath it. The command handler refolds and
  retries once, then surfaces the conflict.

Without both, two simultaneous `CreateBot` calls both pass a decider that saw no bot and both write.
`unique (org_id, slug)` happens to catch that one case; `AddParticipant`, `SetRoutineEnabled`, and
`SetNetworkPolicy` have no such backstop, and relying on a chance unique index is not a design.

Commands are the client's entire vocabulary: `CreateBot`, `RenameBot`, `MoveBotToTeam`, `ArchiveBot`,
`UnarchiveBot`, `OpenThread`, `AddParticipant`, `SendMessage`, `CancelTurn`, `AnswerInput`,
`CompactSession`, `ClearSession`, `SnoozeThread`, `UnsnoozeThread`, `CreateRoutine`,
`SetRoutineEnabled`, `SetRoutineRunAs`, `ConnectService`, `LinkMyGrant`, `RevokeGrant`,
`DisconnectService`, `SetModel`, `SetNetworkPolicy`, `RestoreCheckpoint`, plus the organization
commands (`InviteMember`, `RevokeInvitation`, `SetMemberRole`, `RemoveMember`, `CreateTeam`,
`SetActiveOrg`) which delegate to Better Auth rather than the decider.

Note the pairs. `AGENTS.md`'s reverse-state rule is enforced at the command vocabulary, not
remembered later: a one-way door does not get a command. Invite has revoke, link has unlink,
promote has demote.

**The trap to avoid:** Evie's event log is *not* a second source of truth for agent execution. eve
owns that — durably, at step granularity, across process restarts. Evie's log holds

- product events the user caused (`BotCreated`, `RoutineEnabled`, `MessageSent`), and
- a **mirror** of eve stream events, stored so a client can render a thread offline and so we can
  reconnect a stream from a cursor.

The mirror is keyed on `(session_id, meta.id)` and inserted with `on conflict do nothing`, following
eve's documented ingestion pattern. The session id is part of the key deliberately: `meta.id` is a
ULID minted by a runtime we supervise but do not control, and a bare global primary key turns any
collision — a bug, a restored bot directory, a hostile fork — into an event silently vanishing under
`do nothing`. Scoping the key to the session that produced it makes a collision impossible between
bots and merely idempotent within one.

eve retries interrupted steps under fresh ids, so the mirror can legitimately contain both attempts;
the projector resolves the visible message by `(turnId, stepIndex, sequence)`, last-writer-wins.
Never treat the mirror as authoritative for whether work happened — ask eve.

### Reactors and receipts

Side effects run in queue-backed reactors, one fiber per queue, and emit a typed receipt when the
milestone lands. Tests wait on receipts. **No test sleeps, and no test polls.**

| Reactor      | Trigger                                   | Receipt                               |
| ------------ | ----------------------------------------- | ------------------------------------- |
| `TurnReactor`   | `MessageSent`, `InputAnswered`         | `TurnDispatched`, `TurnSettled`       |
| `RoutineReactor`| cron tick                              | `RoutineFired`                        |
| `CheckpointReactor` | `TurnSettled`                      | `CheckpointWritten`                   |
| `NotifyReactor` | `TurnSettled`, `InputRequested`        | `NotificationDelivered`               |
| `SupervisorReactor` | bot activity / idle timer          | `RuntimeReady`, `RuntimeStopped`      |

#### Reactors resume; they do not forget

An in-memory queue plus a durable event log is a trap. `MessageSent` commits, the process dies
before `TurnReactor` drains, and the event is on disk forever while the turn it demanded never
happens. Nothing retries it, because nothing remembers it was owed. For a product whose pitch is
"work continues after you close your device", that is the one bug we cannot ship.

So a reactor is a **durable subscription over the event log**, not a listener on a volatile queue:

```sql
create table reactor_cursor (
  reactor    text primary key,   -- 'turn' | 'routine' | 'checkpoint' | 'notify' | 'supervisor'
  last_seq   integer not null,   -- last event.seq this reactor has fully handled
  updated_at integer not null
);
```

- Each reactor reads forward from `last_seq`, handles an event, and advances the cursor **in the
  same transaction as any state its handler wrote**. The in-memory queue is a latency optimization
  on top of that loop, never the system of record.
- Handlers are **idempotent**, because a crash between the side effect and the cursor write replays
  one event. `TurnReactor` dispatches under a deterministic turn id derived from the triggering
  event id, so a replayed dispatch is a no-op against eve rather than a duplicate turn.
- On boot, every reactor replays from its cursor before the gateway accepts connections. A server
  that was off for an hour catches up rather than starting clean.
- `NotifyReactor` is the one place where replay is user-visible: it will not re-notify for an event
  older than its own start time, because a stale desktop toast is worse than a missed one.

## The eve provider adapter

`EveAdapter` is the boundary where complexity is allowed to live. Everything above it is pure
orchestration; everything below it is eve's business.

### Supervision

- **Lazy start.** No eve process runs until a bot is addressed. `Supervisor.acquire(botId)` returns a
  ready runtime, starting one if needed, and joins concurrent callers to the same start.
- **Idle stop.** A runtime with no active turn and no client attached for `N` minutes (default 10)
  is stopped. This is safe and is a direct consequence of eve's contract: workflow state persists
  under the bot's `.eve/.workflow-data`, and sandboxes reattach from their stopped container, VM, or
  snapshot on the next turn. Sandbox compute never outlives the runtime, which is the behaviour we
  want on a laptop.
- **Crash restart** with exponential backoff, capped, surfaced in the UI as a bot-level health chip.
  A bot that fails to start three times is marked `unhealthy` with the last 50 stderr lines
  attached, not silently retried forever.
- **Shutdown discipline.** Every child PID is captured at spawn and held in a `FiberMap` keyed by
  bot id, torn down by the scope. We never discover a PID by matching a name, a path, or a worktree
  string — see rule 1 in `AGENTS.md`. That rule exists because our own agent process has this
  worktree's path in its argv.

### Which eve mode to run

| Mode                                              | Used by                | Why                                                                                                                              |
| ------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `eve dev --no-ui --host 127.0.0.1 --port 0`      | local + desktop        | Hot rebuild. A user editing `instructions.md` in Evie's bot editor sees the change on the next turn with no build step.          |
| `eve build` once, then `eve start`                | hosted / long-running  | Deterministic artifact, no dev-only routes, no background template pruning.                                                     |

**Decided (approved).** Shipping `eve dev` inside a product is unusual — it auto-installs optional
sandbox packages (`microsandbox`, `just-bash`), writes runtime snapshots under `.eve/dev-runtime/`,
and mounts a dev-only schedule dispatch route. We take it in local mode because the alternative is a
multi-second rebuild on every instruction edit, which would make the bot editor feel broken. The
mitigations stand: bots always get an authored `agent/channels/eve.ts` with real auth, so
`localDev()` is never the only thing between the runtime and a caller; the runtime binds loopback;
and a per-bot setting flips to built mode. If eve later ships a supported embed API, we move to it.

### Per-bot files Evie owns

Evie generates and re-generates three files. Everything else in `agent/` belongs to the user.

`agent/channels/eve.ts` verifies a per-turn HS256 JWT that names the acting organization member, so
the runtime knows *who* a turn is for and member-scoped connections resolve the right credential.
The full generated file is in [05-auth-secrets-remote.md](./05-auth-secrets-remote.md#evie--eve-runtime-carrying-the-members-identity).

```ts
// agent/sandbox/sandbox.ts — generated from the bot's Settings > Computer pane
import { defineSandbox, defaultBackend } from "eve/sandbox";

export default defineSandbox({
  backend: defaultBackend(),
  async onSession({ use }) {
    await use({
      networkPolicy: {
        // deny-all plus an explicit allow-list. Evie's default, stricter than eve's.
        allow: ["ai-gateway.vercel.sh", ...JSON.parse(process.env.EVIE_ALLOWED_HOSTS ?? "[]")],
      },
    });
  },
});
```

`agent/agent.ts` carries model and reasoning effort. Evie edits it through `eve set --model … --reasoning …`
rather than rewriting the file itself, so eve's own source editor stays the single writer and
dynamic model definitions are not clobbered.

### Ingestion

One fiber per attached session reads `GET /eve/v1/session/:id/stream?startIndex=<cursor>` as NDJSON,
decodes with `@evie/contracts` schemas, and does three things per event:

1. Fold the event into an in-memory per-session accumulator, and publish to the thread's subscriber
   hub — coalesced, never raw (see [04-clients.md](./04-clients.md)).
2. `Projector.apply` to update the thread's read model, in memory.
3. On the flush tick — the same 50 ms cadence as the outbound frame — write the accumulated events,
   the projected rows, and the advanced `stream_index` in **one transaction** via
   `EventStore.append` (idempotent on `(session_id, meta.id)`).

The order matters. Clients see a delta as soon as it arrives; disk sees a batch. A turn emitting
three hundred deltas a second costs twenty transactions a second, not three hundred — which is what
keeps a synchronous SQLite driver off the streaming hot path (see
[One writer](#one-writer-and-why-that-is-a-hard-rule)).

Reconnect is a cursor read. On adapter restart we resume from the last **persisted**
`stream_index`, so an unflushed batch is re-read rather than lost; overlap is harmless because of
the dedupe key. That is the whole reason the cursor advances with the batch and not ahead of it.

### Event mapping

| eve stream event                                | Evie surface                                                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `session.started` / `session.waiting`           | thread status chip: *ready*                                                                               |
| `turn.started` / `turn.completed`               | turn boundary; drives `TurnSettled` receipt and notification                                              |
| `turn.cancelled`                                | *stopped*, not an error. Composer re-enables immediately.                                                  |
| `message.appended` / `message.completed`        | assistant text. Appended deltas coalesced; `finishReason` distinguishes narration from a terminal reply.  |
| `reasoning.appended` / `reasoning.completed`    | streamed live to subscribed clients only, then discarded — never mirrored, never stored. A token count persists. |
| `actions.requested` / `action.partial` / `action.result` | tool timeline rows; payloads over 8 KiB truncated with a blob handle                              |
| `input.requested`                               | approval / question card in the composer; status becomes *waiting on you*                                 |
| `authorization.required` / `.completed`         | sign-in card with `url` / `userCode` / `displayName`                                                      |
| `subagent.called` / `.completed`                | a nested, collapsed run; child stream attached on expand via `childSessionId`                             |
| `compaction.requested` / `.completed`           | a quiet system row; also updates the context-usage meter                                                  |
| `step.failed` / `turn.failed` / `session.failed`| error row carrying `{ code, message }`, with a retry affordance                                           |

### Threads with several bots — and several people

A thread has participants. Each `(thread, bot)` pair owns exactly one eve `sessionId`, shared by
every member of the organization who can see the thread.

When someone posts:

1. Resolve recipients — explicit `@mentions`, else the thread's default participant.
2. For each recipient, dispatch a turn on its session, carrying a freshly minted JWT for **the member
   who sent the message**. The message text goes in the message; the *other* participants' recent
   turns go in `clientContext`, which eve keeps ephemeral and out of durable history. A bot sees what
   the room said without its own history filling with another bot's transcript.
3. Merge the resulting streams into one timeline, tagged by bot and by member.

One shared session with a rotating caller is exactly what eve's auth model expects:
`ctx.session.auth.current` tracks whoever sent this turn, while `auth.initiator` stays pinned to
whoever started the thread. So Ana's turn resolves Ana's Linear grant and Ben's resolves Ben's, in
the same conversation, with no session per person.

Follow-ups use eve's default `turnPolicy: "steer"` — a new message cancels the in-flight turn and
starts a replacement — which matches what a chat UI implies. Routine dispatches use `"queue"`.

## Checkpoints

At `TurnSettled`, `CheckpointReactor` commits the sandbox's `/workspace` onto a hidden ref
(`refs/evie/checkpoints/<threadId>`) and records the sha. That gives per-turn diff and restore.
Skipped when the backend is `just-bash` (no real `git`). Phase 2.

## Failure modes we design for, explicitly

| Failure                                     | Behaviour                                                                                     |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| eve runtime dies mid-turn                   | Supervisor restarts it; eve resumes the turn from its last completed step. UI shows *reconnecting*, not an error. |
| Model credential missing or rejected        | Turn fails with a typed error and a *Fix in Settings* action. Never a raw provider stack trace.  |
| Docker not running                          | Sandbox falls back per `defaultBackend()`. If it lands on just-bash, the bot shows a persistent banner: no real binaries, no network isolation. |
| Client disconnects mid-stream               | Nothing is cancelled. eve keeps running. Reattach by cursor.                                     |
| Two clients open the same thread            | Both attach to the same session stream. Both see the same coalesced frames. Composer is not locked; steering is the documented behaviour. |
| Two *members* post at once                  | Same thing — the second message steers the first one's turn. The timeline attributes both, so it reads as an interruption rather than a glitch. |
| A member triggers a tool needing their unlinked account | eve emits `authorization.required` for that member only; the sign-in card is shown to them and is inert for everyone else in the thread. |
| A routine's pinned `run_as` member leaves   | The routine is marked blocked with a reason, not silently re-run as somebody else. Admins get one notification, not one per tick. |
| **Server dies between a command and its side effect** | Nothing is lost. Every reactor resumes from its `reactor_cursor` at boot and replays the events it had not finished; handlers are idempotent, so a redelivered dispatch is a no-op rather than a duplicate turn. |
| **Two commands hit one bot at once**        | Serialized by a per-aggregate semaphore, then guarded by `expectedVersion` on append. The loser refolds and retries once; a real conflict surfaces as a typed `ConcurrencyConflict`, never a lost write. |
| Disk full / SQLite busy                     | Writes fail fast (`busy_timeout` is 250 ms) and retry with jitter off the streaming path. A persistent failure degrades to read-only mode with a banner rather than corrupting state, and never by parking the event loop. |
