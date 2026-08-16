# Getting started

> **Evie is not shipped yet.** This page describes what you can run from the
> repository today: a server, a web client, and a desktop app you build
> yourself. There is no installer. Where the product is going is in
> [`specs/`](../../specs);
> where it actually is, in detail, is in
> [`specs/07-state-of-the-build.md`](../../specs/07-state-of-the-build.md).
>
> This file will become the shipped-product guide when there is a shipped
> product. Until then it stays honest about the gap, because a getting-started
> page that describes features nobody built is worse than no page at all.

Evie runs on your machine. Your bots live on your disk, they run against your
API key, and nothing is uploaded in order to work.

## Run the desktop app

The desktop app is the main surface. It starts its own server, opens a window
onto it, and lives in the menu bar. You need Bun; it brings its own Node.

```sh
bun i
cd apps/desktop && bun run app
```

Closing the window does not stop Evie — that is the point of a local agent app.
Your bots keep working, and the menu bar icon is where you find it again.
**Quit Evie** in that menu is the only thing that stops the server.

While you are running it from a checkout it keeps its data in the repository's
own `.evie` directory, not in `~/.evie`, so it cannot touch a real install.

If the menu bar says Evie stopped, **Reveal Log in Finder** in that same menu
selects `desktop.log` inside Evie's `userdata` directory. It holds what the app
and its server both printed, newest last, and it keeps one previous file — so
the reason a start failed is still there after the app has tried again.

## Run just the server and a browser

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
"Ops". Give it a name and a face and it exists. The face picker offers six
shapes and twelve colours — six neutral steps and six hues — and the eyes stay
readable on every one of them, in both light and dark mode.

## Rename or delete a bot

Both live in two places: the **⋯** menu beside the bot's name at the top of
its conversation, and a **right-click on the bot's row in the sidebar**.

Renaming is just a rename — conversations, files, and memory all stay.

Deleting a bot takes it out of your sidebar and stops it taking work, but
nothing is destroyed: its computer and its conversations are kept. To bring it
back, open **New bot** — deleted bots are listed there under **Archived**, one
click from restored, with their conversations exactly where they were.

Creating one writes a small project to disk, installs its dependencies, and
starts it, so the first bot takes a minute and **needs network access, `git`,
and `npm`**. While that runs, the conversation says the bot is being created
and the composer waits. The wait ends with the bot introducing itself — that
greeting is the proof the whole path works, not just a label saying so. If
setup failed, the bot shows as *unhealthy* with the step that broke.

Each bot gets its own computer: a filesystem and a shell, sandboxed, persisting
between conversations.

## Look at its computer

The screen button beside a bot's name opens its computer, and **Files** is the
disk it works on. Folders open when you click them, one level at a time.

The listing is taken the moment you look at it, not kept up to date — a bot
writing files while the pane is open will not move the rows. Closing a folder
and opening it again re-reads it, and so does leaving the tab and coming back.

## Talk to it

Type. Press Enter.

While a bot is working, the label under its name says what it is actually doing:
*Thinking*, *Running bash*, *Waiting on you*. It never says *Thinking* while it
is parked waiting for an answer from you — if the app looks busy, it is busy.

Before a bot does something consequential it asks, right there in the
conversation rather than in a dialog that steals your place. You can approve or
say no. Saying no is not an error; the bot carries on.

When a question arrives and you are not mid-message, it takes the keyboard.
Press a choice's letter to answer, arrow between choices and press Enter, or
just start typing — anything that isn't a choice letter drops you into the
message box with that character already there, and a typed reply answers the
question in your own words. Escape puts your cursor back in the message box.
If you were already drafting something, nothing moves; finish your thought.

When the answer would let the bot *do* something — run a tool, touch your
files — there is a beat to change your mind: the card shows what you chose
with an **Undo**, and only sends it a moment later. Plain questions send
immediately.

If it is asking about a tool you are happy for it to keep using, tick **Always
allow … for this session** before you answer. The next time that same tool
comes up in the same conversation, it goes ahead without asking. The grant is
exactly as narrow as it sounds: one tool, one session. Start a new session and
it asks again.

## Put a bot on a schedule

**Routines** in the sidebar runs a bot on a cadence with nobody watching — a
morning digest, a nightly sweep, a check every fifteen minutes.

A routine is a prompt plus a cadence. Pick daily, weekdays, weekly, hourly, or
every few minutes, and if none of those fit, write a cron expression instead.
The row then says what you chose in words — *Weekdays at 9:00 AM* — rather than
making you re-read the cron to find out.

The timezone is stored on the routine, not taken from the machine, and it
defaults to yours. That is deliberate: a server in another zone, or a laptop
that crosses one, must not quietly move your 9am to somebody else's.

Nobody is there when it runs, so say in the prompt what to do when there is
nothing to report — otherwise you get a message every morning telling you there
was nothing to tell you. A routine cannot stop to ask you a question.

**Pause** takes one out of service and gives it back with the same button.
Deleting is separate, and permanent.

One routine can stop on its own: if it was pinned to run as a person and that
person leaves the organization, it blocks itself and the row says so. That is
not the same as paused — resuming will not fix it, because the thing to fix is
who it runs as.

## Reading while it is still writing

Scroll up mid-answer and the conversation stops following along — you are
reading something, and yanking you back to the bottom every time a sentence
lands is the fastest way to make a page unreadable. It keeps writing; you keep
your place. A button appears at the bottom to take you back to the live edge
when you want it, and it stays gone while you are already there.

## Knowing your bot is still there

Next to the bot's name at the top of a conversation there is a small dot.

- **Green** — it is up: either ready, or working on something right now.
- **Amber** — it is starting, or reconnecting after a hiccup.
- **Grey** — it is asleep. Hover the dot and it says so.
- **Red** — something is wrong, and hovering says what.

Grey is the one worth explaining, because it looks like a problem and is not.
A bot you are not talking to shuts its machine down after a while instead of
burning your laptop's battery to sit idle. Nothing is lost when it does — the
conversation, the files it has been working on, and everything it remembers
are all on disk. Your next message wakes it up.

While you have a conversation open, the bot behind it is kept awake, so the
thing you are actually looking at does not go to sleep under you.

If a bot was mid-answer when Evie restarted, opening the conversation picks the
answer back up: the work carried on without Evie watching, and reopening the
thread is what reconnects to it.

A bot in the sidebar shows a dot only when something needs you or something is
wrong — a green dot on every row would be noise. The full status lives in the
conversation.

## Reloading keeps your place

Where you are is in the address bar — a conversation is `/chat/<id>`. Refresh
the page and you come back to it, not to the welcome screen. Close the desktop
window and reopen it from the tray and it is still there; the window hides
rather than throws the page away.

Open Evie with nothing in particular in mind — a fresh tab, or the app after a
quit — and it opens the conversation you touched last, rather than an empty
column asking you to pick one.

That also makes a conversation a link. Copy the URL out of a browser tab and it
opens the same thread the next time — on the same environment, signed in as
you. It is not a share link: someone else's browser gets the sign-in screen. A
link to a conversation that has since been deleted says so, and gives you a way
back, instead of quietly showing you nothing.

One thing it deliberately does not keep: a message you had half typed is gone on
reload, the same as any other form on the web.

## What is not there yet

So you do not go looking:

- **No installer, no signing, no auto-update**, and the desktop app is macOS
  only for now. You build it from the repository.
- **No settings** — no model picker, no key entry, no sandbox controls.
- **No plugin marketplace.** The Plugins window opens and is empty — the
  curated catalog has not been written. Connecting a service by hand works
  (see *Put a bot on a schedule* and below), but there is nothing to browse.
- **Per-member connections do not work yet.** A connection where each person
  signs in with their own account will show as connected and give the bot
  nothing, because the sign-in flow behind it has not been built. Connections
  the whole organization shares — one credential, one account — do work.
- **No members, invitations, or teams**, though the database has been ready for
  them since the first migration.
- **No snooze or archive for conversations** in the interface, though the
  commands exist. Bots themselves can be renamed, deleted, and restored — see
  above.
- **A bot's computer is partly built.** Files lists what the bot has (its
  housekeeping dotfiles are hidden), and Terminal shows every shell command the
  bot has run in the open conversation and what it printed. Browser is there
  and empty, and no file opens when you click it.
- **No remote access** — no pairing, no LAN mode you can reach from a phone.
- **No way to see a diff.** A turn now tells you how many files it changed and
  by how much, and you can restore a checkpoint — but there is nowhere to read
  the actual patch yet.
- **Restoring rewinds your files, not the bot's memory.** The agent keeps
  believing it made the edits. That is deliberate: the runtime has no way to
  forget back to a point in time, and pretending otherwise would be worse than
  saying so.

## One thing that is already true

**Reasoning is never kept.** A bot's thinking is streamed to you live while a
turn runs and then discarded. Reopen the conversation next month and you will
see *thought for 4.2k tokens* and not the words. That is deliberate: it is the
most sensitive text a model produces, and nobody rereads it.
