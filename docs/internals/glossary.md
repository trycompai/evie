# Glossary

The vocabulary this codebase uses, with the file that owns each idea. If a word
here means something different in your head, the file is the tiebreaker.

Terms are grouped by where they live, not alphabetised — the grouping is most of
the explanation.

## People and places

| Term | Means | Lives in |
| --- | --- | --- |
| **user** | The person using Evie to direct agents. Not you, and not us. | — |
| **maintainer** | The people building Evie. | — |
| **agent** | An agent a user runs inside Evie. Depending on context, also you. | — |
| **provider** | The agent runtime Evie talks to. Today there is one: [eve](https://eve.dev). | [`src/provider/`](../../apps/server/src/provider) |
| **client** | The web or desktop UI. | [`apps/web`](../../apps/web) |
| **environment** | One running Evie server plus the machine, filesystem, provider credentials, and state it owns. | [`apps/server`](../../apps/server) |
| **Evie home** | The base data directory (`~/.evie`, or `$EVIE_HOME`). Runtime state lives under its `userdata/`. | [`@evie/shared/home`](../../packages/shared/src/home.ts) |
| **organization** | The tenant. Owns bots, threads, routines, connections. `local` mode is an org with one member. | [`src/auth/auth.ts`](../../apps/server/src/auth/auth.ts) |
| **team** | An optional partition of bots inside an organization. Teams partition visibility; they add no permissions. | [`contracts/org.ts`](../../packages/contracts/src/org.ts) |
| **member** | A person's membership in an organization, carrying their role. | [`contracts/org.ts`](../../packages/contracts/src/org.ts) |
| **actor** | `{ userId, orgId, role }`, resolved from the session before a command is admitted. Never read from a payload. | [`contracts/rpc.ts`](../../packages/contracts/src/rpc.ts) |

## The domain

| Term | Means | Lives in |
| --- | --- | --- |
| **bot** | An eve agent directory on disk, owned by an organization. Name, model, sandbox, and health are bot-level records. | [`contracts/bot.ts`](../../packages/contracts/src/bot.ts) |
| **thread** | A conversation with participants. Each `(thread, bot)` pair owns exactly one eve session. | [`contracts/thread.ts`](../../packages/contracts/src/thread.ts) |
| **participant** | One bot in a thread, plus that pair's eve session id and stream cursor. | [`contracts/thread.ts`](../../packages/contracts/src/thread.ts) |
| **turn** | One user-to-agent cycle, including follow-up work such as checkpointing. | [`src/reactors/turn.ts`](../../apps/server/src/reactors/turn.ts) |
| **routine** | A cron row that dispatches a turn. Carries its own IANA timezone, never the host's. | [`src/scheduler/`](../../apps/server/src/scheduler) |
| **connection** | An authored file under a bot's `agent/connections/`, scoped `org` or `member`. | [`contracts/commands.ts`](../../packages/contracts/src/commands.ts) |
| **grant** | One member's authorization of a `member`-scoped connection. | [`contracts/commands.ts`](../../packages/contracts/src/commands.ts) |
| **checkpoint** | A per-turn commit of the sandbox's `/workspace` onto a hidden git ref, so the app can diff and restore. | [`src/reactors/checkpoint.ts`](../../apps/server/src/reactors/checkpoint.ts) |

## The server's machinery

The shape is: **command → decider → events → projector → read model → client**,
with side effects in reactors alongside.

| Term | Means | Lives in |
| --- | --- | --- |
| **command** | The client's entire vocabulary. One tagged union; one RPC. | [`contracts/commands.ts`](../../packages/contracts/src/commands.ts) |
| **aggregate** | The unit a command locks: a bot, a thread, or the organization. Never the whole org for an edit. | [`aggregateOf`](../../packages/contracts/src/commands.ts) |
| **decider** | The pure function `decide(state, command, actor) -> events`. No IO, no clock, no randomness. It is why the server is testable without a model. | [`src/domain/decide.ts`](../../apps/server/src/domain/decide.ts) |
| **event** | An append-only fact. Either a product event the user caused, or a **mirror** of an eve stream event. | [`contracts/events.ts`](../../packages/contracts/src/events.ts) |
| **mirror** | Our copy of eve's stream, keyed `(session_id, meta.id)` and inserted `on conflict do nothing`. Never authoritative for whether work happened — ask eve. | [`src/provider/EveAdapter.ts`](../../apps/server/src/provider/EveAdapter.ts) |
| **projector** | Derives the read models the UI renders from events. | [`src/domain/project.ts`](../../apps/server/src/domain/project.ts) |
| **reactor** | A **durable subscription over the event log**, not a queue listener. Reads forward from its cursor and advances it in the same transaction as anything it wrote. | [`src/reactors/runtime.ts`](../../apps/server/src/reactors/runtime.ts) |
| **receipt** | The typed event a reactor emits when a milestone lands. **Tests wait on receipts** — no test sleeps and no test polls. | [`contracts/events.ts`](../../packages/contracts/src/events.ts) |
| **expectedVersion** | The aggregate version a command's state was folded at. `append` fails `ConcurrencyConflict` if the aggregate moved underneath it. | [`src/store/EventStore.ts`](../../apps/server/src/store/EventStore.ts) |
| **supervisor** | Owns eve runtime lifecycle: lazy start, idle stop, crash restart, and PID discipline. | [`src/provider/Supervisor.ts`](../../apps/server/src/provider/Supervisor.ts) |
| **provisioning** | Writing a new bot's eve project to disk and installing it. Slow — `git init` plus `npm install`, because eve is pinned per bot — so it belongs to the supervisor reactor, behind the bot's health chip. It is **not** part of the projection: it lived there once, and the bot row did not exist until the install finished. | [`src/reactors/supervisor.ts`](../../apps/server/src/reactors/supervisor.ts) |
| **adapter** | The only module that speaks eve's protocol. A second provider is a second adapter, not a refactor. | [`src/provider/EveAdapter.ts`](../../apps/server/src/provider/EveAdapter.ts) |
| **gateway** | The RPC-over-WebSocket surface. The only network-exposed thing in the system. | [`src/gateway/`](../../apps/server/src/gateway) |
| **hub** | Per-thread fan-out with the frame budget: coalescing, truncation, backpressure. | [`src/gateway/hub.ts`](../../apps/server/src/gateway/hub.ts) |

## The wire

| Term | Means | Lives in |
| --- | --- | --- |
| **contract version** | Compiled into both sides and exchanged in `session.hello`. A mismatch is a typed refusal, not a decode failure twenty frames later. | [`contracts/version.ts`](../../packages/contracts/src/version.ts) |
| **timeline item** | The projected row the UI renders. Flatter than eve's stream: a tool call is a first-class item, not a message part. | [`contracts/timeline.ts`](../../packages/contracts/src/timeline.ts) |
| **frame** | A batch of timeline operations for one thread, emitted at most once per 50 ms per subscriber. | [`contracts/timeline.ts`](../../packages/contracts/src/timeline.ts) |
| **demand-scheduled** | The frame cadence. The first pending delta arms a 50 ms timeout; the flush disarms it. An idle thread has **no timer at all** — a `setInterval` per subscriber would wake the process 160 times a second to say nothing. | [`src/gateway/hub.ts`](../../apps/server/src/gateway/hub.ts) |
| **summary mode** | What a subscriber is downgraded to after three consecutive overflow windows: turn boundaries only, and the client is told so it can show *catching up*. | [`contracts/timeline.ts`](../../packages/contracts/src/timeline.ts) |
| **blob** | Attachment or overflow tool payload. Bytes never cross the RPC socket; `blobs.grant` mints a short-lived token and the client fetches over HTTP. | [`src/gateway/http.ts`](../../apps/server/src/gateway/http.ts) |

## The client

| Term | Means | Lives in |
| --- | --- | --- |
| **store** | The external, server-owned data source read with `useSyncExternalStore`. Component state never holds server state, which is what makes the no-`useEffect` rule easy to honour. | [`client-runtime/store.ts`](../../packages/client-runtime/src/store.ts) |
| **row-level subscription** | `subscribeItem(threadId, itemId)`. The difference between meeting the perf budget and missing it: a thread-level subscription re-renders the list container on every frame. | [`client-runtime/store.ts`](../../packages/client-runtime/src/store.ts) |
| **presence** | Which threads a client has open and which reasoning blocks it expanded. Drives subscriptions and idle-stop. | [`client-runtime/presence.ts`](../../packages/client-runtime/src/presence.ts) |
| **bot mark** | A bot's face: two slots in a solid shape, a wall socket. Derived from the bot id when the user has not picked one. | [`ui/bot-mark.tsx`](../../packages/ui/src/components/bot-mark.tsx) |
| **just-in-time package** | Every `@evie/*` package exports raw source and emits nothing. Consumers must exclude them from Vite's pre-bundling and add a Tailwind `@source` for them. | [`04-clients.md`](../../specs/04-clients.md) |

## Words we avoid

- **"chat"** for a bot. A bot is a role with a computer; a thread is the chat.
- **"session"** unqualified. Say *eve session* (the provider's durable run) or
  *auth session* (Better Auth's cookie). They are unrelated and both are common.
- **"queue"** for a reactor. It is a durable subscription; calling it a queue is
  how the in-memory version gets rebuilt.
- **"cache"** for the mirror. It is a mirror, and it is not authoritative.
