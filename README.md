# Evie

A minimal, open, bring-your-own-key GUI for [eve](https://eve.dev) agents.

Evie is what a self-hosted client is to a $300/month subscription: persistent named agents, each with
their own sandboxed computer, running on hardware you control, against your keys, with the source in
your hands.

The design was specified before it was built. Start at [`specs/README.md`](./specs/README.md); what
exists today is described in [`docs/`](./docs/README.md).

## Status

Phase 0 → 1. The workspace, the wire contract, the design system, and the client are in place; the
server's control plane is landing behind them. See [`specs/06-roadmap.md`](./specs/06-roadmap.md) for
what ships when.

## What's here

| Package                   | What it is                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `@evie/server`            | The environment. RPC-over-WebSocket gateway, event-sourced control plane, eve supervisor.      |
| `@evie/web`               | The UI. React 19 + Vite 8.                                                                     |
| `@evie/contracts`         | Everything that crosses the wire, as Effect Schema. Change it and both sides follow or fail.   |
| `@evie/client-runtime`    | RPC client, external store, timeline projection. No framework coupling.                        |
| `@evie/shared`            | Runtime utils. Subpath exports, no barrel.                                                     |
| `@evie/ui`                | Design system. shadcn `base-nova` on `@base-ui/react`, Tailwind 4, Geist.                      |
| `@evie/eslint-config`     | Shared ESLint config (`./base`, `./react-internal`).                                           |
| `@evie/typescript-config` | Shared `tsconfig.json` bases.                                                                  |
| `.repos/`                 | Vendored read-only library source (Effect, Alchemy) for agents to read instead of guess.       |

Every `@evie/*` package is **just-in-time**: it exports raw source and emits nothing, so the
consuming app's bundler compiles it and the dev loop has no build step. An app that imports one must
exclude it from Vite's pre-bundling and point Tailwind at its source — both already done in
`apps/web`, and worth copying rather than rediscovering.

## Requirements

- Node 24 or newer. The server uses `node:sqlite`, so there is no native module to rebuild and
  Electron needs no rebuild step.
- Bun 1.3.12 as the package manager.

## Running it

The desktop app is the shortest path to a running Evie. It builds the web
client, bundles the server, and hosts it with Electron's own Node — nothing else
to install, and it keeps its data in this repository's `.evie`, never `~/.evie`:

```sh
bun i
cd apps/desktop && bun run app
```

That builds `out/Evie.app` and launches it. It is a real bundle rather than a
bare `electron .` because every place macOS shows an app's name — the dock, the
menu bar, the app switcher — reads it from the bundle, and nothing a running
process does can change that. Built from a checkout it keeps its data in this
repository's `.evie`, never `~/.evie`, and refuses to do otherwise.

It is tray-resident: closing the window leaves the server running, and **Quit
Evie** in the menu bar is what stops it. macOS only, unsigned, no installer yet.

`turbo dev` opens it too, and does not start a second server. Two servers on one
`EVIE_HOME` fight over the same bot runtimes and the loser gets 401 on every
turn, so under `turbo dev` the app **adopts** the server already serving the
home — it finds it through `userdata/evie.lock`, which carries the URL and a
launcher token — and points its window at the Vite dev server on
`localhost:3000`, so you get hot reload in the real shell. Quitting then leaves
that server alone; it belongs to whoever started it.

`bun run app` is the standalone launcher, which starts its own server. Either
way, a genuinely second server now refuses to start and names the one already
holding the home.

To run the server and a browser instead — the server serves the client:

```sh
bun i
turbo run build --filter=@evie/web            # once, and after UI changes

cd apps/server
EVIE_HOME=../../.evie \
EVIE_WEB_DIST=../web/dist \
EVIE_PORT=3001 \
bunx tsx src/main.ts
```

The last line prints the URL to open, with a **one-time sign-in token** in it:

```
Evie is ready: http://127.0.0.1:3001/?claim=…
```

Open that exact URL. The token is single-use and expires in 60 seconds, so a
reload or a second tab lands on "That sign-in link was already used" — restart
the server for a fresh one. That is deliberate: every process on the machine can
reach loopback, and behind that cookie is an agent with a shell in your home
directory.

### Working on the UI

`turbo dev` gives Vite with HMR on port 3000, alongside the server on 3001 and
the desktop app. **Open `http://localhost:3000`, not `127.0.0.1:3000`** — the
dev server binds `[::1]`, and the RPC upgrade proxies correctly through the
hostname and not through the IPv4 literal. This was recorded here as "Vite 8's
WebSocket proxy does not forward the RPC upgrade" for a while; that was a
measurement taken against the wrong address, and it is not true.

For UI work with no server at all, the screen gallery is at
`http://localhost:3000/gallery.html`, which renders every screen from fixtures.
That gallery is how a change gets checked against the Paper file; see
[`docs/internals/design-system.md`](./docs/internals/design-system.md).

## Working in this repo

```sh
bun i                                        # install the whole workspace, from the root
turbo dev                                    # every persistent dev task
turbo dev --filter=@evie/web                 # just one
turbo run lint check-types --filter=@evie/ui # smallest proof a change is sound
```

Always pass a `--filter`. Repo-wide checks belong to CI.

The dev server writes to a worktree-local `.evie/`, never to `~/.evie` — that is the developer's real
database and it is open while you work. Seeding it with real data is covered in
[`AGENTS.md`](./AGENTS.md#test-data).

Contributor conventions, and the two ways to hurt yourself, are in [`AGENTS.md`](./AGENTS.md).

## The shape of it

```
client  ──RPC over WebSocket (MsgPack)──▶  Evie server  ──loopback──▶  eve runtime  ──▶  sandbox
                                               │
                            commands ▶ decider ▶ events ▶ projector ▶ read model
                                               └────────▶ reactors ▶ receipts
```

The Evie server is the only network-exposed surface. An eve runtime binds loopback on an ephemeral
port and is never reachable from an interface. That buys one auth boundary, one TLS story, one thing
to tunnel — and one place to coalesce every byte before it hits a socket, which is most of why the
UI stays quick with a thread streaming.
