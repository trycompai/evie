# Getting started

> **Evie is not shipped yet.** This page describes what you can run from the
> repository today, which is a server and a web client. There is no installer
> and no desktop app. Where the product is going is in [`specs/`](../../specs);
> where it actually is, in detail, is in
> [`specs/07-state-of-the-build.md`](../../specs/07-state-of-the-build.md).
>
> This file will become the shipped-product guide when there is a shipped
> product. Until then it stays honest about the gap, because a getting-started
> page that describes features nobody built is worse than no page at all.

Evie runs on your machine. Your bots live on your disk, they run against your
API key, and nothing is uploaded in order to work.

## Run it

You need Node 24 or newer and Bun. From the repository root:

```sh
bun i
turbo run build --filter=@evie/web

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

Open that exact URL. There is no password and no account to create.

The token is single-use and expires in 60 seconds, so a reload or a second tab
lands on *"That sign-in link was already used"* — restart the server for a fresh
one. That is deliberate. Every process on your machine can reach loopback, and
so can a page in a browser you happen to have open; behind that cookie is an
agent with a shell in your home directory.

## Give it a key

Evie does not sell you tokens. You bring a key and every model runs through it.

**Today this only works one way**: export the key in the shell that starts the
server, and the agent runtime inherits it.

```sh
export AI_GATEWAY_API_KEY=…      # or ANTHROPIC_API_KEY / OPENAI_API_KEY
```

A Vercel AI Gateway token is the straightforward path — one key reaches every
model and your spend shows up in one dashboard you own.

There is no settings screen yet, so there is no way to paste a key into the app.
That is the first thing being built.

## Make a bot

A bot is a role you set up once and keep talking to — "Inbox", "Researcher",
"Ops". Give it a name and a face and it exists.

Creating one writes a small project to disk and installs its dependencies, so
the first bot takes a minute and **needs network access, `git`, and `npm`**.
While that runs the bot shows as *starting*; it becomes *idle* when it is ready
to talk, or *unhealthy* with a reason if the install failed.

Each bot gets its own computer: a filesystem and a shell, sandboxed, persisting
between conversations.

## Talk to it

Type. Press Enter.

While a bot is working, the label under its name says what it is actually doing:
*Thinking*, *Running bash*, *Waiting on you*. It never says *Thinking* while it
is parked waiting for an answer from you — if the app looks busy, it is busy.

Before a bot does something consequential it asks, right there in the
conversation rather than in a dialog that steals your place. You can approve or
say no. Saying no is not an error; the bot carries on.

## What is not there yet

So you do not go looking:

- **No desktop app**, no tray, no notifications, no deep links.
- **No settings** — no model picker, no key entry, no sandbox controls.
- **No routines, connections, or plugins.** The Plugins window opens and is
  empty; connecting a service does not yet reach the agent.
- **No members, invitations, or teams**, though the database has been ready for
  them since the first migration.
- **No snooze or archive** in the interface, though the commands exist.
- **No remote access** — no pairing, no LAN mode you can reach from a phone.
- **Reopening the app forgets your bots** until the cold-load fix lands. They are
  still on disk; the rail just does not fetch them.

## One thing that is already true

**Reasoning is never kept.** A bot's thinking is streamed to you live while a
turn runs and then discarded. Reopen the conversation next month and you will
see *thought for 4.2k tokens* and not the words. That is deliberate: it is the
most sensitive text a model produces, and nobody rereads it.
