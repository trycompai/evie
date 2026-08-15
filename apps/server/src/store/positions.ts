import { Context, Layer } from "effect"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import { makeThreadPositions, type ThreadPositions as Positions } from "../domain/project.ts"

/**
 * The one timeline position allocator in the process.
 *
 * It is a service for a single reason: the projector reactor and the eve
 * adapter both write `timeline_item`, they are built by different layers, and
 * the whole correctness argument is that they allocate from the same counter.
 * A second instance is not a smaller version of this -- it is the bug.
 *
 * `domain/project.ts` explains what drifted, and why the database clamping the
 * position on insert was only half a fix.
 */
export class ThreadPositions extends Context.Service<ThreadPositions, Positions>()(
  "ThreadPositions",
) {
  static readonly layer = Layer.sync(ThreadPositions)(makeThreadPositions)
}

/**
 * The position an insert should give a row, as a SQL fragment.
 *
 * Three answers, in order, and the order is the design:
 *
 *   1. a row that already exists keeps the position it has -- a streaming
 *      message is rewritten once per flush window and must not move;
 *   2. otherwise the allocator's prediction, which is the number already sent
 *      to every subscriber on the live frame;
 *   3. clamped up to the next free position, so a prediction that is somehow
 *      wrong lands the row at the end instead of colliding.
 *
 * Point 3 is not decoration. The unique index on `(thread_id, seq)` rejecting
 * an insert takes the projector's loop down, and a dead projector is a server
 * that looks healthy while the UI never updates again. The clamp means a bug
 * in the allocator costs one row's ordering, not the process.
 *
 * The body is written from this same expression (`json_set`), so the position
 * a client reads out of a row and the position the server pages by are the
 * same number by construction. That is why the insert is `insert ... select`
 * rather than `insert ... values`: the position has to be named once and used
 * twice. Such an insert needs a `where true` before its `on conflict`, or
 * SQLite cannot tell the upsert clause from a join constraint.
 */
export const positionOf = (
  sql: SqlClient.SqlClient,
  input: { readonly id: string; readonly threadId: string; readonly predicted: number },
) => sql`coalesce(
  (select seq from timeline_item where id = ${input.id}),
  max(
    ${input.predicted},
    (select coalesce(max(seq), 0) + 1 from timeline_item where thread_id = ${input.threadId})
  )
)`
