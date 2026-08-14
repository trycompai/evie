# Evie

Evie is a minimal GUI for eve agents. You can think of Evie as an open source "bring-your-own-key" alternative to apps like Bot (x.ai/bot).

## What makes Evie special?

It's important we maintain the things they love as we continue to iterate on the product. Here's a brief list of the things we can never compromise on.

### 1. Open at the core

Evie is truly open. We share our roadmap, we share how we think about things, and of course we share all our code. A large number of our users run forks. We work in the open, and should strive to stay that way.

### 2. Performance without compromise

Lots of apps have gotten bogged down with bad tech decisions and "slop". We have not, and we're proud of the performance of Evie. We regularly audit for performance regressions, often caused by sending too much data over websockets, css animations causing gpu spikes, lists being hard to render, and more. Make sure all changes are considerate of performance impact.

### 3. Remote ready

The architecture of Evie needs to allow for a lot of awesome remote features. These is core to the product. Whether users are connecting directly over their local network, using Tailscale, we need to make sure new features are properly supported.

### 4. Multi-surface

Evie has 2 key app surfaces: **web** and **desktop**.

**Web** is kind of two surfaces, as we have the public facing "tryevie.ai" as well as locally hosting the web app through the `npx evie` command. Both need to be supported by all new features where reasonable.

**Desktop** is the main surface most users install first. It's a full Electron app that bundles the server runner as well. The desktop app can also be used as the host server, allowing remote connections from tryevie.

## A note from the maintainers

I like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to honor the dev's intent in both a minimal and realistic fashion.

The rest of this document is meant to help you navigate the codebase and make changes effectively. Think of these instructions less as "hard rules", more as "good defaults". The developer's preferences should be able to override anything here.

Of note: Most Evie contributions will come from Evie itself, often controlled remotely. This means you should be careful about accessing data, killing dev servers, and other things that may damage the Evie instance that the contributor is using.

## A small glossary

We need to be on the same page with terminology. When communicating, use this language:

- **you** means the agent reading this file and changing Evie.
- **we, us, and maintainers** mean the people building Evie. These are who you are talking to now.
- **user** means the person using Evie to direct agents.
- **agent** means the agent a user runs inside Evie. Depending on context, that may also include you.
- **provider** means the agent runtime or harness Evie talks to.
- **client** means the web or desktop UI.
- **environment** means one running Evie server and the machine, filesystem, provider credentials, and state it owns.
- **project** means an environment-local workspace record rooted at a directory.
- **turn** means one user-to-agent cycle, including follow-up work such as checkpointing.
- **Evie home** means the base data directory. Runtime state normally lives below its userdata directory.

## The three ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or `kill` a PID you found by matching a name, path, or worktree string. Your own agent process has this worktree's path in its argv, and this machine runs several other dev servers at once. Kill only a PID you captured at spawn, or the owner of your port from `ss -H -ltnp` after confirming `/proc/<pid>/cwd` is your worktree.
2. **Writing to the live install.** `~/.evie/userdata` is the developer's real Evie database, in use while you work. Reading it and copying from it are fine, and a good way to get real test data (see Test data). Never start a server against it, never open it read-write, never clean it up.

## Hit every surface

The most common defect in this repo is a change that works on the path you tested and is missing everywhere else. Before calling frontend work done, walk this list and say which entries applied:

- **Entry points.** A behavior reachable from the chat view is usually also reachable from Settings, the command palette, and a keybinding. Fixing one is not fixing the feature.
- **Clients.** Web and desktop (wraps web, adds Electron shell/IPC). Shared logic lives in `packages/client-runtime`
- **Contracts.** Anything crossing the wire is typed in `packages/contracts`. Change the schema and the server, web, and desktop all follow.
- **Reverse states.** If you added a way in, add the way out and the way to see it. Snooze needs unsnooze. Close needs reopen. A one-way door is a bug.
- **Connection modes.** Local, remote/relay, and tunnel behave differently. Multi-device and multi-environment cases are real.
- **Docs.** `docs/` splits by audience. Behavior changes that a user would notice belong in `docs/user/` (shipped-product voice, no repo tooling or source paths); architecture and contributor changes in `docs/internals/`; runbooks in `docs/operations/`; new vocabulary in `docs/internals/glossary.md`.

## Dev servers

- `bun i` from the repo root installs the whole workspace. If module resolution looks broken, `node_modules` is missing or stale — install again. Add a dependency in the package that uses it (`cd packages/ui && bun add lodash`), never as a root app dependency.
- `turbo dev` starts every persistent `dev` task (web on 3000, docs on 3001). Narrow with `--filter=web` or `--filter=./apps/*`. Do not `cd` into an app and `bun run dev` when other packages need to run with it — that bypasses Turborepo's graph. `bun run dev` at the root is the same pipeline (`turbo run`); `turbo dev` is the terminal shorthand.
- `dev` is `cache: false` and `persistent: true`. Do not treat it like a cacheable build. Pass package-script args after `--`.
- Read the real URLs from turbo's TUI / Next.js output. Occupied ports shift.
- Never start a server against `~/.evie`. Worktree state belongs in that worktree's gitignored `.evie`.
- Stop what you started, by the PID you tracked. See rule 1.

## Test data

An empty database is a bad test. Seed your worktree's `.evie` with a copy of real data instead of pointing at live state:

- Copy from `~/.evie/userdata` (the developer's real data, the most realistic test set) or `~/.evie/dev`. Worktree state lives at `<worktree>/.evie/userdata`.
- Snapshot the database with `VACUUM INTO`, which is safe even while a server has the source open and yields one consistent file:

  ```bash
  mkdir -p .evie/userdata
  rm -f .evie/userdata/state.sqlite*  # VACUUM INTO refuses to overwrite
  bun -e "new (require('bun:sqlite').Database)(process.env.HOME + '/.evie/userdata/state.sqlite', { readonly: true }).run(\"VACUUM INTO '.evie/userdata/state.sqlite'\")"
  ```

  A plain `cp` is only safe when no server has the source open, and must bring the `-wal` and `-shm` siblings along. A live file copy is a corrupt copy.

- Bring `secrets` and `settings.json` only if the flow under test needs them.
- Copy in, never symlink. Data flows one way: into your sandbox, never back out.

## Verifying

- Smallest proof that the change works. `vp test run <files>` for the tests you touched, targeted lint and typecheck for the scope you changed.
- **Do not run repo-wide checks.** No `vp check`, no `vp run -r test`, no `vp run -r typecheck` unless I ask. CI owns the full suite.
- Backend behavior changes ship with focused tests for that behavior.
- The server is event-sourced and its async flows emit typed receipts. Wait on receipts and worker drains, never on sleeps or polling. A test that needs a timeout to pass is wrong.
- Upon request, user-visible frontend changes should get one integrated pass in a real client: `test-evie-app` for web, `test-evie-desktop` for desktop. The primary agent does this once after integrating. Subagents do not launch their own dev servers. Ask permission before doing computer use or spinning up browsers.

## Pull requests

- Never make a PR unless the developer explicitly asks you to do so.
- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`.
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work.
- UI changes need before/after images. Motion or timing needs a short video.
- One concern per PR. If the description says "also", split it.
- When babysitting: poll checks and comments newer than the last push, verify each bot finding against the source, fix real ones, dismiss false positives with a written reason. Stay quiet when nothing is new. Stop when the bots are green on the latest commit.

## How it works

Clients send typed WebSocket requests. The server turns them into _commands_, a pure _decider_ turns commands into persisted _events_, and a _projector_ derives the read model the UI renders. Provider CLIs run as subprocesses; per-provider _adapters_ translate their native protocols into orchestration events. Side effects run in queue-backed _reactors_ that emit _receipts_ when milestones land. Each turn ends with a _checkpoint_, a hidden git ref, so the app can diff and restore.

Full glossary with file links: `docs/internals/glossary.md`

## Where code lives

- `apps/server` - WebSocket, orchestration, providers, checkpointing. Effect-heavy: read `.repos/effect-smol/LLMS.md` before writing Effect code.
- `apps/web` - React/Vite UI. `apps/desktop` wraps it, `apps/mobile` is React Native, `apps/marketing` is the site.
- `packages/contracts` - Effect/Schema contracts plus small derived helpers. No heavy runtime logic.
- `packages/shared` - shared runtime utils, subpath exports, no barrel.
- `packages/client-runtime` - client code shared by web and mobile.
- `.repos/` - vendored read-only references. Prefer their patterns over invented ones. Never edit or import from them. Sync with `vpr sync:repos` when bumping the matching dependency.

## Taste

- Complexity belongs at the adapter boundary. Orchestration stays pure, UI stays dumb.
- Inferred types over annotations. `any` is the enemy.
- Comments describe how a thing is used, and move when the code moves. To be used mostly to describe functions, not to annotate every line of behavior.
- Our users drive agents all day and notice a dropped frame, a lying spinner, and a stale label. No continuously repainting animations; they peg the GPU on high-refresh displays.
- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it.

## Additional tips

- Don't verify with browsers or computer use unless the user explicitly agrees or requests it.
- Security is important, but should not be over-indexed on, especially for dev mode/maintainer-only features.