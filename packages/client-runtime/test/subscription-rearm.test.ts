import type { ThreadId } from "@evie/contracts/ids";
import type { TimelineFrame } from "@evie/contracts/timeline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvieClient } from "../src/client.ts";
import { EvieStore } from "../src/store.ts";

/**
 * A subscription that dies has to put itself back up.
 *
 * This is the client half of a real outage: the server sent one frame this
 * build could not decode, the thread stream died as a defect, and every later
 * frame -- including the assistant's entire reply -- went nowhere. Nothing in
 * the UI said so. The thread simply stopped moving, and reloading the page
 * "fixed" it, which is the worst possible shape for a bug.
 *
 * The server-side cause is fixed; this is the guard that says one bad frame
 * costs a beat rather than the rest of the conversation.
 */

const threadId = "01M01C46ZKX9GT28EFXEEK73ME" as ThreadId;

const item = (id: string, seq: number) =>
	({
		kind: "user",
		id,
		threadId,
		seq,
		at: 1,
		authorId: "user_1",
		parts: [{ type: "text", text: id }],
	}) as never;

const harness = () => {
	const subscribes: Array<{ since: number | undefined }> = [];
	let push: ((frame: TimelineFrame) => void) | null = null;
	let end: (() => void) | null = null;

	const client = {
		rpc: () => Promise.resolve({ items: [], nextBefore: null }),
		stream: (
			f: (client: unknown) => unknown,
			onValue: (frame: TimelineFrame) => void,
			onEnd?: () => void,
		) => {
			// Capture the payload the store asked for: the resume cursor is the
			// half that makes re-arming a recovery rather than a reconnect.
			const captured: Array<{ since?: number }> = [];
			f({
				"threads.subscribe": (payload: { since?: number }) => {
					captured.push(payload);
					return null;
				},
				"fleet.subscribe": () => null,
			});
			subscribes.push({ since: captured[0]?.since });
			push = onValue;
			end = onEnd ?? null;
			return () => {};
		},
		close: () => Promise.resolve(),
	} as unknown as EvieClient;

	const store = new EvieStore(() => client);
	return {
		store,
		subscribes,
		frame: (frame: TimelineFrame) => push?.(frame),
		die: () => end?.(),
	};
};

const frameWith = (seq: number, id: string): TimelineFrame => ({
	threadId,
	ops: [{ op: "insert", item: item(id, seq) }],
	seq,
	mode: "full",
});

describe("a thread subscription that ends on its own", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("re-arms from the last seq it applied", async () => {
		const h = harness();
		await h.store.openThread(threadId);
		expect(h.subscribes).toHaveLength(1);

		h.frame(frameWith(7, "item_a"));
		h.die();

		// Not instantly: an immediate retry against a server that just failed is
		// how one bad frame becomes a hot loop.
		expect(h.subscribes).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1_000);

		expect(h.subscribes).toHaveLength(2);
		// Resumed from what this client actually applied, so the hub backfills
		// the rows the dead stream never delivered.
		expect(h.subscribes[1]?.since).toBe(7);
	});

	it("backs off, so a permanently broken stream stays cheap", async () => {
		const h = harness();
		await h.store.openThread(threadId);

		// The first wait is short; each failure without a frame in between
		// doubles it, so a stream that can never succeed costs one request per
		// 15 seconds instead of one per tick.
		h.die();
		await vi.advanceTimersByTimeAsync(400);
		expect(h.subscribes).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(200);
		expect(h.subscribes).toHaveLength(2);

		h.die();
		await vi.advanceTimersByTimeAsync(900);
		expect(h.subscribes).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(200);
		expect(h.subscribes).toHaveLength(3);

		for (let attempt = 0; attempt < 8; attempt++) {
			h.die();
			await vi.advanceTimersByTimeAsync(15_000);
		}
		// Capped: still re-arming, still bounded.
		expect(h.subscribes).toHaveLength(11);
	});

	it("stops re-arming once the thread is closed", async () => {
		const h = harness();
		await h.store.openThread(threadId);
		h.die();
		h.store.closeThread(threadId);

		await vi.advanceTimersByTimeAsync(60_000);
		expect(h.subscribes).toHaveLength(1);
		expect(h.store.openThreadIds()).toEqual([]);
	});

	it("keeps the thread open while it waits, so presence stays honest", async () => {
		const h = harness();
		await h.store.openThread(threadId);
		h.die();

		expect(h.store.openThreadIds()).toEqual([threadId]);
	});

	it("resets the delay once frames flow again", async () => {
		const h = harness();
		await h.store.openThread(threadId);

		h.die();
		await vi.advanceTimersByTimeAsync(60_000);
		h.frame(frameWith(3, "item_b"));
		h.die();

		// Back to the first, shortest wait rather than the escalated one: 600ms
		// is enough only if the delay reset.
		await vi.advanceTimersByTimeAsync(600);
		expect(h.subscribes).toHaveLength(3);
	});
});
