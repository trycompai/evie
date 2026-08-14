# 06 — Repo layout and roadmap

## Target repo layout

```
apps/
  server/            @evie/server           Effect. RPC gateway, control plane, supervisor, adapters.
  web/               @evie/web              React 19 + Vite. The UI.
  desktop/           @evie/desktop          Electron shell; bundles server + web.
  marketing/         @evie/marketing        tryevie.ai. Phase 4.
packages/
  contracts/         @evie/contracts        Effect Schema wire contracts + RpcGroup. No runtime logic.
  client-runtime/    @evie/client-runtime   RPC client, store, timeline projection. Zero DOM.
  shared/            @evie/shared           Runtime utils. Subpath exports, no barrel.
  ui/                @evie/ui               shadcn base-nova. Exists.
  eslint-config/     @evie/eslint-config    Exists.
  typescript-config/ @evie/typescript-config Exists.
.repos/
  effect/            Vendored, read-only. Read LLMS.md before writing Effect.
  alchemy/           Vendored, read-only. Read AGENTS.md before writing Alchemy.
docs/
  user/ internals/ operations/
specs/
```

### Turborepo

**Done.** `turbo.json` was Next.js-shaped (`.next/**` outputs) and used `dependsOn: ["^lint"]` /
`["^check-types"]`. It now reads:

```jsonc
{
  "globalEnv": ["NODE_ENV"],
  "globalPassThroughEnv": ["CI", "EVIE_HOME"],
  "tasks": {
    "transit":     { "dependsOn": ["^transit"] },
    "build":       { "dependsOn": ["^build"], "inputs": ["$TURBO_DEFAULT$", ".env*"],
                     "env": ["VITE_*", "EVIE_CONTRACT_VERSION"],
                     "outputs": ["dist/**", "out/**", ".output/**", "release/**"] },
    "dev":         { "cache": false, "persistent": true,
                     "passThroughEnv": ["AI_GATEWAY_API_KEY", "BETTER_AUTH_SECRET", /* … */] },
    "test":        { "dependsOn": ["transit"], "outputs": ["coverage/**"] },
    "lint":        { "dependsOn": ["transit"] },
    "check-types": { "dependsOn": ["transit"] }
  }
}
```

Three things worth understanding rather than copying:

- **`transit`, not `^lint` or `^build`.** A transit node is an empty task that exists only to carry
  the dependency edge, so `lint` and `check-types` run in parallel across packages while still
  invalidating correctly when a dependency changes. `dependsOn: ["^lint"]` forces them sequential
  for no benefit; `check-types: ["^build"]` would be worse here, because our internal packages are
  just-in-time and emit nothing for it to wait on. Revisit only if a package starts emitting `.d.ts`.
- **Environment variables must be declared or they are not in the hash.** Turborepo hashes what you
  list. Without `env` / `globalEnv`, a build under a different `EVIE_HOME` or gateway host gets a
  false cache hit — and `inputs: [".env*"]` does not cover it, because the value came from the shell,
  not a file. Secrets go in `passThroughEnv`: available to the task, never in the hash.
- **`dev` stays uncached and persistent.** Filter with `--filter=@evie/web`; never `cd` into an app
  and run its script directly when other packages need to run alongside it.

### Root package.json

**Done.** `engines.node` said `>=18`, which contradicts the `node:sqlite` requirement — now `>=24`.
`packageManager: "bun@1.3.12"` was missing and is now set, so Turborepo detects the package manager
from the field rather than inferring it from the lockfile.

## Dependencies to add

| Package                    | Where                | For                                                       |
| -------------------------- | -------------------- | --------------------------------------------------------- |
| `effect`                   | root (dev) + server  | Runtime, Schema, Layer, RPC, Socket, HTTP                 |
| `@effect/platform-node`    | server               | `NodeHttpServer`, `NodeSocketServer`, `NodeChildProcessSpawner` |
| `@effect/sql-sqlite-node`  | server               | SQLite over `node:sqlite`, migrator                        |
| `better-auth`              | server               | Auth                                                       |
| `kysely`                   | server               | The dialect Better Auth executes through (see [05](./05-auth-secrets-remote.md#one-database-handle)) |
| `eve`                      | per-bot project      | The agent runtime. Installed into each bot dir, not the workspace root. |
| `react@19` / `react-dom`   | web                  | UI                                                         |
| `vite@8` / `@vitejs/plugin-react` | web           | Build                                                       |
| `electron` / `electron-builder` | desktop         | Shell + packaging                                           |

Add each in the package that uses it, never as a root app dependency. `effect` also goes in as a
root dev dependency so `node_modules/effect/src` is readable — though this repo prefers the vendored
`.repos/effect` for that.

**Pin the Effect packages to one exact release-candidate version — no range.** `effect@4.0.0-rc.*`
would float across release candidates, and an rc is allowed to break between numbers. Worse,
`effect` and every `@effect/*` package release in lockstep and expect to match: a resolution where
`effect` is one rc and `@effect/sql-sqlite-node` is another produces service-identity mismatches
that fail at runtime, not at compile time, and read as "the layer isn't provided" rather than as a
version skew. So `"effect": "4.0.0-rc.109"` and every `@effect/*` at `4.0.0-rc.109` exactly, bumped
together and deliberately, matching the vendored `.repos/effect`. Upgrading is a task, not a
side effect of `bun i`.

Per the effect-ts skill, `AGENTS.md` should keep pointing agents at the Effect source before they
write Effect. It already does, via `.repos/effect/LLMS.md`.

## Phases

Each phase ends with something a user can run. No phase is "infrastructure only".

### Phase 0 — Skeleton (fits in a week)

- `apps/server`, `apps/web`, `packages/contracts`, `packages/client-runtime` scaffolded.
- ~~Turborepo tasks fixed; `@repo/*` renamed to `@evie/*`.~~ **Done**, along with the root
  `engines.node` and `packageManager` fields.
- **Spike first: how Better Auth reaches SQLite.** Everything else in this phase writes migrations
  against the answer, and it decides whether the auth tables live in `state.sqlite` or their own
  file. One writer either way. See [05](./05-auth-secrets-remote.md#one-database-handle).
- Evie home layout, SQLite with migrations, Better Auth in `local` mode — with the one-time claim
  token, not a cookie handed to the first loopback caller.
- `reactor_cursor` and the resume-from-cursor loop, before any reactor has real work to do. It is a
  dozen lines while the first reactor is a stub and a rewrite once four of them exist.
- **The `organization` plugin with `teams` enabled, and every Evie table org-scoped.** No member UI
  yet — first boot silently creates a personal organization. This is here rather than in Phase 3
  because adding `org_id` to eleven tables later is precisely the migration this spec exists to
  avoid, and because the permission middleware has to sit under the RPC layer from the first handler.
- RPC over WebSocket with one command and one subscription end-to-end, with `session.hello` version
  checking and `hasPermission` middleware already in the path. Both are middleware; retrofitting
  either under a dozen existing handlers is the work this phase exists to avoid.
- Per-aggregate command serialization and `expectedVersion` on append, for the same reason.

**Done when:** `bun run dev` opens a browser, you log in with no prompt, and a round-trip command
appears in a subscription — having passed a real permission check against a real organization, and
a version handshake.

### Phase 1 — One bot, one thread, real work

The minimum that is actually useful.

- Create a bot: scaffolds an eve project, writes `agent.ts`, `instructions.md`, `channels/eve.ts`,
  `sandbox/sandbox.ts`, `git init`.
- Supervisor: lazy start, idle stop, health, crash restart, PID discipline.
- `EveAdapter`: dispatch turns carrying the acting member's JWT, ingest the NDJSON stream, mirror
  events, project the timeline. Reasoning streams live and is discarded, not stored.
- Chat: streaming text, tool rows, cancel, compact, clear.
- **Approvals** — `input.requested` → inline card → `respond()`. This is table stakes for an agent
  with shell access, so it ships in Phase 1, not later.
- Onboarding: paste an AI Gateway token. Model + reasoning picker per bot.
- Computer pane: file tree and terminal over the sandbox.
- Frame coalescing, virtualized timeline, the perf budget enforced.

**Done when:** you create a "Research" bot, give it a task, watch it run `bash` in a container,
approve a write, and get a useful answer — with the app idle at ~0% CPU while it thinks.

### Phase 2 — A fleet, and it keeps working when you close the laptop

- Multiple bots; `@`-mentions; multi-participant threads via `clientContext`.
- **Teams surface: invitation links, roles, member management, team-scoped bots.** The schema has
  been there since Phase 0; this is the UI plus the `just-bash` invitation block.
- **Member-scoped connections** — each member links their own account; routines pin a `run_as`.
- Routines: cron rows with an explicit timezone, editable in the UI, dispatched by `Scheduler`. The
  editor defaults the zone to the environment's and shows it, because "9am" silently meaning a
  different hour after a flight is the kind of bug nobody reports and everybody stops trusting.
- Connections catalog: MCP + OpenAPI, static tokens, interactive OAuth with the sign-in card.
- Notifications: native on desktop, Web Push on web. Deep links.
- Remote: `lan` mode, device management, revocation.
- Checkpoints: per-turn `/workspace` commit, diff, restore.
- Attachments in and artifacts out.
- Snooze / unsnooze / archive / unarchive across bots and threads.
- Usage view broken down by bot and by member.
- `apps/desktop`: tray-resident, keychain, auto-update.

**Done when:** two people share one Evie box, each talking to the same Ops bot through their own
GitHub account, and a 30-minute routine does useful work overnight while both laptops are shut.

### Phase 3 — The computer becomes visible

- Live browser view: agent-browser extension + CDP screencast in the Computer pane.
- Takeover: click into the bot's browser, sign in, hand it back. Bot's "sign in, then hand it back",
  which is the single best interaction in their product.
- **Teach a task:** record a successful run's tool and browser trace, distil it into a `SKILL.md`
  the user can read and edit, save it into the bot's `skills/`. Bot's version is a black box; ours
  is a markdown file you can fix.
- Subagents surfaced as nested collapsible runs with live child streams.
- Spend controls and the usage view.

**Done when:** you demonstrate a task once and the bot repeats it tomorrow, and you can open the
skill it learned and correct one line of it.

### Phase 4 — Reach

- `npx evie` as the canonical local server, same binary as the desktop bundle.
- Relay + tryevie.ai as an end-to-end-encrypted thin client.
- `apps/marketing`.
- Bot templates and a share format (a bot directory is already portable; this makes it one click).

## Verification

Per `AGENTS.md`, smallest proof. No repo-wide checks — CI owns the full suite.

```bash
turbo run test        --filter=@evie/server
turbo run check-types --filter=@evie/web
turbo run lint        --filter=@evie/contracts
```

Rules that matter more here than usual:

- **Backend behaviour changes ship with focused tests.** The decider is pure — test it with no
  model, no process, no socket.
- **Wait on receipts, never on sleeps.** Every async flow emits one. A test that needs a timeout to
  pass is testing the timeout.
- **The adapter gets a recorded-stream fixture.** Capture a real eve NDJSON stream once, replay it
  in tests. That covers retried steps re-emitting under new ids, interleaved subagent events, and
  coalescing — none of which are reproducible against a live model.
- **The supervisor gets a leak test.** Start N runtimes, tear down the scope, assert every captured
  PID is gone. Never find a PID by pattern.
- **Reactors get a crash-recovery test.** Append the trigger event, kill the runtime before the
  handler's cursor write, restart, and assert the work happens exactly once. This is the test that
  keeps "work continues after you close your device" true, and it is the one an in-memory queue
  passes right up until it is real.
- **The decider gets a concurrency test.** Two commands against one aggregate, issued together;
  assert one wins, the other refolds and retries, and the event log has no lost write. Then the
  same against two *different* aggregates, asserting they do not serialize against each other —
  otherwise the semaphore has quietly become a global lock.
- Client verification in a real browser or the desktop app happens once, by the primary agent, after
  integration — and only with permission.

## Resolved

The four questions this spec opened with have all been decided. The numbered decision log lives in
[README.md](./README.md#decisions); these four are entries 012, 011, 009, and 014 there.

1. **`eve dev --no-ui` in local mode — approved.** Recorded as decision 012; mitigations in
   [02-architecture.md](./02-architecture.md#which-eve-mode-to-run).
2. **Reasoning is never persisted.** Streamed live to subscribed clients, then discarded; a token
   count survives so the UI can still say *thought for 4.2k tokens*. It is the most sensitive text
   the model produces, it dominates disk, and nobody rereads it. One toggle away if that changes.
   See [03-contracts-and-data.md](./03-contracts-and-data.md#retention-and-why-reasoning-is-never-written-down).
3. **Teams first.** Better Auth's `organization` plugin with `teams` enabled, org-scoping in the
   first migration, member-scoped connections through eve's `principalType: "user"`. The full model
   is in [05-auth-secrets-remote.md](./05-auth-secrets-remote.md).
4. **eve pinned per bot directory** so upgrades are deliberate and per-bot.

## Still worth watching

Not blocking, but they will need answers as the phases land:

- **The teams threat model.** A member who can message a bot can run code on the host. Evie leans on
  sandbox isolation and blocks invitations on `just-bash`. Revisit if we ever want a read-only or
  "can chat but not run tools" role — that is a genuinely different permission axis than the three
  roles we ship.
- **Where an organization lives.** Today an org is scoped to one environment, one machine. A person
  in two organizations on two different machines has two Evie servers. If that becomes common, the
  relay is the natural place to reconcile it, not the schema.
- **Invitation delivery without SMTP.** Share links are correct for self-hosting, but a link pasted
  into Slack is a bearer credential until it is accepted. Short expiry and email binding cover it;
  watch whether that is enough in practice.
- **We are building on a release candidate, on purpose.** Effect 4 is at `4.0.0-rc.*`, and the
  modules the entire wire contract rests on — `RpcServer`, `RpcSchema.Stream`,
  `RpcSerialization.msgPack`, the SQL client — live under `effect/unstable/*`, which is the
  library's own word for "this will move". `apps/web` compounds it: Vite 8 is in beta and swaps
  both the bundler (Rolldown) and the transformer (Oxc).

  This is an accepted trade, not an oversight — the rc APIs are the ones we want and the vendored
  `.repos/effect` means we can always read what actually changed. What it costs is that an upgrade
  is a scheduled task with a real chance of a breaking diff, never a routine bump. Mitigations:
  exact pins across `effect` and every `@effect/*`, the vendored copy kept at the same version, and
  a contract test suite over `packages/contracts` that fails loudly when a schema stops
  round-tripping. If the rc churn ever costs more than it buys, the exit is `EveAdapter`-shaped:
  the RPC layer is one package, and `@evie/contracts` is deliberately free of runtime logic.
- **The relay's cryptography.** The "cannot read them" promise is specified in
  [05](./05-auth-secrets-remote.md#what-the-relay-claim-actually-requires) but not designed. It is
  the most load-bearing public claim in the product and it blocks nothing until Phase 4 — which is
  exactly how a thing like this ships late and thin. Design it before `apps/marketing` says it.
