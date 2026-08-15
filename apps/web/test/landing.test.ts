import type { Bot } from "@evie/contracts/bot"
import type { BotId, ThreadId } from "@evie/contracts/ids"
import type { Thread } from "@evie/contracts/thread"
import type { FleetSnapshot } from "@evie/client-runtime/store"
import { describe, expect, it } from "vitest"
import { resolveLanding } from "../src/lib/landing.ts"

/**
 * Where a window with no destination opens. This is the decision that used to
 * be wrong on every reload, so it is the one worth pinning down.
 *
 * Note what is *not* asserted: that the caller waited for the fleet. That is a
 * precondition the route holds (`_app` awaits it) and it cannot be checked from
 * here -- an unanswered fleet and a new account are the same empty arrays,
 * which is exactly why `FleetSnapshot.loaded` exists.
 */

const fleet = (bots: readonly Bot[], threads: readonly Thread[]): FleetSnapshot => ({
  bots,
  threads,
  loaded: true,
})

const bot = { id: "bot_1" as BotId } as Bot

const thread = (id: string, lastActivity: number): Thread =>
  ({ id: id as ThreadId, lastActivity }) as Thread

describe("resolveLanding", () => {
  it("sends an account with no bots to onboarding", () => {
    expect(resolveLanding(fleet([], []))).toEqual({ to: "welcome" })
  })

  it("stays out of onboarding once a bot exists, even with no conversations", () => {
    expect(resolveLanding(fleet([bot], []))).toEqual({ to: "empty" })
  })

  it("opens the most recently active conversation", () => {
    const landing = resolveLanding(
      fleet([bot], [thread("thr_old", 1_000), thread("thr_new", 3_000), thread("thr_mid", 2_000)]),
    )
    expect(landing).toEqual({ to: "thread", threadId: "thr_new" })
  })

  it("does not depend on the store's sort order", () => {
    // Same set, ascending. A landing that took threads[0] would open the oldest.
    const landing = resolveLanding(
      fleet([bot], [thread("thr_old", 1_000), thread("thr_mid", 2_000), thread("thr_new", 3_000)]),
    )
    expect(landing).toEqual({ to: "thread", threadId: "thr_new" })
  })
})
