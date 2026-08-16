# The performance budget, and where each rule is enforced

Evie users leave the app open all day and drive agents through it. They notice a
dropped frame, a lying spinner, and a stale label. This file is the list of
budgets from [`specs/04-clients.md`](../../specs/04-clients.md) with the code
that keeps each one, so a review can check the mechanism instead of trusting the
intent.

Every entry here is a thing that looks fine in a screenshot and only shows up
when a thread is long or a turn is streaming. That is why they are written down.

| Budget | Limit | Kept by |
| --- | --- | --- |
| Thread open (2,000 items) to first paint | < 100 ms | Virtualized list; only ~30 rows mount. [`timeline.tsx`](../../apps/web/src/components/timeline.tsx) |
| React commits during streaming | ≤ 1 per animation frame | Row-level subscriptions + frame coalescing. [`store.ts`](../../packages/client-runtime/src/store.ts), [`smooth-text.ts`](../../packages/ui/src/lib/smooth-text.ts) |
| Sustained WS bytes for one streaming turn | < 40 KB/s | Suffix deltas, reasoning opt-in, 8 KiB tool cap. [`hub.ts`](../../apps/server/src/gateway/hub.ts) |
| Idle CPU, thread open, nothing running | ~0%. No timers, no polling, no rAF loop. | Demand-scheduled flush; no `setInterval` anywhere. |
| Main-thread long tasks during streaming | none > 50 ms | Per-block memoized Markdown; one shared `ResizeObserver`. |

## The five mechanisms

### 1. A frame changes the identity of exactly what it touched

`Timeline.apply` replaces one item object and leaves every other one
referentially identical, so `TimelineRow`'s `memo` skips them.

Rebuilding the map or the order array on every frame passes every content test
and fails the budget silently — the app just gets slow with a thread open. That
is why the identity assertions are in
[`timeline.test.ts`](../../packages/client-runtime/test/timeline.test.ts) rather
than left to review.

`apply` also derives one thread-level field — `streamingId`, the row the deltas
are extending. It invalidates the snapshot and so re-renders the list container,
but it only moves at turn boundaries: twice a turn, not twenty times a second.
It is read from the ops rather than inferred from the tail of `order`, which is
a tool row as often as it is a reply.

**Watch for:** `new Map(...)` or `[...items]` inside `apply`; a `sort` that runs
when nothing was inserted; a derived field that changes mid-stream and drags the
container into every frame with it.

### 2. Subscribe per row, not per thread

`store.subscribeItem(threadId, itemId)` exists because a thread-level
subscription re-renders the list container on every 50 ms frame. On a 2,000-row
thread that is 2,000 memo comparisons twenty times a second to discover that one
row changed.

`getItemSnapshot` must be referentially stable. A getter that builds a fresh
object per call makes `useSyncExternalStore` loop forever, and it is the single
easiest way to get this wrong.

**Watch for:** a new hook that reads the whole timeline to render one row.

#### Measuring a row is a debt to the reader

Virtualization costs a row at `ESTIMATED_ROW` (72px) until it mounts. A bubble
of markdown is five to ten times that, so the correction on attach is large, and
if the row sits above the fold it grows every offset below it — the viewport
slides by the difference while `scrollTop` does not move. The slide reveals more
unmeasured rows, which correct, which slide again. Scrolling up compounds this
into an apparent teleport, and it reads as a glitch rather than as a bug because
it only happens in territory the reader has not visited yet.

`record` in [`timeline.tsx`](../../apps/web/src/components/timeline.tsx) banks
the delta and `attachContent` pays it back inside a `ResizeObserver` callback —
after layout, before paint, the one moment where the new offsets are committed
and nothing has been drawn. Correcting from the ref callback that took the
measurement is a frame too early: the rows have not moved yet and the browser
clamps the write against a content height that is about to change.

**Watch for:** a write to `heights` that does not go through `record`; a
`scrollTop` adjustment outside a `ResizeObserver`.

### 3. The flush is demand-scheduled, not periodic

The first pending delta arms a 50 ms timeout; the flush sends the frame and
disarms it. **An idle thread has no timer at all.**

The obvious implementation — a `setInterval` per subscriber — quietly breaks the
idle-CPU budget: a user with eight threads open and nothing running would wake
the process 160 times a second to decide it has nothing to say.

**Watch for:** `setInterval`, and any `setTimeout` that re-arms itself
unconditionally.

### 4. Nothing repaints continuously

CSS animations that repaint every frame peg the GPU on a 120 Hz display, and
Evie is open all day. No shimmer, no gradient sweep, no pulsing dot at 60 fps,
no spinner.

Two indicators are allowed to loop, both in
[`globals.css`](../../packages/ui/src/styles/globals.css), and both for the same
reason — they step rather than interpolate:

| Loop | Cost | Says |
| --- | --- | --- |
| `.evie-thinking` | 1s `steps(4)`, 4 repaints/s | a turn is running |
| `.evie-busy-eyes` | 4.8s `step-end`, 7 changes ≈ 1.5 repaints/s | a bot's computer is still being built |

`.evie-busy-eyes` is the face `CreatingPane` shows for the minute or two a new
bot takes to provision. It replaced an `.evie-thinking` ellipsis on that screen,
which is worth knowing about because the ellipsis was not only the more
expensive of the two — it appended up to three characters to a centred line, so
it also **shifted the layout four times a second for the length of the wait**. A
text-content loop under centred or right-aligned text is a layout shift wearing
an animation's clothes; prefer a fixed-width slot or, as here, move the signal
onto something that was already there.

Everything else that needs to say "working" says it in words, and the words are
true (see [status honesty](#status-honesty)).

**Watch for:** `animate-pulse`, `animate-spin`, `animate-[…]` with
`infinite`, and any gradient with a moving `background-position`.

#### The rule is "no loop", not "no motion"

Beyond the two stepped loops above, the app's motion is all one-shot or
pointer-driven, which is the distinction to hold when reviewing a new one:

- `.evie-enter` and `.evie-wake` are **one-shot on mount**. They play, they
  finish, they stop. The budget they spend is bounded by how often the element
  mounts, so the question to ask of a new one is not "is it cheap?" but "how
  often does this draw?" — `.evie-wake` is on the mark of a bot being *created*,
  and `AppRail` deliberately seeds its set of known bots on the first render so
  that launching the app does not wake twelve faces at once.
- Streamed text is revealed by a rAF loop, and **the backlog is the clock**.
  The hub coalesces deltas into 50 ms frames to hold the byte budget, so the
  wire delivers slabs; [`smooth-text.ts`](../../packages/ui/src/lib/smooth-text.ts)
  banks them and reveals a backlog-proportional slice per frame, which settles
  at a constant ~200 ms of lag whatever the model's speed. The loop arms when a
  delta lands and stops the moment the backlog drains, the stream finishes, or
  the row unmounts — never re-arming on an empty backlog — so a thread that is
  idle, or merely *between* deltas, schedules nothing. It commits once per
  frame in the one row that is streaming, which is the ceiling this table
  already grants. Reduced motion turns pacing off and the slabs land as they
  arrive.
- The rail's eyes follow the pointer, and **the user's hand is the clock**.
  [`gaze.ts`](../../packages/ui/src/lib/gaze.ts) schedules at most one frame per
  `pointermove` and none at all when the pointer is still or outside the rail,
  so the idle-CPU budget above is untouched: there is no `requestAnimationFrame`
  loop, only a frame per input. It caches each mark's centre and re-reads it
  only on scroll, resize, or a row appearing, so a frame does no layout reads,
  and it selects the nearest three marks with a fixed pair of arrays rather than
  a sort, so a frame allocates nothing either. The easing lives in a CSS
  transition rather than in JS, which is also what walks the eyes home when the
  pointer leaves — and what makes the edge of that three-mark pool a handover
  instead of a snap.

**Watch for:** a `requestAnimationFrame` that re-arms itself unconditionally; a
`getBoundingClientRect` inside a frame callback; `.evie-wake` on a mark that
draws on every navigation.

### 5. Bytes are budgeted before they reach the socket

eve's raw stream re-sends the cumulative text on every delta. Forwarding it
verbatim is the single easiest way to make Evie feel slow, so the hub:

- sends the **suffix** since the last frame, never the cumulative text;
- sends reasoning only to a client that opted into that specific block;
- truncates a tool payload over 8 KiB to head + tail + a blob handle, and the
  rest is fetched over HTTP on expand — never on the RPC socket;
- coalesces on mailbox overflow rather than growing the queue, and downgrades a
  subscriber to `summary` mode after three consecutive overflow windows, telling
  it so it can show a *catching up* chip instead of looking frozen.

**Watch for:** an RPC that returns bytes; a frame built from full item state
rather than ops.

## Status honesty

Not a performance rule, but it fails the same way — quietly, and only under
load. `StatusChip` takes the *state*, not a string, and owns the mapping, so
there is exactly one place that can put the wrong word on a parked turn.

Never "Thinking" while waiting on a person. That is the lying spinner.

## Measuring

Any PR touching the timeline attaches a before/after profile; motion or timing
changes attach a short video. What to actually look at:

- **Performance panel, streaming a long reply.** Expect one commit per frame and
  no long task. A flame chart with 2,000 `TimelineRow` entries per frame means
  mechanism 1 or 2 broke.
- **Performance panel, idle with a thread open.** Expect a flat line. Any
  periodic activity means mechanism 3 broke.
- **Network panel, one streaming turn.** Expect < 40 KB/s sustained. A spike
  proportional to message length means suffix deltas broke.
- **Rendering → Frame Rendering Stats, idle.** Expect no repaints. Any means
  mechanism 4 broke.

The reference machine is whatever the maintainer is on; the limits are absolute,
not relative, because a user's laptop is not the reference machine.
