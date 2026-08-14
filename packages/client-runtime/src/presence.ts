import type { ThreadId } from "@evie/contracts/ids";
import type { EvieClient } from "./client.ts";
import type { EvieStore } from "./store.ts";

/**
 * What this client is looking at.
 *
 * The server needs this for two things it cannot infer: which eve runtimes to
 * keep warm (idle-stop counts "no client attached", not "no traffic"), and
 * which reasoning blocks to include in a frame. Both are the difference between
 * the perf budget being met and being aspirational.
 *
 * Reported on change, coalesced to one call per tick. A user clicking through
 * five threads produces one message, not five, and the tick is a microtask
 * rather than a timer -- an idle client has no timers at all, which is the
 * budget's actual wording.
 */

export interface Presence {
	readonly opened: (threadId: ThreadId) => void;
	readonly closed: (threadId: ThreadId) => void;
	readonly watchReasoning: (
		threadId: ThreadId,
		itemId: string,
		watching: boolean,
	) => void;
}

export function makePresence(client: EvieClient, store: EvieStore): Presence {
	let scheduled = false;

	const flush = () => {
		scheduled = false;
		const openThreads = store.openThreadIds() as readonly ThreadId[];
		void client
			.rpc((c) => c["presence.set"]({ openThreads }))
			.catch(() => {
				// Presence is advisory. A failed report costs a runtime staying warm a
				// few minutes longer, which is not worth surfacing to anyone.
			});
	};

	const schedule = () => {
		if (scheduled) return;
		scheduled = true;
		queueMicrotask(flush);
	};

	return {
		opened: schedule,
		closed: schedule,
		watchReasoning: (threadId, itemId, watching) => {
			void client
				.rpc((c) => c["reasoning.watch"]({ threadId, itemId, watching }))
				.catch(() => {
					// Same: the row falls back to showing the token count, which is the
					// honest state anyway.
				});
		},
	};
}
