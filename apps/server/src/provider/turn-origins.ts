import type { SessionId, TurnId, UserId } from "@evie/contracts/ids"

/**
 * The mapping between Evie's turns and eve's.
 *
 * They are two identifiers for related things and neither side echoes the
 * other's. Evie mints a `TurnId` -- a ULID -- when it dispatches; eve numbers
 * its own turns `turn_1`, `turn_2` and stamps that reference on every stream
 * event. So the adapter remembers each dispatch in a per-session FIFO and pins
 * it to the reference it sees on the next `turn.started`. An approximation
 * under steering, and the honest one available: turns on one session start in
 * dispatch order.
 *
 * Two things need the mapping, and both were wrong without it:
 *
 *   - the status chip carries the id `CancelTurn` addresses, and Evie's is the
 *     only one the decider will match. Putting eve's reference there
 *     type-checked through a cast and then failed `ThreadStatus`'s schema on
 *     the wire, which killed every subscriber's stream mid-turn. The reply was
 *     written to the database and never delivered until the client
 *     reconnected, so the app looked frozen and a reload "fixed" it;
 *   - cancelling goes the other way. eve is asked to stop a turn by its own
 *     reference, and handing it a ULID it never minted is not a cancellation.
 *
 * Both maps are bounded. A session is long-lived; its turn history is not
 * something this process should accumulate forever.
 */

export interface TurnOrigin {
  /** The member the turn acts as. eve does not echo the caller on its stream. */
  readonly userId: UserId
  /** Evie's turn id. Null for a dispatch Evie did not originate. */
  readonly turnId: TurnId | null
}

/** Dispatches awaiting a `turn.started`. Deeper than any real steering burst. */
const MAX_PENDING = 32
/** Named turns kept per session, oldest evicted first. */
const MAX_NAMED = 128

export interface TurnOrigins {
  /** Records a dispatch. The next `turn.started` on this session claims it. */
  readonly dispatched: (sessionId: SessionId, origin: TurnOrigin) => void
  /** eve named a turn: pin the oldest pending dispatch to that reference. */
  readonly named: (sessionId: SessionId, providerRef: string) => void
  /** Who and which turn a stream event belongs to. Null before `turn.started`. */
  readonly of: (sessionId: SessionId, providerRef: string | null) => TurnOrigin | null
  /** eve's reference for one of Evie's turns, for the operations eve owns. */
  readonly providerRef: (sessionId: SessionId, turnId: TurnId) => string | null
}

export const makeTurnOrigins = (): TurnOrigins => {
  const pending = new Map<string, Array<TurnOrigin>>()
  const assigned = new Map<string, Map<string, TurnOrigin>>()

  return {
    dispatched: (sessionId, origin) => {
      const queue = pending.get(sessionId) ?? []
      queue.push(origin)
      if (queue.length > MAX_PENDING) queue.shift()
      pending.set(sessionId, queue)
    },

    named: (sessionId, providerRef) => {
      const origin = pending.get(sessionId)?.shift()
      if (origin === undefined) return
      const byRef = assigned.get(sessionId) ?? new Map<string, TurnOrigin>()
      byRef.set(providerRef, origin)
      if (byRef.size > MAX_NAMED) {
        const oldest = byRef.keys().next().value
        if (oldest !== undefined) byRef.delete(oldest)
      }
      assigned.set(sessionId, byRef)
    },

    of: (sessionId, providerRef) =>
      providerRef === null ? null : (assigned.get(sessionId)?.get(providerRef) ?? null),

    providerRef: (sessionId, turnId) => {
      const byRef = assigned.get(sessionId)
      if (byRef === undefined) return null
      // Newest first: the turn being cancelled is the one still running.
      const entries = [...byRef.entries()]
      for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index]!
        if (entry[1].turnId === turnId) return entry[0]
      }
      return null
    },
  }
}
