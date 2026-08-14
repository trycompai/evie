# 04 — Clients

## Surfaces

| Surface        | Package                | Notes                                                                                          |
| -------------- | ---------------------- | ---------------------------------------------------------------------------------------------- |
| Web            | `apps/web`             | React 19 + Vite 8 (Rolldown) + `@evie/ui`. Served by the Evie server, or by tryevie.ai.        |
| Desktop        | `apps/desktop`         | Electron. Loads `apps/web`'s build, bundles `apps/server`, adds tray, native notifications, deep links. |
| Shared logic   | `packages/client-runtime` | RPC client, store, projections, command helpers. Zero DOM. Keeps React Native additive.      |
| Design system  | `packages/ui`          | shadcn `base-nova` on `@base-ui/react`, Tailwind 4, Geist. Exists today.                        |

The desktop app **wraps** web. Anything reachable in one is reachable in the other, or it is a bug.
When a feature lands, walk the entry points: chat view, command palette, Settings, keybinding. That
is the most common defect class in this codebase's lineage.

## `packages/client-runtime`

One store, one socket, no framework coupling.

```
packages/client-runtime/src/
  client.ts       RpcClient over WebSocket, session.hello handshake, reconnect with backoff,
                  resume by cursor
  store.ts        external store: fleet + per-thread timelines; subscribe/getSnapshot at both
                  thread and item granularity
  timeline.ts     applies TimelineFrame deltas; owns the seq -> item index
  commands.ts     typed command senders returning receipts
  presence.ts     which threads are open, which reasoning blocks expanded (drives subscriptions)
```

The store is consumed with `useSyncExternalStore`. This is not a stylistic choice:

- It is the correct primitive for an external, mutable, server-owned data source.
- It gives React one commit per batch rather than one per delta.
- It makes the `no-useEffect` rule easy to honour. There is no effect that "syncs" server state into
  component state, because component state never holds server state.

**Subscribe per row, not per thread.** The store exposes `subscribeItem(threadId, itemId)` and
`getItemSnapshot(threadId, itemId)` alongside the thread-level pair, and `TimelineRow` subscribes to
its own item. This is the difference between meeting the perf budget below and missing it: a single
thread-level subscription re-renders the list container on every 50 ms frame, so a 2,000-row thread
runs 2,000 memo comparisons twenty times a second just to discover that one row changed. With
row-level subscriptions the streaming row is the only component React re-renders, and the list
container commits only when the *set* of visible ids changes.

Two consequences to respect in `store.ts`:

- `getItemSnapshot` must be referentially stable — return the cached item object and replace it only
  when that item actually changes. A snapshot getter that builds a fresh object per call makes
  `useSyncExternalStore` loop forever, and it is the single easiest way to get this wrong.
- Deltas mutate by replacing one item in the index. Rows above and below keep their identity and
  never re-render, which is what makes the "deltas, never re-renders of history" claim true rather
  than aspirational.

`useEffect` appears in exactly one place in the client: the `useMountEffect` escape hatch for
imperative DOM work that has no declarative equivalent (focus management, `ResizeObserver`
attachment). Data fetching, subscription lifecycle, and derived values do not use it. Derived values
are computed during render or memoized; subscription lifecycle belongs to the store.

## Why not `useEveAgent`

eve ships `useEveAgent()` from `eve/react`, which opens a session, streams, and projects messages —
and it is the right tool for a single-agent chat page. Evie does not use it, because Evie's client
never talks to an eve runtime. Everything it does happens server-side in `EveAdapter`, where it can
be coalesced, mirrored to SQLite, fanned out to several clients, and merged across several bots in
one thread. `useEveAgent`'s reducer contract is still worth reading as the reference projection; our
`timeline.ts` is a superset of it.

## The chat view

The shape is Bot's: a sidebar of bots, not a list of chats.

```
┌────────────┬──────────────────────────────────────────────┬──────────────┐
│  BOTS      │  THREAD                                      │  COMPUTER    │
│            │                                              │              │
│ ● Inbox    │  ┌ user ────────────────────────────────┐    │ ▸ Files      │
│ ● Research │  │ @Research find the Q3 numbers        │    │ ▸ Terminal   │
│ ○ Ops      │  └──────────────────────────────────────┘    │ ▸ Browser    │
│ ○ Deploy   │  ┌ Research ────────────────────────────┐    │              │
│            │  │ ▸ bash  ls /workspace/data      0.4s │    │ /workspace   │
│ + New bot  │  │ Found three exports. The Q3 …        │    │  data/       │
│            │  └──────────────────────────────────────┘    │  notes.md    │
│ ─────────  │  ┌ approval ────────────────────────────┐    │              │
│  THREADS   │  │ Send the summary to #finance?        │    │ policy:      │
│  Today     │  │ [Approve] [Always] [Deny]            │    │  deny-all +3 │
│  Snoozed   │  └──────────────────────────────────────┘    │              │
│            │  ╭ composer ─────────────────────────╮       │              │
│            │  │ @  message…            ⏎  ⌘⏎ stop │       │              │
└────────────┴──╰───────────────────────────────────╯───────┴──────────────┘
```

- **Left rail is bots.** Threads are secondary and grouped by recency, with Snoozed and Archived as
  reachable states — never dead ends. An org switcher sits at the top of the rail and is hidden
  entirely when you belong to one organization, which is the common case and should not cost a
  control.
- **Messages are attributed to people, not just to bots.** In a shared thread a user row carries the
  member's name and avatar. In a one-member org that attribution renders as nothing, so the single
  user never pays for the team feature.
- **Sign-in cards are addressed.** An `authorization.required` card raised for Ana renders as an
  action for Ana and as a quiet "waiting for Ana to connect GitHub" row for everyone else. Showing
  a live sign-in button to the wrong person is a bug, not a convenience.
- **The right rail is the bot's computer.** Files, terminal, browser. This is the affordance that
  makes "your bot has its own machine" legible rather than a claim in marketing copy.
- **Approvals live in the flow**, not in a modal. A modal steals focus while a turn is still
  streaming; an inline card lets you keep reading.
- **`@` in the composer** adds a participant to the thread and addresses them.

### Status honesty

`AGENTS.md`: "our users notice a dropped frame, a lying spinner, and a stale label."

| eve state                        | What the UI says     |
| -------------------------------- | -------------------- |
| `turn.started` → first token     | Thinking             |
| streaming text                   | (no chip; text moves)|
| tool executing                   | Running `<tool>`     |
| `input.requested`                | **Waiting on you**   |
| `authorization.required`         | **Sign in to <svc>** |
| parked on a remote subagent      | Waiting on `<name>`  |
| `compaction.requested`           | Compacting context   |
| runtime restarting               | Reconnecting         |
| `session.waiting`                | Ready                |

Never "Thinking" while parked. That is the lying spinner.

## Performance budget

Measured on the reference machine, enforced in review:

| Budget                                                | Limit                                     |
| ----------------------------------------------------- | ----------------------------------------- |
| Thread open (2,000 items) to first paint              | < 100 ms                                  |
| React commits during streaming                        | ≤ 1 per animation frame                   |
| Sustained WS bytes for one streaming turn             | < 40 KB/s                                 |
| Idle CPU with a thread open and nothing running       | ~0%. No timers, no polling, no rAF loop.  |
| Main-thread long tasks during streaming               | none > 50 ms                              |

Techniques, and the reasoning:

- **Virtualized timeline.** Rows are variable-height; measure on mount, cache by item id, restore on
  re-entry. A 2,000-row thread mounts ~30 rows.
- **Deltas, never re-renders of history.** A text delta mutates one row's string. Rows above it are
  referentially stable and skip reconciliation.
- **No continuously repainting animation.** This is a hard rule from `AGENTS.md`: CSS animations
  that repaint every frame peg the GPU on 120 Hz displays, and Evie users leave it open all day. A
  thinking indicator uses a 1s `steps()` interval or a static glyph. No shimmer, no gradient sweep,
  no pulsing dot at 60 fps.
- **Markdown parsed incrementally and memoized per block.** A streaming reply re-parses only the
  final block, not the whole message.
- **Code blocks highlight lazily**, off the critical path, and only when in view.
- **Large tool payloads are fetched on expand**, via `blobs.grant` then `GET /blob/:id`. They are
  never in the frame and never on the socket.
- **Reasoning is opt-in per block, and only while it is live.** Expanding a reasoning row on a
  running turn subscribes to that block and the server starts including its deltas; expanding one on
  a thread you reopened next month shows the token count and says the text was not kept. That is
  decision 011 surfacing in the UI, and the row has to say so plainly rather than spinning forever
  on a fetch that can never resolve.

Any PR touching the timeline attaches a before/after profile. Motion or timing changes attach a
short video.

## `@evie/ui`

Already configured: shadcn `base-nova` style, `@base-ui/react` primitives, `baseColor: neutral`,
CSS variables, Lucide icons, Tailwind 4, Geist variable font. Add components with the shadcn CLI
into `packages/ui`, never into an app.

### It is a just-in-time package, which the consumer has to know

`@evie/ui` exports raw `.tsx` from `./components/*` and emits nothing — the consuming app's bundler
compiles it. That keeps the dev loop instant and the graph simple, but it is not free: a JIT package
only works if every consumer is told to treat it as source. Two things every app that imports it
must do, and neither is discoverable from a stack trace:

```ts
// apps/web/vite.config.ts
export default defineConfig({
  // Pre-bundling would compile @evie/ui once and then serve it stale on every edit.
  optimizeDeps: { exclude: ["@evie/ui"] },
})
```

```css
/* apps/web/src/styles.css — Tailwind 4 scans the importing project, not its dependencies. */
@import "tailwindcss";
@import "@evie/ui/globals.css";
@source "../../../packages/ui/src";
```

Without the `@source` line, every class used only inside `@evie/ui` is purged from the app's
stylesheet and the components render unstyled — which looks like a broken component rather than a
missing config line, and costs an afternoon the first time. Electron's main process never imports
`@evie/ui`; only the renderer, which is `apps/web`'s build.

The chat surface leans on shadcn's chat/prompt registry items rather than hand-rolled composer
plumbing. What is genuinely Evie-specific and belongs in `packages/ui`:

| Component            | Why it is ours                                                             |
| -------------------- | -------------------------------------------------------------------------- |
| `TimelineRow`        | virtualization-aware, stable identity, expand state                        |
| `ToolCallRow`        | collapsed/expanded, truncation + blob fetch, duration, status              |
| `ApprovalCard`       | approve / always / deny with the "always" scope made explicit              |
| `AuthorizationCard`  | url, device code, display name, completed states                           |
| `ComputerPane`       | file tree, terminal, browser tabs over one sandbox                         |
| `BotRail`            | bot list with health chips and unread state; org switcher when >1 org      |
| `MemberChip`         | name + avatar for message attribution; collapses to nothing in a solo org  |
| `ContextMeter`       | tokens used vs. window, and when compaction last ran                       |

Theming: light and dark are both first-class. Tokens live in `packages/ui/src/styles/globals.css`.
No component defines a colour only inside a media query.

## Desktop specifics

- **The server is bundled.** The desktop app is the easiest way to run an environment, and it can
  act as the host that a phone or tryevie.ai connects to.
- **Tray-resident.** Closing the window does not stop the server. A bot mid-turn keeps working —
  that is the whole "works after you close your device" promise, and on desktop we can keep it
  without a cloud.
- **Native notifications** on `turn.completed` and `input.requested` when unfocused, with deep links
  (`evie://thread/<id>`) back to the exact row.
- **Keychain** holds the secrets key on macOS and Windows; Linux falls back to `secrets.key` at 0600.
- **Auto-update** ships the server and the UI together. A client is never newer than its server:
  `session.hello` carries `CONTRACT_VERSION` and the server refuses a mismatch with a typed
  `ContractMismatch` naming both versions
  ([03](./03-contracts-and-data.md#the-handshake)). This matters most for the surfaces that update
  independently — a tryevie.ai tab is easily a version ahead of the environment it dials into.

## Docs obligations

Per `AGENTS.md`, behaviour changes split by audience:

- `docs/user/` — shipped-product voice. No repo paths, no tooling. "Your bot's computer", not
  "the sandbox backend".
- `docs/internals/` — architecture, adapters, contracts. New vocabulary goes in
  `docs/internals/glossary.md`.
- `docs/operations/` — runbooks: recovering a corrupt database, rotating the AI Gateway token,
  moving an environment to a new machine.
