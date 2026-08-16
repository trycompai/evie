---
name: eve
description: Build durable backend AI agents with the eve framework. Use when creating, editing, or debugging an eve project — agent instructions, skills, tools, connections, channels, sandboxes, subagents, schedules, or evals. Also use when changing how Evie scaffolds or runs its bots.
---

# eve

eve is a filesystem-first framework for durable backend AI agents. An agent is
a directory on disk — instructions, skills, tools, connections, channels,
subagents, and schedules are all files — and eve compiles and runs it.

## Source of truth

The complete documentation ships inside the `eve` package. Do not rely on this
skill for guidance, and do not answer from memory — always read the bundled
docs, which match the installed version exactly:

```
node_modules/eve/docs/
```

Start with `node_modules/eve/docs/README.md`. It contains the full index and
recommended reading order. Before writing any eve code, read the relevant guide
there first.

### Finding the docs inside the Evie repo

`eve` is **not** a dependency of the Evie workspace, so there is no
`node_modules/eve` at the repo root. eve is pinned and installed per bot
directory (decision 014), so the docs live under an existing bot:

```bash
ls "$(ls -d .evie/userdata/orgs/*/bots/*/ | head -1)node_modules/eve/docs"
```

If no bot exists yet, install the pinned version somewhere scratch and read it
there. The pin is `EVE_VERSION` in `apps/server/src/provider/scaffold.ts` —
read the version from that constant rather than installing `latest`, or you
will be reading docs for a version Evie does not run:

```bash
npm install eve@<EVE_VERSION> --no-audit --no-fund --ignore-scripts
```

## How Evie runs eve, and what it changes

These are Evie-specific facts the bundled docs cannot know. Get them wrong and
you will describe capabilities the bots do not have, or deny ones they do.

- **Bots run `eve dev --no-ui`**, never `eve build`/`eve start` (decision 012;
  `runtime_mode = 'built'` is a later roadmap phase). An instruction edit lands
  on the next turn with no build step.
- **eve's own `agent/schedules/` never fire**, because `eve dev` does not run
  cron. Scheduling in Evie is **routines** — Evie's own scheduler
  (`apps/server/src/scheduler/Scheduler.ts`), with a 5-field cron, an IANA
  timezone, an optional thread, and a run-as member. It is wired end to end:
  commands, decider, scheduler, reactor, a `routines.list` RPC, and the
  Routines dialog at `/routines`. "Evie cannot run anything on a schedule" is
  wrong.
- **Evie generates `agent/connections/*.ts`** from the bot's connection rows on
  every runtime spawn, and sweeps the files it wrote when a connection goes
  away. `org` scope reads its token from `connectionEnvName(name)`, injected by
  `spawnEnv`; those two live in different modules, so change them together.
  `member` scope and `interactive` auth are deliberately **not** generated —
  they need the per-person OAuth callback proxy 05 describes, which does not
  exist. Do not "fix" that by generating a file; a bot that compiles and 401s
  reads as a broken service rather than an unfinished feature.
- **Evie owns the generated files** in each bot project — `agent/agent.ts`,
  `agent/channels/eve.ts`, `agent/sandbox/sandbox.ts`,
  `agent/instructions/00-evie.md` (the capability briefing), and everything
  under `agent/connections/` carrying Evie's marker. Everything else in
  `agent/`, `instructions.md` included, is the user's. Change generated content
  in `scaffold.ts`, never by editing a bot directory in place.
- **`agent.ts` is edited only through `eve set`**, so eve's validated source
  editor stays its single writer and a `defineDynamic` model is not clobbered.
- **The sandbox is deny-all egress** plus `ai-gateway.vercel.sh` and the hosts
  allow-listed in Settings > Computer. The sandbox cannot see the bot's own
  project files, so a bot cannot edit itself with `bash`.

## Changing what bots know about themselves

The capability briefing in `scaffold.ts` is a system-role instruction on every
model call for every bot. It is regenerated on each runtime spawn, so a
correction reaches existing bots on their next boot. Keep it to what is
verifiably true of the runtime today — an over-promise there is as damaging as
the under-promise it replaced. `apps/server/test/capability-briefing.test.ts`
covers it.
