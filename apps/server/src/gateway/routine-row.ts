import { Routine } from "@evie/contracts/routine"
import { Schema } from "effect"

/**
 * One `routine` table row, as the wire wants it.
 *
 * Its own module because of `nextRunAt`, which is the only field here that is
 * a judgement rather than a rename -- and the one a reader of `handlers.ts`
 * would skim past.
 */

const decodeRoutine = Schema.decodeUnknownSync(Routine)

/** The columns `routines.list` selects. */
export interface RoutineTableRow {
  readonly id: string
  readonly bot_id: string
  readonly thread_id: string | null
  readonly name: string
  readonly cron: string
  readonly tz: string
  readonly prompt: string
  readonly run_as: string | null
  readonly enabled: number
  readonly blocked_reason: string | null
  readonly last_run_at: number | bigint | null
  readonly next_run_at: number | bigint | null
}

const millisOr = (value: number | bigint | null): number | null =>
  value === null ? null : Number(value)

export const routineOf = (row: RoutineTableRow): Routine =>
  decodeRoutine({
    id: row.id,
    botId: row.bot_id,
    threadId: row.thread_id,
    name: row.name,
    cron: row.cron,
    tz: row.tz,
    prompt: row.prompt,
    runAs: row.run_as,
    enabled: row.enabled !== 0,
    blockedReason: row.blocked_reason,
    lastRunAt: millisOr(row.last_run_at),
    /*
     * `next_run_at` is the scheduler's cache, and the scheduler only recomputes
     * rows it might actually fire. A paused or blocked routine therefore keeps
     * whatever due time it had when it stopped being eligible -- a real
     * timestamp, drifting further into the past, that the UI would happily
     * render as "Next run Tuesday 9:00 AM" for a routine that will never run.
     * Reporting null is not hiding the column; it is the honest answer to
     * "when does this run next", which is: it does not.
     */
    nextRunAt:
      row.enabled === 0 || row.blocked_reason !== null ? null : millisOr(row.next_run_at),
  })
