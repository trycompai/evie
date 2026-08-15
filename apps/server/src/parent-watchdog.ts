import { Effect, Layer } from "effect"

/**
 * Exits when the process that launched this one goes away.
 *
 * A launcher that owns the server as a child -- the desktop shell, `npx evie` --
 * normally stops it on the way out. Normally is the problem: a SIGKILL, a force
 * quit, or a crash gives the parent no chance to signal anyone, and what is left
 * behind is a server still holding the port and the SQLite write lock with no
 * window attached to it. The next launch then fails to bind, and the user's only
 * recourse is a process list.
 *
 * macOS has no `PDEATHSIG`, so the portable answer is to watch. `EVIE_PARENT_PID`
 * is opt-in: a hand-started server has no launcher and never polls.
 *
 * The signal watched for is *reparenting*, not an unreachable pid. Checking
 * whether the pid still exists would be wrong -- pids are recycled, and a
 * long-lived server would eventually be watching a stranger. `process.ppid` is
 * this process's own view of its parent, needs no permission, and drops to 1 the
 * moment the launcher dies however it died.
 */

/** Fast enough that a relaunch never races the old server, and free at this rate. */
const INTERVAL_MILLIS = 2_000

export const ParentWatchdogLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const raw = process.env["EVIE_PARENT_PID"]
    const parent = raw === undefined ? Number.NaN : Number(raw)
    if (!Number.isInteger(parent) || parent <= 1) return

    yield* Effect.forkScoped(
      Effect.gen(function* () {
        while (process.ppid === parent) {
          yield* Effect.sleep(INTERVAL_MILLIS)
        }
        yield* Effect.log(`Launcher ${parent} exited; shutting down`)
        // SIGTERM to self rather than `process.exit`: `runMain` handles it by
        // closing the layer scope, which is the only path that stops the
        // provider runtimes and closes the database cleanly.
        yield* Effect.sync(() => process.kill(process.pid, "SIGTERM"))
      }),
    )
  }),
)
