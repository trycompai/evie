# Evie — spec index

Evie is a minimal, open, bring-your-own-key GUI for [eve](https://eve.dev) agents. It is to
[x.ai/bot](https://x.ai/bot) what a self-hosted client is to a $300/month subscription: the same
"persistent named agents with their own computer" experience, running on your machine, against your
keys, with the source in your hands.

Read in this order:

| Doc                                                    | What it settles                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------ |
| [01-product.md](./01-product.md)                       | What Evie is, the Bot parity matrix, what we deliberately do differently |
| [02-architecture.md](./02-architecture.md)             | Runtime topology, server internals, the eve provider adapter            |
| [03-contracts-and-data.md](./03-contracts-and-data.md) | Wire protocol, event catalog, SQLite schema                             |
| [04-clients.md](./04-clients.md)                       | Web, desktop, `@evie/ui`, and the performance budget                    |
| [05-auth-secrets-remote.md](./05-auth-secrets-remote.md) | Better Auth, BYOK, connection modes                                   |
| [06-roadmap.md](./06-roadmap.md)                       | Repo layout, phases, what ships when                                    |
| [07-state-of-the-build.md](./07-state-of-the-build.md) | What exists today, what is proven, what is missing, how it measures against t3code, what to build next |

## The one-paragraph version

A **bot** is an eve agent directory on disk, owned by an **organization**. The **Evie server**
(Node 24, Effect, SQLite) is a control plane: it owns orgs, members, bots, threads, routines,
secrets, and auth, and it supervises one eve runtime process per active bot on loopback. Clients —
web in a browser, web inside Electron — speak a single typed RPC-over-WebSocket contract to the Evie
server and never touch an eve runtime directly. Each dispatched turn carries the acting member's
identity into eve, so one shared bot can act through each person's own third-party accounts. eve
owns agent durability, the sandbox, and human-in-the-loop; Evie owns the fleet, the UI, and remote
access. Models run through a Vercel AI Gateway token you supply, or direct provider keys.

## Decisions

| #   | Decision                                                                    | Why                                                                                                                                                  |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 001 | Don't write an agent loop. eve is the provider.                             | eve already ships durable sessions, sandboxes, HITL, connections, subagents, and a stable HTTP contract. Our value is the GUI, the fleet, and remote. |
| 002 | One bot = one eve agent directory.                                          | eve is filesystem-first. Bot identity, instructions, skills, tools, and connections become files a user can read, fork, and commit.                   |
| 003 | Evie server is the only exposed port. eve runtimes bind loopback.           | One auth boundary, one TLS story, one thing to tunnel. Also lets us coalesce and throttle before anything hits a socket.                              |
| 004 | Effect + SQLite for the control plane, not for agent execution.             | Supervising child processes without leaking them is exactly what structured concurrency and `Layer` are for. Agent durability stays eve's job.        |
| 005 | `(session_id, meta.id)` is our dedupe key.                                  | eve mints a stable ULID per stream event and documents `on conflict do nothing` ingestion. Scoping it to the session means a collision between two runtimes is impossible rather than silently dropping an event. |
| 006 | Sandboxes default to `deny-all` egress with an explicit allow-list.         | eve defaults to `allow-all`. For a consumer app pointed at a real filesystem, that default is wrong.                                                  |
| 007 | We expose model choice. Bot does not.                                       | BYOK is the product. Hiding the model would delete the reason to use Evie.                                                                            |
| 008 | tryevie.ai is a thin client plus relay, never a host.                       | "Local first" stops being true the moment the public site can run your agents. It connects to *your* environment.                                     |
| 009 | **Teams from the first migration.** Better Auth `organization` + `teams`.   | Every table is org-scoped from day one and `local` mode is just a one-member org. Retrofitting `org_id` onto eleven tables is the migration we refuse to schedule. |
| 010 | **Turns carry the acting member's identity into eve.**                      | A per-turn HS256 JWT gives `principalType: "user"`, so one shared bot resolves each member's own Linear or GitHub grant. A shared secret could not. |
| 011 | **Reasoning is streamed, never stored.** A token count persists.            | It is the most sensitive text a model produces, it dominates disk, and nobody rereads it. Keeping it durable and admin-readable in a team is a liability. |
| 012 | **`eve dev --no-ui` is the local runtime.** *(approved)*                    | Instant reload when a member edits bot instructions. A rebuild per edit would make the bot editor feel broken. Mitigations in 02.                    |
| 013 | **Invitations are share links, not email.** Sandbox must isolate.           | Self-hosted Evie has no SMTP, so `getInvitationURL()` is the path — called server-side, behind the same permission middleware as every other command. And a member who can message a bot can run code on the host, so `just-bash` blocks invitations *and* cannot be selected once a second member exists. |
| 014 | **eve is pinned per bot directory.**                                        | Each bot is its own project with its own `package.json`. Upgrades are deliberate and per-bot, so one bot's dependency bump cannot break the fleet.   |
| 015 | **Exactly one SQLite writer per process.**                                  | `node:sqlite` is synchronous, so a second writer turns lock contention into an event-loop stall that freezes every stream at once. Better Auth executes through `Db`'s connection, or it gets its own file. |
| 016 | **Reactors are durable subscriptions over the event log, not queues.**      | An in-memory queue plus a durable log loses work on restart: the event is on disk forever and the turn it demanded never runs. A `reactor_cursor` row and idempotent handlers make "it keeps working" survive a crash. |
| 017 | **Commands serialize per aggregate, and appends carry an expected version.** | The aggregate is a bot or a thread, never the whole org. Without both, two concurrent commands each see stale state and both write; a chance unique index is not a concurrency design. |

## `AGENTS.md`

`AGENTS.md` had drifted — it described a target repo that did not exist and carried vocabulary from
[t3code](https://github.com/pingdotgg/t3code) that does not apply here. **All of it is fixed.** (The
lineage is worth more than a warning, though: t3code is the same architecture several years further
along, and [07](./07-state-of-the-build.md#measured-against-t3code) measures Evie against it.) Kept
here as a record of what to watch for, since a file every agent reads on every task is the worst
place to leave something untrue:

- ~~A `vp` CLI (`vp test run`, `vp check`).~~ Verifying now uses this repo's real tooling:
  `bun test <files>` and `turbo run … --filter=@evie/<pkg>`.
- ~~`test-evie-app` / `test-evie-desktop` for integrated client passes.~~ Those are t3code skills.
  Now points at the `run` skill, which knows how to launch this project.
- ~~Paths presented as if they exist.~~ "Where code lives" now separates what is here today from
  what Phase 0 creates, so an agent checks instead of assuming.
- ~~"The three ways to hurt yourself", with two listed, using Linux-only commands.~~ Two ways, and
  the port-owner lookup is `lsof`, since this repo is developed on macOS. `ss` and `/proc` would
  have failed on the one machine that runs it.
- ~~`@repo/eslint-config` alongside `@evie/*`.~~ Everything is `@evie/*`.
- ~~`apps/mobile` (React Native) listed as a surface.~~ Out of scope for these phases;
  `@evie/client-runtime` is shaped so it can be added later without a rewrite.

One forward reference remains on purpose: `docs/internals/glossary.md`, which Phase 0 creates. It is
marked as such in `AGENTS.md`.
