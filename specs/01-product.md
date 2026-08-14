# 01 — Product spec

## What Evie is

Evie is a GUI for running persistent, named AI agents on hardware you control.

A user opens Evie and sees a sidebar of **bots** — not a list of chats. Each bot is a role they
created once ("Inbox", "Researcher", "Ops") and keeps talking to. Each bot has its own computer: a
filesystem, a shell, and eventually a browser, all sandboxed, all persisting between conversations.
Each bot can be given recurring work. Each bot can be signed in to the services it needs.

Underneath, a bot is an [eve](https://eve.dev) agent: a directory of files. Evie's job is to make
that directory feel like a person you message, to run a fleet of them well, and to let you reach
them from anywhere.

## What x.ai/bot does, and how Evie answers

Grok Bot launched in beta on 2026-08-11 for macOS, iOS, Windows, and Linux. Access requires SuperGrok
Heavy ($300/mo), Cursor Ultra ($200/mo), or Cursor Teams Premium ($120/seat/mo). There is no free
tier. Its shape is the thing worth copying; its economics are the thing worth replacing.

| #   | Bot capability                                                                | Evie approach                                                                                                                                     | eve primitive                                                | Phase |
| --- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ----- |
| 1   | Sidebar of named, role-specific bots rather than one-off tasks                 | A bot is an eve agent directory under Evie home. Name, avatar, description, model are bot-level records.                                          | filesystem-first agent layout                                    | 1     |
| 2   | Conversational setup — describe a need, the bot self-names and self-describes  | A built-in `botsmith` agent runs the onboarding turn and writes `instructions.md` for the new bot. The user can always open and edit the file.     | tools writing to disk; `eve info` to verify discovery           | 2     |
| 3   | iMessage-like chat; `@`-mention several bots in one conversation               | Threads have participants. One eve session per `(thread, bot)`. A mention dispatches a turn on that bot; cross-bot context rides as `clientContext`. | durable sessions + per-turn `clientContext`                     | 1 / 2 |
| 4   | Each bot gets a persistent cloud computer with browser, filesystem, terminal   | eve's per-session sandbox. Local: Docker, else microsandbox, else just-bash. Remote/hosted: Vercel Sandbox.                                        | `agent/sandbox`, `bash`/`read_file`/`write_file`/`glob`/`grep`  | 1     |
| 5   | Live view of the bot's screen                                                  | A terminal pane streaming `sandbox.spawn` output, then a CDP screencast pane for the browser extension.                                           | `SandboxProcess` stdout/stderr streams                          | 3     |
| 6   | Take over a bot's session from your phone                                      | Sessions are durable and cursor-addressed. Any client attaches at `startIndex` and takes over; input handoff goes through HITL responses.          | `GET /stream?startIndex=`, `inputResponses`                     | 2     |
| 7   | "Teach a task": record a browser session once, the bot generalizes it          | Record the tool/browser trace of a successful run, distill it into a `SKILL.md`, save it to the bot's `skills/`. Editable markdown, not a black box. | skills + progressive disclosure via `load_skill`                | 3     |
| 8   | Routines panel — recurring scheduled runs of a known task                      | Evie owns routine rows in SQLite and dispatches them. Editable at runtime; no rebuild to change a cron.                                            | `patterns/dynamic-scheduling`, one dispatcher schedule          | 2     |
| 9   | One-click plugins (Notion, Slack, Drive, Composio, Context7, …)                | A connection catalog that writes `agent/connections/*.ts`. MCP and OpenAPI both supported.                                                         | `defineMcpClientConnection`, `defineOpenAPIConnection`          | 2     |
| 10  | "Sign in, then hand it back" login handoff                                     | Two paths: an OAuth card rendered from `authorization.required`, and (later) takeover inside the live browser view.                                | `defineInteractiveAuthorization`, `authorization.*` events      | 2 / 3 |
| 11  | Approvals before consequential actions                                         | First-class in the composer, not a modal. Approve / deny / always-allow-for-this-session.                                                          | `input.requested`, `eve/tools/approval` (`never`/`once`/`always`) | 1     |
| 12  | Work continues after you close your device                                     | Turns are durable workflows; the Evie server keeps running (or the desktop app runs headless in the tray).                                         | step-level checkpointing, parked work                            | 1     |
| 13  | Notifications when a bot finishes or needs you                                 | Native notifications on desktop, Web Push on web, fired on `turn.completed` and `input.requested` while the thread is not focused.                 | stream events                                                    | 2     |
| 14  | **No model selection, no override**                                            | **Evie exposes model and reasoning effort per bot.** This is the point of BYOK.                                                                    | `agent.ts` model field / `eve set`                              | 1     |
| 15  | **$300/mo, no free tier**                                                      | **Free, self-hosted, bring your own AI Gateway token.**                                                                                            | AI Gateway or direct provider keys                               | 1     |
| 16  | Mobile app with full parity                                                    | Out of scope for these phases. `@evie/client-runtime` holds all client logic so React Native is additive, not a rewrite.                           | —                                                                | later |
| 17  | No live voice mode                                                             | Not planned. Dictation via the platform's own input.                                                                                               | —                                                                | —     |

## What Evie does that Bot cannot

These are not extras. They are the reasons to pick Evie.

1. **Your keys, your bill.** One Vercel AI Gateway token covers every model, and usage shows up in
   one dashboard you own. Direct provider keys also work.
2. **Your machine.** The sandbox is a container on your laptop. The files are on your disk. Nothing
   is uploaded to run.
3. **Model choice per bot.** A cheap fast model for the inbox triage bot, a frontier model for the
   research bot. Reasoning effort is a per-bot setting.
4. **Forkable.** A bot is a directory of markdown and TypeScript. Commit it, share it, diff it.
   Evie itself is a fork target — the maintainers expect forks and design for them.
5. **Remote without a vendor.** Reach your environment over your LAN, over Tailscale, or through a
   relay. tryevie.ai is a client, not a host.
6. **Shared bots.** Bot has no notion of a team — every bot belongs to one account. Evie is
   multi-tenant from the first migration: an organization owns bots, threads, and routines; members
   share them; teams partition them. A team's "Ops" bot is one bot everyone talks to, with each
   member's own Linear or GitHub account behind it, and one bill they can attribute per person.

## Non-goals

- **We are not building an agent runtime.** If a capability belongs in eve, we upstream it or wait.
- **We are not building a coding IDE.** Bots get a real computer, but Evie is not a code editor.
- **No custom roles at launch.** Organizations, members, and teams ship; `owner`/`admin`/`member`
  covers a team sharing an Evie box. Dynamic access control is available in Better Auth if we ever
  need it, and every additional role is another way to get the sandbox threat model wrong.
- **No billing, seats, or usage metering as a product.** Spend visibility yes; charging people, no.
- **No telemetry by default.** If we add any, it is opt-in and documented in `docs/user/`.

## The experience bar

The maintainers' framing, made concrete:

- Opening a thread with 2,000 messages renders in under 100ms and never blocks the composer.
- A streaming reply commits at most one React render per animation frame.
- No animation repaints continuously. A "thinking" indicator ticks on a 1s `steps()` interval, not
  a GPU-bound loop.
- Every spinner is truthful. If a turn is parked waiting on a person, the UI says *waiting on you*,
  not *thinking*.
- Every way in has a way out. Snooze has unsnooze. Archive has unarchive. Deny has retry.
