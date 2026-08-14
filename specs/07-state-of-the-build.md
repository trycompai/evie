# 07 — State of the build

Docs 01–06 settle the design. This one is the handoff: what exists in the tree
today, what is genuinely proven, what is missing, and what to build next.
Written 2026-08-14 against the working tree, after a full read of the source.

Two rules for keeping it useful:

- **Nothing is marked done because a file exists.** Where something is wired to
  a no-op, it says so. The pattern that recurs in this repo is a complete,
  careful subsystem connected to nothing — that is what most of this document
  is about.
- **When it drifts, fix it in the same PR.** A status document that lies is
  worse than none, because people plan against it.

## The shape today

| Package | Lines | State |
| --- | --- | --- |
| `@evie/server` | ~9,400 | Boots, migrates, authenticates, serves RPC, projects, supervises eve runtimes. Several load-bearing seams wired to no-ops. |
| `@evie/ui` | ~3,500 | Design system ported 1:1 from the Paper file, 27 components. |
| `@evie/web` | ~2,000 | All seven Paper screens. Reaches **5 of 40** commands. |
| `@evie/landing` | ~1,900 | Next 16, all ten sections of the Paper Landing page. Server components only. Built by the maintainer. |
| `@evie/contracts` | ~1,800 | The wire as Effect Schema. |
| `@evie/client-runtime` | ~940 | RPC client, external store, row-level subscriptions. |
| `@evie/shared` | ~260 | ULID, home paths, slugs, truncation. |
| `apps/desktop` | 0 | **Does not exist.** |

`turbo run check-types lint test` is 20/20 tasks, 76 tests. Read that number
carefully: see [The quality gate is thinner than it looks](#the-quality-gate-is-thinner-than-it-looks).

**Nothing is committed.** ~20,000 lines of uncommitted working tree on `main`.
Fix that before anything else here.

## What is genuinely proven

Observed against a running server writing to a worktree-local `.evie`:

| Claim | How it was checked |
| --- | --- |
| One SQLite writer, two migration owners | Booted; `state.sqlite` holds Better Auth's 10 tables and Evie's 14. Decision 015 holds; the Phase 0 spike resolved to option 1. |
| Local login with no prompt | Claim token redeemed, session cookie set with `activeOrganizationId`; replay returns 401. |
| Phase 0's "done when" | Handshake, `CreateBot` through a real `hasPermission` check, receipt, and the bot arriving on `fleet.subscribe`. Driven with the real client, so MsgPack round-trips both ways. |
| The app runs in a browser | Chrome, real bundle: claim redeemed, socket 101, `session.hello` answered, onboarding rendered. |
| Projection latency | 10 ms, down from 17.9 s once provisioning moved out of the projector. |
| Reactors resume from their cursor | Killed mid-work; the projector replayed and materialised the missing row. |
| The UI matches the design | Every screen screenshotted from a fixture gallery beside its Paper artboard. Divergences recorded in `docs/internals/design-system.md`. |

**What has never been proven: an actual agent turn.** No eve runtime has been
observed answering. There is no integration test and no recorded-stream fixture,
so `EveAdapter` — 868 lines and the most intricate module in the repo — is
unexercised. Everything downstream of "the bot replied" is theory.

## The critical path to a working product

These four, in order, are what stand between "boots" and "a bot answers you".
Each is small. Together they are the difference between a demo and a product.

### 1. The API key never reaches a runtime

The BYOK pitch dead-ends twice over:

- There is no settings screen and nothing calls `setSecret`.
- **`Secrets.valueForSpawn` has zero callers.** Even if the UI existed, a stored
  key would go nowhere: `Supervisor.spawn` injects only `EVIE_BOT_ID`,
  `EVIE_RUNTIME_SECRET`, and `EVIE_ALLOWED_HOSTS` (`Supervisor.ts:144-155`).

The only working path today is `AI_GATEWAY_API_KEY` exported in the server
operator's own shell, inherited by the eve child through `extendEnv: true`.
Nothing documents that; it has to be reverse-engineered.

`docs/user/getting-started.md` says "Paste it in Settings → Models". That screen
does not exist. **That document is currently false** — it also describes a
desktop app, device pairing, and remote access, none of which exist. Correct or
withdraw it.

### 2. A reload shows an empty app even with data on disk

The web client never calls `bots.list` or `threads.list`. Both are fully
implemented server-side. The rail is fed exclusively by `fleet.subscribe`
frames, which carry deltas and no initial snapshot.

So on every cold load `bots.length === 0`. Worse, `app.tsx:60` initialises the
onboarding state from `bots.length` on the first render of `Signed`, which runs
before any frame arrives and never re-derives — **an existing user is dropped
into first-run onboarding every time they open the app.**

Two fixes: fetch a snapshot on connect, and derive onboarding from something
that settles.

### 3. The model is hard-coded

`app.tsx:219` pins `anthropic/claude-opus-4.8`. There is no model picker and no
reasoning control anywhere, which **violates decision 007** — the one the spec
calls "the point of BYOK". The server honours `SetModel` and shells out to
`eve set` correctly; only the UI is missing.

### 4. The chosen sandbox backend never reaches the bot

`scaffold.ts:126-140` always writes `defaultBackend()`. The bot row's backend,
the decider's `just-bash` isolation refusals, and any future UI switch never
cross into the eve project. Only the network allow-list rides through, via
`EVIE_ALLOWED_HOSTS`.

## The desktop app

`apps/desktop` does not exist. `AGENTS.md` calls desktop "the main surface most
users install first", and several seams are already cut for it — the web app is
written to be wrapped:

| Seam | Where | What the shell must do |
| --- | --- | --- |
| `IS_DESKTOP` | `apps/web/src/app.tsx:26` — tests `"evie" in globalThis` | Preload exposes `window.evie`. Nothing else switches on platform, so every `desktop` branch is dead code today. |
| Drag regions | `rail.tsx`, `thread-header.tsx` — `WebkitAppRegion: drag` | `titleBarStyle: "hidden"`, so the rail owns the top of the window as the design draws it. |
| `TrafficLights` | `traffic-lights.tsx` | Takes `onClose`/`onMinimize`/`onZoom`. **Rendered with no handlers** (`app-rail.tsx:64`) — the buttons are inert. Wiring them is part of this work. |
| `Notifier` | `reactors/notify.ts` | A real transport. `layer.ts:95` wires `layerNoop`, so `deliver` always returns false and **no `NotificationDelivered` receipt is ever appended**. |
| Secrets keychain | `secrets/Secrets.ts:69` | Swap the file read for macOS Keychain / Windows Credential Manager; Linux keeps `secrets.key` at 0600. |
| Static serving | `EVIE_WEB_DIST` in `gateway/http.ts` | Already works — this is how the app is served today. |

**Design, settled before it is built:**

1. **The shell owns the server as a child process, not in-process.** Electron's
   main process is a poor host for a server that must outlive a window, and a
   crash in one should not take the other down. Capture the PID at spawn and
   kill by that PID on quit — `AGENTS.md` rule 1 applies to the shipped product
   exactly as it applies to development.
2. **Tray-resident.** Closing the window stops nothing; quit from the tray stops
   the server. That is the "works after you close your device" promise, and on
   desktop it is deliverable without a cloud.
3. **The window opens on the claim URL.** The server prints
   `http://127.0.0.1:<port>/?claim=<token>` on boot (`layer.ts:127-136`). Read it
   from the child's stdout and load it. Do not invent a second auth path.
4. **Notifications are the server's, delivered over IPC.** `NotifyReactor`
   already decides *when*, is snooze-aware, and refuses to fire for events older
   than its own start time. The shell supplies delivery only.
5. **Deep links.** Register `evie://`; `evie://thread/<id>` becomes a message
   into the renderer, not a URL — the web app has no router by design.
6. **Auto-update ships the server and the UI together.** `session.hello` already
   refuses a `CONTRACT_VERSION` mismatch, which is what makes that safe.

Out of scope for v1: signing and notarisation, Windows and Linux, auto-update
itself. Get a tray app running on macOS first.

## Complete subsystems connected to nothing

The recurring shape in this repo. Each of these is real, careful code that no
caller reaches:

| Thing | Reality |
| --- | --- |
| `Notifier` | Reactor logic complete. Transport is `layerNoop`. Nothing is ever delivered. |
| `ClientPresence` | `layerNone`: `isAttached` always false, so a runtime idle-stops after 10 minutes even with a client watching. `presence.set` writes an open-thread set that nothing reads. |
| Plugins catalogue | `plugins.catalog` returns `listings: []` **on the server** and the app passes `listings={[]}` anyway. `ConnectService` writes a DB row and **never writes `agent/connections/<name>.ts`**, so a "connected" service has no effect on the agent. |
| Blobs | `blob`/`blob_ref` tables, `blobs.grant`, and `GET /blob/:id` with the org check are all built — and **nothing ever inserts a blob**. There is no upload path, so no grant can succeed. Tool truncation sets `truncated: true` with no `blobId`, so a truncated payload can never be expanded. `SendMessage.attachments` are dropped at dispatch anyway. |
| `SetInstructions` | Validates, emits a **content-free** `InstructionsChanged`, and no reactor consumes it. Scaffold never rewrites `instructions.md` after creation. The text is dropped on the floor. |
| Routines | Backend is complete and careful — tz-aware cron, `next_run_at` recomputed from `(cron, tz)` at boot, blocked-once semantics, run-as-left backstop. Zero UI. |
| Member-scoped connections | Schema, commands, grant secrets, and `principalType: "user"` JWTs all built. Grant tokens are never injected into a runtime. |
| `computer.list` | Real server implementation; no client caller. It also reads the **host filesystem** under the bot's project dir, which is fine in dev mode and wrong the day a real sandbox lands. |
| `loadMore` / `closeThread` / `presence.closed` | Implemented, tested at the store level, zero callers. A thread longer than the first 60 items silently shows only its tail. |
| `SignInScreen`, `ContextMeter`, `button.tsx` | Finished components rendered only by the gallery, or by nothing. The Better Auth browser client is constructed in `runtime.ts` and never called. |
| `Actor` in `contracts/rpc.ts` | Dead duplicate; the server defines its own in `domain/state.ts`. |
| `connection_grant`, `device` tables | Zero readers or writers anywhere. |

## Outright bugs

Distinct from "not built yet" — these are wrong, not absent:

| Bug | Where |
| --- | --- |
| **`@evie/contracts` exports `./eve` pointing at a file that does not exist.** Any import of it fails to resolve. | `packages/contracts/package.json` |
| **The bot's chosen face is discarded.** `CreateBotInput.avatar` exists; `BotCreated` does not carry it, so the projection always stores `avatar: null` and every bot falls back to a hash of its id. The new-bot picker's entire purpose is lost. | `decide.ts:132-145` |
| **"Always for this session" approvals never reach eve.** `AnswerInput.scope` survives into the event and is then dropped when building the response. | `bridges.ts:110-125` |
| **`reconnecting` is never emitted.** The status exists, the rail renders it, and no server code produces it — so the specified "UI shows *reconnecting*, not an error" does not happen. | `contracts/thread.ts` vs server |
| **`CredentialProblem` is never constructed.** Defined and round-trip-tested; no code path raises it, so the specified "typed error and a *Fix in Settings* action" cannot occur. | `contracts/errors.ts` |
| **Connect-apps selections are discarded.** The onboarding picks land in a `Set` that is dropped on "done"; no `ConnectService` is sent. | `app.tsx:72` |
| **`vite.config.ts` contradicts `README.md`** about whether the Vite WS proxy works. Both are in the repo; the README is right. | `apps/web/vite.config.ts:52-58` |
| **`docs/user/getting-started.md` describes a product that does not exist** — desktop app, Settings → Models, device pairing, remote access. | `docs/user/` |

## The quality gate is thinner than it looks

`20/20 tasks, 76 tests` overstates the case:

- **Lint cannot fail.** `packages/eslint-config/base.js` uses
  `eslint-plugin-only-warn` and nothing passes `--max-warnings`, so every rule is
  a warning and `turbo run lint` is always green.
- **There is no CI.** No `.github/` at all, while `AGENTS.md` and `specs/06` both
  say "CI owns the full suite."
- **Three of the five roadmap-named tests are missing**: the reactor
  crash-recovery test (which the roadmap calls "the test that keeps
  work-continues true"), the supervisor leak test, and the adapter
  recorded-stream fixture. The decider and concurrency tests exist and are good.
- **Nothing starts the server.** No integration test, no socket, no RPC exercised
  end to end in CI-able form.
- **The `EvieEvent` union is not round-trip tested**, though every other wire type
  is — so the rc tripwire has a hole exactly where the log lives.
- **The perf budget is a table, not a check.** Every number in `specs/04` is
  by-construction; none is measured.
- **`turbo.json`'s `transit` task resolves to nothing** — no package defines the
  script, so the dependency edge it exists to carry is inert.
- **62 of 130 source files fail `prettier --check`**, and 9 are hard-diverged to
  tabs-with-semicolons by some other formatter. No format check runs anywhere.

## Spec-level gaps worth naming

- **Two of the three hard refusals in `specs/05` are missing.** Refusal 1 (no
  non-loopback bind while the only principal is the auto-provisioned owner) and
  refusal 2 (no second member into an org whose bots use `just-bash`) do not
  exist. Only refusal 3 is implemented and tested. The spec says 2 and 3 "have to
  reach the same answer or the check is decorative" — the window is guarded and
  the door is open.
- **Invitations are half-plumbed.** `Auth.invitationUrl` builds the share link
  server-side and no RPC returns it, no route accepts it, no UI exists. Decision
  013's mechanism is unreachable.
- **Retention is absent.** The 30-day event sweep and weekly blob sweep specified
  in `specs/03` do not exist — no deletion code anywhere.
- **Read-only degraded mode does not exist.** `StorageUnavailable` is typed and
  raised; the specified banner and degradation are not built.
- **Stale references.** `AGENTS.md` says "docs on 3001" (there is no docs app;
  3001 is the server) and calls the marketing site `apps/marketing` (it is
  `apps/landing`). `npx evie` is referenced in comments and UI copy as if it
  exists; there is no `bin` entry anywhere.
- **`apps/landing` is ahead of the product.** Its copy claims "v0.4 brings remote
  environments" and shows a star count placeholder. Nothing relay-shaped exists.

## What to build next, in order

1. **Commit what exists.** ~20,000 lines with no history is the single biggest
   risk in the repo.
2. **Make a bot able to answer.** In one pass: a settings screen that calls
   `setSecret`, and `Secrets.valueForSpawn` wired into `Supervisor.spawn`. Then
   write the adapter's recorded-stream fixture so the 868 lines nobody has run
   have a test.
3. **Fix the cold-load bug.** Call `bots.list`/`threads.list` on connect and
   derive onboarding from settled state. Today the app forgets your bots.
4. **`apps/desktop`**, to the design above. macOS, tray-resident, unsigned.
5. **The model picker.** Decision 007 is currently violated by the client.
6. **The outright bugs table**, top to bottom. Most are one-line fixes; the
   broken `./eve` export and the dropped avatar are minutes each.
7. **Refusals 1 and 2**, before anyone is invited to anything.
8. **A CI workflow, and `--max-warnings 0`.** Everything above is easier to keep
   once something other than a person is checking.
