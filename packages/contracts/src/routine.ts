import { Schema } from "effect"
import { BotId, Millis, RoutineId, ThreadId, UserId } from "./ids.ts"

/**
 * A routine: a saved prompt the scheduler runs on a cron cadence, with nobody
 * present.
 *
 * The read-model shape, not the command. `nextRunAt` is the scheduler's cache
 * of `(cron, tz)` and is recomputed rather than trusted -- the client renders
 * it, and must not be the reason anything believes it.
 */
export const Routine = Schema.Struct({
  id: RoutineId,
  botId: BotId,
  /**
   * The thread a run posts into. Null means the scheduler opens a fresh one
   * per run, which is what a digest wants and a long-running errand does not.
   */
  threadId: Schema.NullOr(ThreadId),
  name: Schema.String,
  /** 5-field cron. Validated by the decider, which is the only writer. */
  cron: Schema.String,
  /**
   * IANA zone, stored per routine and never inherited from the host, so a
   * laptop crossing a timezone cannot silently shift someone's 9am digest.
   */
  tz: Schema.String,
  prompt: Schema.String,
  /**
   * The member an unattended run acts as. Required once the bot holds a
   * member-scoped connection, because eve will not borrow someone's grant.
   */
  runAs: Schema.NullOr(UserId),
  enabled: Schema.Boolean,
  /**
   * Set when the scheduler took the routine out of service on its own -- the
   * run-as member left, say. Distinct from `enabled: false`, which is a person
   * choosing: one is a fault to explain, the other is a switch to flip back.
   */
  blockedReason: Schema.NullOr(Schema.String),
  lastRunAt: Schema.NullOr(Millis),
  /** Null when disabled or blocked: nothing is due if nothing will run. */
  nextRunAt: Schema.NullOr(Millis),
})
export type Routine = typeof Routine.Type
