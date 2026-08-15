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
| `@evie/shared` | ~340 | ULID, home paths, slugs, truncation, the desktop bridge contract. |
| `@evie/desktop` | ~1,200 | Tray-resident macOS shell. Owns the server as a child, native window buttons, deep links, notification delivery. No installer. |

`turbo run check-types lint test` is 20/20 tasks, 129 tests. Read that number
carefully: see [The quality gate is thinner than it looks](#the-quality-gate-is-thinner-than-it-looks).

**Nothing is committed.** The whole working tree is uncommitted on `main`. Fix
that before anything else here.

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
| The desktop app works | Driven over CDP against a real server: preload bridge exposed with no `ipcRenderer`/`require`/`process` leaking to the page; zoom resizes the window and back; minimize hides it; close hides while shell and server keep running; `evie://thread/<id>` from a second launch forwards through the single-instance lock and selects the thread; SIGKILL of the shell leaves no orphaned server. |
| The rail loads on a cold start | The window opens onto a populated fleet read from disk, not an empty rail. |

**A bot now answers.** Observed end to end: a message typed into the real
composer, dispatched, answered by `anthropic/claude-opus-4.8` through a stored
gateway key, and rendered in the timeline. Getting there took seven defects, and
their shape is the lesson — every one was silent, and each sat *behind* the one
before it, so no single fix ever produced a visible improvement:

1. **A terminally failed session was never forgotten.** The first failure left
   `thread_participant.eve_session_id` pointing at a dead session; every later
   message dispatched into it, eve refused, and the reactor channel swallowed
   the refusal. No error, no reply, permanently mute.
2. **A new session was never attached to.** `ensureAttached` keyed its fiber by
   `(thread, bot)` with `onlyIfMissing`, which cannot tell "already attached"
   from "attached to a session that is gone". eve ran the turn; nobody read it.
3. **`TimelineItem.turnId` was typed as `TurnId`.** The value is the *provider's*
   turn reference (`turn_7`), not Evie's minted ULID. The projector cast to it,
   so it type-checked, and `Schema.encodeSync` **threw** at persist time — a
   defect, not a failure, which rolled back the ingest transaction and left the
   stream cursor unadvanced. Every attach re-read the same events and threw
   again. Eight replies sat in that backlog and appeared at once when it lifted.
4. **The projector read `payload.text`.** eve sends `message` on a completion
   and `messageSoFar` on a delta. Even with the schema fixed, every reply would
   have rendered as an empty bubble.
5. **The composer's Send button was a Stop button.** Its trailing action put
   `canStop` ahead of `hasText`, so with a turn running and a message typed the
   button cancelled instead of sending — while Enter sent normally, because
   `handleKeyDown` never consults `streaming`. Combined with #1–#4, which left
   every turn permanently "running", the button was *always* Stop. The
   component's own comment already described the intended rule ("a message sent
   mid-turn cancels the in-flight one and starts a replacement — that is what a
   chat UI implies and what the button does"); only the precedence disagreed.
   Worth noting how it presents: works from the keyboard, dead to the mouse,
   which reads as "my messages don't send" and as "works for me".
6. **Two servers, one home.** Making the desktop app's launcher a `dev` script
   meant `turbo dev` started it *and* the standalone server against the same
   `EVIE_HOME`. Both supervisors spawn `eve dev` in the same bot directory, eve
   dedupes to one runtime, and the server that did not start it gets 401 on
   every turn — forever, for exactly the bots the other one warmed. Decision 015
   ("exactly one SQLite writer per process") had only ever been enforced within
   a process; nothing stopped a second one. `home-lock.ts` now claims the home
   with a pid file: a live holder is refused with a message naming it, a dead
   one is taken over silently so a crash needs no cleanup.

   Excluding the app from `turbo dev` fixed the conflict and broke the thing
   people actually wanted, which was one command. So the lock became discovery
   as well as exclusion: it carries the server's URL and launcher token, and a
   shell that finds a home already served **adopts** that server instead of
   starting a rival — pointing its window at Vite on `localhost:3000`, which has
   the UI the API-only dev server does not, plus hot reload. It mints a fresh
   claim on adoption (the printed one is single-use and long expired) and never
   signals a server it did not start. `bun run app` remains the standalone
   launcher. Mutual exclusion and "who is already here" are the same question,
   and answering both from one file means they cannot disagree.
7. **Two projections raced for `timeline_item.seq`.** The projector reactor and
   `EveAdapter` each fold `apply` over their own `ReadModel` and each allocated
   row positions from its own in-memory counter. They agree only until one
   projects an event the other never sees — the reactor handles `MessageSent`
   and checkpoint rows, the adapter handles assistant and tool rows — after
   which both eventually issue the same number to different rows and the unique
   index rejects the second. That took the **projector loop down entirely**, so
   the UI silently stopped updating while the server looked healthy. Positions
   are now allocated in SQL (`coalesce(existing, max+1)`) under the single
   writer, so neither caller can name one. It had been latent for as long as the
   adapter's writes were failing for reason 3; fixing that surfaced this.

The through-line: a cast that lies (`as TurnId`) and a field name assumed rather
than read. Both type-check. `EveAdapter` still has no recorded-stream fixture,
so ingestion remains the least-tested code in the repo — `assistant-text.test.ts`
now pins the two halves that failed silently.

## The critical path to a working product

These four, in order, are what stand between "boots" and "a bot answers you".
Each is small. Together they are the difference between a demo and a product.

**#1 and #2 are both fixed.** A bot answers today. What remains on #1 is the
last mile of the *product* rather than the plumbing: there is still no settings
screen, so the only way to get a key in is the one used to prove this worked —
storing it through `Secrets` directly.

### 1. The API key never reaches a runtime

The BYOK pitch dead-ends twice over:

- There is no settings screen and nothing calls `setSecret`. **This is now the
  whole of the gap** -- the server half is done.
- ~~`Secrets.valueForSpawn` has zero callers.~~ **Fixed.** Stored secrets reach
  the eve child's environment, org scope first so a bot-scoped key wins, and
  stored beats an operator's shell export -- deliberately, because a control
  that reports it took a key while an invisible export keeps serving the old one
  is worse than no control. Two things the review caught and that are now
  guarded at the same choke point: connection grants (`grant:<id>`, org-scoped)
  were landing in every runtime's environment under a name nothing reads, and a
  secret named `NODE_OPTIONS` or `PATH` would have reconfigured the process it
  was meant to credit.

The only working path today is `AI_GATEWAY_API_KEY` exported in the server
operator's own shell, inherited by the eve child through `extendEnv: true`.
Nothing documents that; it has to be reverse-engineered.

`docs/user/getting-started.md` says "Paste it in Settings → Models". That screen
does not exist; the document has been corrected to say so, and to document the
environment-variable path that does work. Device pairing and remote access are
still described nowhere because they still do not exist.

### 2. A reload shows an empty app even with data on disk — **fixed**

The rail was fed exclusively by `fleet.subscribe`, and `Hub.subscribeFleet`
registered a subscriber that only ever emitted on a *delta*. A client joining a
quiet org received nothing at all, so on every cold load `bots.length === 0`.

Two halves, both landed:

- **The server backfills.** `fleet.subscribe` now reads a snapshot and
  concatenates the live stream, exactly as `subscribeThread` already did. The
  subscription opens *before* the read, so an event arriving in between is
  queued rather than lost — it replays as a delta over rows the snapshot already
  carried, which the client merges by id. `bots.list` / `threads.list` and the
  snapshot share one query each, because two copies of a query that must agree
  is how a rail ends up showing something the list does not.
- **The client waits for it.** `FleetSnapshot.loaded` gates the first paint, and
  the view is derived from settled state rather than from `bots.length` on the
  first render.

Worth recording as a near miss: the `loaded` gate landed first, and on its own
it turned "wrong screen" into *blank window* — a strictly worse failure, and the
one that showed up in the desktop app. A gate is only as good as the thing it
waits for.

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

**Built.** `apps/desktop` is a tray-resident macOS shell, verified end to end
against a real server: window controls, deep links, close-to-tray, and the
guarantee that the server never outlives it.

### How it is put together

| Piece | File | Notes |
| --- | --- | --- |
| Shell entry | `src/main/index.ts` | Single-instance lock, `evie://` registration, IPC, signal handling. |
| Server child | `src/main/server.ts` | Spawn, ready-line parsing, restart backoff, PID-tracked shutdown. |
| Window | `src/main/window.ts` | `titleBarStyle: "hidden"`, native window buttons repositioned to the design's coordinates. |
| Tray | `src/main/tray.ts` | Status line, Open, Restart Server, Quit. The only way to quit. |
| Notifications | `src/main/notifications.ts` | Delivery only; the reactor still decides when. |
| Preload | `src/preload/index.ts` | Exposes exactly `@evie/shared/desktop-bridge`. |
| Bridge contract | `packages/shared/src/desktop-bridge.ts` | One definition, shared with `apps/web`. Nothing Electron in it. |
| Identity | `src/main/index.ts`, `package.json` | `app.setName("Evie")` + `productName`; dock icon set explicitly for unpackaged runs. |
| Build | `scripts/build.mjs`, `scripts/icons.mjs` | esbuild x3, plus the mark drawn to PNG/`.icns` from its design-system geometry. |
| Bundle | `scripts/package.mjs` | `out/Evie.app`: renamed executable and helpers, patched `Info.plist`, `evie://` on the bundle, ad-hoc signature. |

### Decisions that changed once it was real

1. **Electron hosts the server with its own binary.** Electron 40 embeds Node
   24 *with `node:sqlite`*, which is the server's one hard runtime requirement.
   `ELECTRON_RUN_AS_NODE=1` on `process.execPath` means the packaged app needs
   no system Node and ships no second runtime. The spec had assumed a bundled
   Node binary; this is strictly better.
2. **The server bundle is fully self-contained.** Bun installs each workspace in
   isolation, so `apps/server`'s dependencies do not resolve from
   `apps/desktop/out/`. Externals were not an option; the 5.9 MB bundle is.
3. **A launcher endpoint replaced "reopen means restart".** `POST
   /internal/launcher/claim` (loopback-only, bearer `EVIE_LAUNCHER_TOKEN`, local
   mode only, mounted only when all three hold) mints a fresh session on demand.
   Without it, a window that outlived its cookie could only be recovered by
   killing the server and every agent under it.
4. **The icon is drawn from the design, not exported from it.**
   `scripts/icons.mjs` reproduces the mark's geometry from
   `packages/ui/src/components/bot-mark.tsx` — the 34-unit box, the circle, the
   two slots at 11.6 and 18.8 — and rasterises it at every size macOS asks for,
   including a real `.icns` via `iconutil`. Nine numbers in a script review in a
   way a committed binary does not, and @1x and @2x cannot drift apart. The two
   static colours are the ones `apps/landing/app/icon.svg` already commits to,
   because an app icon cannot follow the theme the way `BotMark`'s tokens do.
   Writing it surfaced that the old placeholder tray icon drew a squircle with
   *one* slot — the mark has two, and they are the whole motif.
5. **The server watches its launcher.** `EVIE_PARENT_PID` +
   `apps/server/src/parent-watchdog.ts`. Signal handlers cover a kill; nothing
   covers SIGKILL, and an orphaned server holding the port is how the *next*
   launch fails. It watches for reparenting, not for pid liveness, because pids
   are recycled.

### Bugs this work found and fixed

- **The traffic lights never worked, on any screen.** Three of four render sites
  passed no handlers at all; the fourth passed the contextBridge functions
  *directly* to `onClick`, so React called them with a SyntheticEvent, which
  cannot be structured-cloned across the isolation boundary — it threw at the
  boundary and the button did nothing.
- **And then drawn controls turned out to be the wrong answer entirely.** Even
  wired up they felt inert, because everything that makes these buttons read as
  macOS is behaviour the system owns: dimming when the window is not frontmost,
  revealing ⨯ − + on hover over the group, green meaning full-screen (and
  Option-green meaning fit), and repainting for Reduce Transparency and
  Differentiate Without Color. The shell now shows the **native** buttons and
  the renderer measures where the design puts them and moves them there
  (`window-controls.tsx` → `setButtonPosition` → `setWindowButtonPosition`).
  The drawn component survives for the gallery, which has no window to borrow.
- **`App` never passed `desktop` to `LaunchScreen`**, so the connecting and
  expired screens had no window controls whatsoever.
- **Screens without a rail could not be dragged.** With the titlebar hidden,
  nothing owned the top of the window on the launch and onboarding screens.
- **`fleet.subscribe` sent no initial snapshot.** The hub is pub/sub with no
  database behind it, so a client joining a quiet org received nothing, and the
  client could not tell "no bots" from "not told yet". It now backfills, exactly
  as `subscribeThread` already did.

### Naming, and why it forced a bundle

`app.setName("Evie")` runs before `whenReady`, which is what it takes to get the
notification sender, the About panel, and `app.getPath("userData")` right —
that last one is created the first time anything asks for it, so renaming later
would strand Electron's state under a folder called `Electron`.

It is also not enough. Everything a macOS app *calls itself* in the places a
user looks — the dock name and tooltip, the menu bar title, the Finder icon, the
name in a permission prompt — AppKit reads from the running bundle's
`Info.plist`. No runtime API reaches any of it. Running from a checkout is
therefore always "Electron", and the fix is not a call, it is being a bundle.

So `scripts/package.mjs` builds one: Electron's own `.app` copied, executable
and all four helpers renamed, `Info.plist` patched with the name, identifier
(`ai.tryevie.desktop`), icon, and `evie://` scheme, then re-signed ad-hoc
because every rename invalidates the original signature and Apple Silicon
refuses to launch a bundle whose signature no longer matches. macOS then
registers it as **Evie**, which is verifiable rather than asserted:
`lsappinfo` reports `"Evie" … bundleID="ai.tryevie.desktop"`.

It is deliberately not `electron-builder`. It does the one thing that makes the
app *itself* and stops short of DMGs, signing identities, notarisation, and
update feeds — a distribution problem rather than an identity one. A real
packager replaces this file; until then it is what makes `Evie.app` something
you can double-click.

**`bun run dev` builds and launches that bundle** rather than invoking Electron
directly, because the bundle is not a packaging nicety — it is the only way the
app can be called by its own name anywhere a user looks. It costs about a
second: APFS clones the 272 MB of Electron rather than copying it. Verified
rather than asserted — with the bundle frontmost, `System Events` reports both
the process name and the first menu bar item as **Evie**.

Two consequences about Evie home, one of which is a trap that change opens:

- A packaged build resolves home to `~/.evie`, correct for a shipped app and
  dangerous for testing one. `evieHome()` lets an inherited `EVIE_HOME` win in
  both modes, so the bundle can be exercised against a scratch directory.
  Without it, the only way to try the shipped artifact is to point it at the
  developer's live database — rule 2 broken by someone following instructions.
- `app.isPackaged` is also true for the bundle sitting in `out/`, so making it
  the dev path would have pointed every `bun run dev` at `~/.evie`.
  `scripts/package.mjs` therefore stamps the workspace's own `.evie` into the
  app manifest and `paths.ts` prefers it: a bundle built in a checkout cannot
  open the live install even when double-clicked with no environment set. A
  release pipeline omits the stamp and `~/.evie` applies as it should.

### Still out of scope

A real signing identity and notarisation, Windows and Linux, auto-update, and
the keychain swap for `Secrets`. `bun run package` produces an app that runs on
the machine that built it; Gatekeeper stops it anywhere else, which is the line
between "an app" and "a distributable".


## Complete subsystems connected to nothing

The recurring shape in this repo. Each of these is real, careful code that no
caller reaches:

| Thing | Reality |
| --- | --- |
| `Notifier` | **Transport built.** `Notifier.layerStdout`, selected by `EVIE_NOTIFY_STDOUT`, writes one line per notification for the desktop shell to deliver natively. A headless boot still gets `layerNoop`. |
| `ClientPresence` | `layerNone`: `isAttached` always false, so a runtime idle-stops after 10 minutes even with a client watching. `presence.set` writes an open-thread set that nothing reads. |
| Plugins catalogue | `plugins.catalog` returns `listings: []` **on the server** and the app passes `listings={[]}` anyway. `ConnectService` writes a DB row and **never writes `agent/connections/<name>.ts`**, so a "connected" service has no effect on the agent. |
| Blobs | `blob`/`blob_ref` tables, `blobs.grant`, and `GET /blob/:id` with the org check are all built — and **nothing ever inserts a blob**. There is no upload path, so no grant can succeed. Tool truncation sets `truncated: true` with no `blobId`, so a truncated payload can never be expanded. `SendMessage.attachments` are dropped at dispatch anyway. |
| `SetInstructions` | The event now carries the text, so the information survives — but still no reactor consumes it and the scaffold never rewrites `instructions.md`. Half fixed. |
| Routines | Backend is complete and careful — tz-aware cron, `next_run_at` recomputed from `(cron, tz)` at boot, blocked-once semantics, run-as-left backstop. Zero UI. |
| Member-scoped connections | Schema, commands, grant secrets, and `principalType: "user"` JWTs all built. Grant tokens are never injected into a runtime. |
| `computer.list` | ~~No client caller.~~ **Wired.** The Computer pane's Files tab lists the bot's directory and opens a folder on click, through a `FileTree` slice in the store. Still reads the **host filesystem** under the bot's project dir, which is fine in dev mode and wrong the day a real sandbox lands. |
| `loadMore` / `closeThread` / `presence.closed` | Implemented, tested at the store level, zero callers. A thread longer than the first 60 items silently shows only its tail. |
| `SignInScreen`, `ContextMeter`, `button.tsx` | Finished components rendered only by the gallery, or by nothing. The Better Auth browser client is constructed in `runtime.ts` and never called. |
| `Actor` in `contracts/rpc.ts` | Dead duplicate; the server defines its own in `domain/state.ts`. |
| `connection_grant`, `device` tables | Zero readers or writers anywhere. |

## Outright bugs

Distinct from "not built yet" — these are wrong, not absent:

| Bug | Where |
| --- | --- |
| **`@evie/contracts` exports `./eve` pointing at a file that does not exist.** Any import of it fails to resolve. | `packages/contracts/package.json` |
| ~~**The bot's chosen face is discarded.**~~ **Fixed.** `BotCreated` now carries `avatar` and `reasoning`, the decider passes them through, and the projection stores them. | `contracts/events.ts`, `decide.ts`, `project.ts` |
| **"Always for this session" approvals never reach eve.** `AnswerInput.scope` survives into the event and is then dropped when building the response. | `bridges.ts:110-125` |
| **`reconnecting` is never emitted.** The status exists, the rail renders it, and no server code produces it — so the specified "UI shows *reconnecting*, not an error" does not happen. | `contracts/thread.ts` vs server |
| **`CredentialProblem` is never constructed.** Defined and round-trip-tested; no code path raises it, so the specified "typed error and a *Fix in Settings* action" cannot occur. | `contracts/errors.ts` |
| **Connect-apps selections are discarded.** The onboarding picks are held in the URL now, but still no `ConnectService` is ever sent. | `app.tsx` |
| ~~**`vite.config.ts` contradicts `README.md`** about the Vite WS proxy.~~ **Both were wrong, and so was this line.** The proxy works: an upgrade to `http://localhost:3000/rpc` answers `101`. The original measurement used `127.0.0.1` while the dev server binds `[::1]`, so it was refused before Vite saw it. `turbo dev` gives a real session — on `localhost`. | `apps/web/vite.config.ts` |
| **`docs/user/getting-started.md` still has gaps** — Settings → Models, device pairing, and remote access do not exist. The desktop app now does. | `docs/user/` |

## The quality gate is thinner than it looks

`20/20 tasks, 129 tests` still overstates the case, though two of the worst
entries have been closed:

- ~~**Lint cannot fail.**~~ **Fixed**, by deleting `eslint-plugin-only-warn`
  rather than working around it. The plugin downgraded every rule to a warning,
  which deleted severity as a concept: a genuine `no-undef` and an advisory
  `turbo/no-undeclared-env-vars` came out identical and `eslint` exited 0 for
  both. Now errors fail locally (you find out before CI does), advisory rules
  stay advisory, and `bun run lint:ci` adds `--max-warnings 0` so an advisory
  rule cannot quietly rot. It immediately caught real defects in work in flight,
  which is the whole argument for it.
- ~~**There is no CI.**~~ **Fixed.** `.github/workflows/ci.yml` runs
  check-types, lint (strict), and test across the workspace on Node 24 with bun
  pinned from `packageManager`. This is the one place a repo-wide run is
  correct. Each check is guarded with `if: !cancelled()` so one red check still
  reports the other two rather than costing a round-trip per fix.
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
  tabs-with-semicolons by some other formatter. No format check runs anywhere,
  and CI deliberately does not add one — turning it on today would fail on
  mostly-untouched files, which is a formatting migration rather than a gate.
- **One residual hole in the BYOK tests, named rather than papered over.** Scope
  precedence is now decided by an exported pure function with its own
  assertions, but nothing proves the *call site* still uses it: delete the call
  and the ordering tests stay green. Closing that properly needs a database-
  backed test of `storedSecrets`, which is real harness work.

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

## Measured against t3code

[t3code](https://github.com/pingdotgg/t3code) is the closest thing Evie has to a
control group. `specs/README.md` already names it as the source of vocabulary
`AGENTS.md` had to be cleaned of; what that note understates is how much of the
*design* is shared. t3code is `apps/{server,web,desktop,mobile,marketing}` and
`packages/{contracts,client-runtime,shared}`, an event-sourced orchestration
engine, and one authenticated Effect RPC WebSocket. So is Evie.

That makes the comparison unusually sharp and unusually fair. Almost nothing
below is "t3code made a different bet." It is the same bet, several years
further along, which means the gaps are a schedule rather than an argument.

**How this was produced**, because a comparison is only worth what its method
is: six analyses, one per dimension (providers, remote, mobile, desktop,
workspace, distribution), each reading both trees. Every claim then went to an
independent verifier told to check the *Evie* side hardest and to default to
rejection. Of 36 claims, 34 completed verification: 27 confirmed, 7 softened,
**none survived as flatly wrong** — which says the analysts were careful, not
that the verifiers were lenient. Two claims this document does *not* make were
killed before they got here: that Evie lacks per-method authorization (it runs
`auth.hasPermission` per command, `gateway/middleware.ts:186`) and that its
provider boundary is unusable (`EveAdapterShape` is genuinely provider-neutral
in its signatures).

One caveat on provenance, since it affects what can be re-checked: the analyses
read a real t3code checkout, but it was a scratch clone that no longer exists.
Every **Evie** citation below was verified against this tree and can be checked
now; the t3code paths are comparative colour and would need a fresh clone to
confirm. That asymmetry is the right way round — each item is a claim about
what Evie lacks, and that half is the half that was audited.

### The worst category: surfaces that lie

Not missing features — shipped affordances that report success and do nothing.
`AGENTS.md` names this exact class ("a lying spinner, and a stale label") as
what Evie's users notice. Every one of these is live today:

| The lie | Where |
| --- | --- |
| The Terminal tab says "Nothing has run in this sandbox yet." forever. There are no PTY sessions at all; `<TerminalView lines={[]} />` is a literal. | `apps/web/src/screens/chat.tsx:111` |
| ~~**"Always allow for this session"** is contract-only: dropped by the server, never offered by the UI.~~ **Fixed**, and it could not be fixed the obvious way — see below. | `reactors/turn.ts`, `ui/components/approval-card.tsx` |
| ~~The timeline renders "restored" while the filesystem is untouched.~~ **Fixed.** Restore is implemented, and the row now follows a new `CheckpointRestored` event rather than the mere request. | `reactors/checkpoint.ts` |
| ~~The tray's only failure affordance says "see Console". Nothing is ever written to a log file.~~ **Fixed.** A rotating `desktop.log` under Evie home carries both the shell and the server child, and the tray reveals it in Finder. | `main/log.ts` |
| ~~`npx evie` is instructed by the marketing site and by `AGENTS.md`, and no package has a `bin`.~~ **Half fixed.** `apps/server` now has a CLI (`--port`, `--help`) that bundles to a self-contained `dist/evie.mjs` and serves the built web client; it boots and prints a claim URL. Publishing is the remaining half. | `apps/server/src/cli.ts` |
| ~~The Computer pane's file tree renders nothing, though `computer.list` is implemented and path-safe on the server.~~ **Fixed.** Files lists the bot's directory and folders open on click; Terminal and Browser are still the empty tabs below. | `client-runtime/src/files.ts`, `web/src/components/file-tree.tsx` |

A control that reports success and does nothing is worse than an absent one,
because the user learns to distrust the ones that work. These are cheap
relative to everything else here and should go first.

**What fixing the first one turned up, because it constrains the others.**
eve's `inputResponseSchema` is `z.core.$strict` over exactly `{ requestId,
optionId, text }`. There is no scope field, and a strict schema *rejects* an
unknown key rather than ignoring it — so "always allow for this session" can
never be forwarded to the provider. eve's approval policies (`never()`,
`once()`, `always()` from `eve/tools/approval`) are per-connection and live in
the bot's own code; they are not per-answer.

So the grant is Evie's to keep, which on reflection is where it belongs: Evie
owns the approval surface, and a grant the user can see is a grant the user can
revoke. It is now an `input_grant` table keyed `(session_id, tool_name)`, written
when an answer carries `always`, and applied by the turn reactor, which emits an
ordinary `InputAnswered` scoped `once` rather than calling the adapter directly —
so a granted approval travels the same path every other answer takes and the
timeline stays consistent. The card names the tool it is granting, because
"always allow" over an unnamed action is not a decision anyone can make.

The general lesson for the rest of this list: **check what eve's contract can
actually carry before designing a feature that assumes it.** `packages/contracts`
is Evie's wire, not eve's, and the two are not the same shape.

### Gaps that block Evie's own stated pillars

Ranked by which `AGENTS.md` pillar they falsify, because that is the only
ranking that matters — t3code having something Evie does not is uninteresting
unless Evie has already promised it.

**Pillar 3, "Remote ready", is the largest hole.** It is not one gap but a
chain, and every link is missing:

- **No pairing credential.** The `device` table has been there since the first
  migration (`db/migrations.ts:214-223`) and has zero readers or writers. A
  second device has no way to obtain access, and `specs/05:198` already
  requires that pairing have an unpairing.
- **No environment identity.** No keypair, no stable environment id. Three of
  the five relay requirements `specs/05:400-425` sets for itself are
  unsatisfiable without one. This is *days* of work now and a migration after
  devices exist.
- **The socket has no cross-origin credential.** Cookie-or-header only, so a
  tryevie.ai tab can authenticate its `fetch` calls and then fail on `/rpc`,
  where every frame lives — a browser cannot set a header on a WebSocket, and a
  cross-site cookie to a private IP is blocked. Evie already has the right
  pattern and has not applied it here: `grantBlobUrl` mints a short-lived
  signed token in the query string precisely so a fetch with no cookie still
  works (`gateway/http.ts:26-52`). The cheapest gap on this list, and it gates
  the most-repeated product claim.
- **The client can address exactly one server, fixed at build time**
  (`web/src/lib/runtime.ts:27-33`). Every other remote gap terminates here: a
  pairing code has nowhere to be stored and a relay has nothing to route to.
- **Refusal 1 is unimplemented**, so a non-loopback bind leaves open
  self-registration as the only way in — the precise scenario `specs/05:186`
  describes as "a stranger on cafe wifi driving an agent with shell access to
  your home directory." It is reachable today by hand-editing `bind` in
  `settings.json`, and it has a second edge: `layer.ts:128-137` skips
  `ensureLocalOwner` for any non-local mode, so a fresh `lan` boot has *no*
  principal until the first stranger signs up and becomes owner of a new
  one-member org — at which point refusal 3, which only fires above one member
  (`decide.ts:191`), does not stop them selecting `just-bash` either.
- **Tailscale is named in `AGENTS.md` and implemented nowhere.** `specs/05:393`
  claims it needs "no configuration beyond binding"; the code contradicts that,
  because binding is what produces a wrong derived URL and a wrong secure-cookie
  setting. t3code's version is small: `tailscale status --json` for the MagicDNS
  name, `tailscale serve` for TLS, then derive the base URL from the served
  endpoint rather than from the bind string.

**Pillar 4, "Multi-surface".** No installer, no signing, no notarisation — and
now that `Evie.app` exists, this is the only thing between it and a stranger's
machine. No `npx evie`. No auto-update, which `specs/04:222-226` makes
load-bearing for a *correctness* property rather than convenience: "a client is
never newer than its server" is enforced by a typed refusal whose only
resolution is that the user updates. And nothing carries a version — every
workspace package is `0.0.0` — so that refusal is currently terminal.

**Pillar 1, "Open at the core".** There is no CI at all, while `AGENTS.md`
explicitly delegates the full suite to it. A project that expects forks has no
automated gate that can tell a contributor their change is green.

**Pillar 2, "Performance without compromise".** The budget is a table, not a
check, and on the surface most users install first there is no instrument to run
the promised audit with.

### Genuinely unconsidered

The valuable half of this exercise. Everything above is scheduled somewhere in
`specs/06`; the following appear in no spec, and two of them are latent
correctness bugs rather than missing work.

1. **Threads on one bot share one directory.** Per-bot working tree, per-thread
   checkpoint ref. The moment two threads talk to the same bot — which
   Phase 2 in `specs/06` makes scope — each `git add -A` sweeps the other's
   in-flight edits into its own checkpoint, so one thread's diff shows another's
   files and restoring one silently discards the other's work. Evie need not
   adopt worktrees, but it needs *an* answer and currently has none.
2. **Ingestion is dispatch-triggered.** `adapter.attach` has exactly one call
   site, inside `dispatchTurn`. eve sessions are durable and keep running across
   an Evie restart, so a restart mid-turn leaves the thread frozen in the UI
   until someone sends another message — while `specs/01:29` sells the opposite
   ("any client attaches at `startIndex` and takes over"). The resume cursor is
   already persisted; only the trigger is missing.
3. **The provider-neutral vocabulary does not exist.** `specs/02:53` and
   `EveAdapter.ts:43` both claim "a second provider is a second adapter, not a
   refactor". The adapter's *interface* is genuinely neutral, but `EveMirrored`
   stores eve's payload verbatim and the projector switches on eve's shapes, so
   the read model, the timeline contract, and the event log all speak eve.
   Decision 001 makes this cost nothing today; it is recorded because the spec
   currently claims a property the code does not have.
4. **No model catalog.** `ModelRef` is an unvalidated string. Decision 007 calls
   the picker "the point of BYOK", and there is nothing to render in it, no way
   to catch a typo before the turn fails, and nowhere to hang per-model
   reasoning controls.
5. **The `Notifier` port cannot address a device.** `deliver(notification) =>
   Effect<boolean>`, keyed on a `userId`, cannot express fan-out to N registered
   endpoints, per-endpoint failure, or pruning a dead APNs/FCM token. The
   reactor's decisions are already right — snooze-aware, replay-silent — and the
   port shape underneath them is the thing that has to change before any push
   transport or mobile client is buildable. A contracts decision, not an app
   one, which is why it belongs here rather than in a mobile phase.
6. **Presence is socket-lifetime and shape-blind.** No lease TTL, no app state,
   no client kind. iOS suspends a WebSocket within seconds of backgrounding, so
   every lock/unlock would read as "client gone / client back" and thrash
   runtime start-stop — the exact regression class pillar 2 exists to prevent.
   A contract change, so cheaper before a mobile client than after.
7. **Attachments have a download half and no upload half.** `SendMessage`
   presumes a `BlobId` that already exists, and nothing can create one. The
   frame budget (`specs/03:108`) says bytes never cross the RPC socket, which
   points at an upload route — specified nowhere.
8. **No file-change summary per turn.** The checkpoint reactor holds two shas
   and stops. "3 files changed, +42 −7" is the glanceable answer to "what did
   this bot do while I was away", it is the prerequisite for any diff UI, and
   `git diff --numstat` is already reachable from the reactor's own `git()`
   helper. Highest value per line in this document.
9. **Operational blind spots on the desktop app**: no log file, window geometry
   discarded every launch, no renderer-crash recovery (a tray-resident app is
   precisely where an OOM'd renderer sits blank in front of a healthy server),
   and `safeStorage` untouched, so every platform gets the Linux 0600 fallback
   while `specs/04:220` states keychain behaviour as shipped fact.

### Where Evie is ahead, and where it is deliberately smaller

Recorded so the list above is not mistaken for a verdict.

Evie's local-login credential is strictly tighter — single-use, 60 seconds,
in-memory. Its contract-version handshake is a hard typed refusal where
t3code's is a warning banner. Its reactors are durable subscriptions with a
persisted cursor advanced in the same transaction as the write, which makes
"work continues" survive a crash; t3code's checkpoint equivalent is not durable
in that way. Its stream cursor is absolute and durable rather than an opaque
resume blob. Turns carry the acting member's identity into the provider as a
short-lived JWT. Runtimes are reference-counted leases rather than a periodic
reaper. And the desktop shell's orphan prevention — watching for *reparenting*
rather than polling a pid — is the better mechanism.

Two divergences are deliberate and should not be read as debt. t3code drives
five agent harnesses; decision 001 pins Evie to one, and the price is only ever
paid on the day a second is wanted. t3code carries an entire source-control
product — pull requests, review, VCS — alongside its checkpoints; Evie's scope
discipline there is the right call, and item 7 above is the small piece worth
taking from it.

## What to build next, in order

Reordered again after a pass of implementation. Items 2 and 4 of the previous
list are done, and the BYOK gap has narrowed to one screen.

1. **Commit what exists.** A working tree this size with no history is the
   single biggest risk in the repo, and it has only grown.
2. **A settings screen that calls `setSecret`.** The entire remaining distance
   between Evie and a bot that answers. The server half landed: a stored key now
   reaches the runtime, bot scope beats org, and stored beats the operator's
   shell. There is nowhere to type one.
3. **The adapter's recorded-stream fixture.** 868 lines nobody has run, and the
   riskiest invariants in the repo live in them -- exactly-once mirroring and
   scope discipline both fail silently.
4. **The model picker**, which needs a catalog behind it. Decision 007 is still
   violated by the client and `ModelRef` is still an unvalidated string.
5. **The two latent correctness bugs**, before the features that trip over them
   ship: per-thread workspace isolation, and reattach-on-boot.
6. **A reactor for `SecretSet` / `SecretRemoved`.** Rotation is specified to
   restart affected runtimes; nothing listens, so a rotated key does not apply
   until the runtime idle-stops. The hook is one call to `RuntimeControl.stop`.
7. **The rest of the outright bugs table.**
8. **Refusals 1 and 2**, before anyone is invited to anything -- and with them
   the environment keypair, which is days of work now and a migration later.
9. **Distribution.** A signing identity, notarisation, and publishing the CLI.
   `npx evie` builds and runs today; nothing puts it on a registry.
10. **Then remote, as a chain rather than a feature**: environment identity →
    device pairing and revocation → a socket credential that survives
    cross-origin → an environment catalog on the client. Nothing in the middle
    of that list works without the ones before it.

Struck since this was first written: the cold-load bug, `apps/desktop`, the
app's identity as a real bundle, CI, a lint that can fail, the desktop log,
the file tree, checkpoint restore and the per-turn file summary, session
approval grants, and key injection into the runtime.
