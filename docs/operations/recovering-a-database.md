# Recovering a corrupt database

**Symptom.** The server refuses to start with an SQLite error, or it starts and
every request fails with `StorageUnavailable`, or the app loads into read-only
mode with a banner.

**Before anything else: stop writing to it.** A second process against a damaged
file is how a recoverable problem becomes an unrecoverable one. Quit the desktop
app from the menu bar; a window close leaves the server running on purpose.

## 1. Snapshot before you touch it

`VACUUM INTO` is the only supported way to copy this database, and it is safe
even while another process has the source open. A plain `cp` of a live SQLite
file is a corrupt copy — the WAL is not in it.

```bash
cd ~/.evie/userdata
bun -e "new (require('bun:sqlite').Database)('state.sqlite', { readonly: true }).run(\"VACUUM INTO 'state.backup.sqlite'\")"
```

If that itself fails, the file is damaged badly enough that the copy would be
too. Copy `state.sqlite`, `state.sqlite-wal`, and `state.sqlite-shm` together —
all three, or the copy is meaningless — and continue from the copies.

## 2. Ask SQLite what is wrong

```bash
sqlite3 ~/.evie/userdata/state.sqlite "pragma integrity_check;"
```

`ok` means the file is fine and the problem is elsewhere — check disk space
(`df -h`) and permissions on the directory, which are the two things that
produce SQLite errors on a healthy file.

## 3. Rebuild from a dump

Anything other than `ok`:

```bash
cd ~/.evie/userdata
sqlite3 state.sqlite ".recover" > recovered.sql
mv state.sqlite state.corrupt.sqlite
sqlite3 state.rebuilt.sqlite < recovered.sql
sqlite3 state.rebuilt.sqlite "pragma integrity_check;"   # expect: ok
mv state.rebuilt.sqlite state.sqlite
```

Prefer `.recover` over `.dump`: `.dump` stops at the first bad page and gives you
a truncated file that looks complete.

**Keep `state.corrupt.sqlite`.** It is the only copy of anything `.recover`
could not read, and you cannot tell what that was until someone notices.

## 4. What you may have lost, and what you have not

The event log is the durable record; the projections are derived from it. If
timeline rows are missing but events survived, they will be rebuilt.

What is genuinely gone if events were lost:

- **Nothing about the agents themselves.** eve owns its own durable state under
  each bot's directory. Bots, their instructions, their skills, and their
  workflow state are files on disk and were never in this database.
- **Timeline history** for threads whose events did not recover.
- **Reactor cursors.** A reactor with a lost cursor replays from zero. Handlers
  are idempotent, so that is slow rather than harmful — except notifications,
  which will not re-fire for anything older than the reactor's start time.

Secrets are in this database, encrypted. If `secret` rows did not recover,
re-enter the keys; the encryption key in `secrets.key` is unaffected and there
is no way to recover the values without the rows.

## 5. Start and verify

```bash
open -a Evie      # or: npx evie
```

You have recovered when: the app reaches the rail rather than a banner, a bot
you expect is in the list, opening a thread renders its history, and a new
message gets a reply. Check all four — the first two pass on a database that has
lost every timeline row.

## Preventing the next one

- The database is in WAL mode with `synchronous=NORMAL`, which survives a
  process crash but not a power cut mid-write. On a machine that loses power,
  `synchronous=FULL` is the trade to make.
- Corruption almost always follows a full disk. Evie degrades to read-only with
  a banner rather than corrupting state, but the filesystem underneath it has
  no such courtesy.
- Never point two servers at one Evie home. That is the other way this happens,
  and it is the one a developer does to themselves — see rule 2 in `AGENTS.md`.
