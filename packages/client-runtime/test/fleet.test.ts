import type { Bot } from "@evie/contracts/bot";
import type { BotId, ThreadId } from "@evie/contracts/ids";
import type { FleetFrame } from "@evie/contracts/rpc";
import type { Thread } from "@evie/contracts/thread";
import { describe, expect, it } from "vitest";
import type { EvieClient } from "../src/client.ts";
import { EvieStore } from "../src/store.ts";

/**
 * The fleet stream is a delta stream: the opening frame is a snapshot and every
 * frame after it carries only what that event touched (`drainFleet`, in the
 * server's hub). Applying one of those deltas as if it were a snapshot deletes
 * everything it did not mention, and the shape of that bug is nasty -- the rail
 * still lists the conversation, it just cannot draw it, because the bot that
 * owns it is no longer in the fleet.
 */

const bot = (id: string, archivedAt: number | null = null): Bot =>
	({ id: id as BotId, name: id, archivedAt }) as Bot;

const thread = (id: string, lastActivity: number): Thread =>
	({ id: id as ThreadId, lastActivity }) as Thread;

/** A client that hands us the fleet stream's callback so a test can drive frames. */
const harness = () => {
	let push: ((frame: FleetFrame) => void) | null = null;
	const client = {
		rpc: () => Promise.reject(new Error("no rpc in this test")),
		stream: (_f: unknown, onValue: (frame: FleetFrame) => void) => {
			push = onValue;
			return () => {};
		},
		close: () => Promise.resolve(),
	} as unknown as EvieClient;

	const store = new EvieStore(() => client);
	store.watchFleet();
	return {
		store,
		frame: (frame: FleetFrame) => {
			if (push === null) throw new Error("fleet stream was never opened");
			push(frame);
		},
	};
};

const botIds = (store: EvieStore) => store.getFleet().bots.map((b) => b.id as string);

describe("fleet frames", () => {
	it("keeps the bots a delta frame did not mention", () => {
		const { store, frame } = harness();
		frame({ bots: [bot("bot_a"), bot("bot_b")], threads: [thread("thr_a", 1)] });

		// Making a bot publishes only that bot. This is the reported bug: bot_a
		// and bot_b used to disappear here, and thr_a became undrawable.
		frame({ bots: [bot("bot_c")], threads: [thread("thr_c", 2)] });

		expect(botIds(store)).toEqual(["bot_a", "bot_b", "bot_c"]);
		expect(store.getFleet().threads.map((t) => t.id as string)).toEqual([
			"thr_c",
			"thr_a",
		]);
	});

	it("updates a bot in place rather than appending it twice", () => {
		const { store, frame } = harness();
		frame({ bots: [bot("bot_a"), bot("bot_b")] });
		frame({ bots: [{ ...bot("bot_a"), name: "renamed" } as Bot] });

		expect(botIds(store)).toEqual(["bot_a", "bot_b"]);
		expect(store.getFleet().bots[0]?.name).toBe("renamed");
	});

	it("drops a bot once it is archived", () => {
		const { store, frame } = harness();
		frame({ bots: [bot("bot_a"), bot("bot_b")] });
		frame({ bots: [bot("bot_a", 1_700_000_000_000)] });

		expect(botIds(store)).toEqual(["bot_b"]);
	});

	it("leaves the fleet alone when a frame carries no bots at all", () => {
		const { store, frame } = harness();
		frame({ bots: [bot("bot_a")] });
		frame({ threads: [thread("thr_a", 1)] });

		expect(botIds(store)).toEqual(["bot_a"]);
	});

	it("reports itself unloaded until the first frame", () => {
		const { store, frame } = harness();
		expect(store.getFleet().loaded).toBe(false);
		frame({ bots: [] });
		expect(store.getFleet().loaded).toBe(true);
	});
});
