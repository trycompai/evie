import type { Bot } from "@evie/contracts/bot";
import type { ThreadId } from "@evie/contracts/ids";
import type { SessionInfo } from "@evie/contracts/org";
import type { Thread } from "@evie/contracts/thread";
import type { TimelineItem } from "@evie/contracts/timeline";
import type { ConnectionState, EvieClient } from "./client.ts";
import { Timeline, type TimelineSnapshot } from "./timeline.ts";

/**
 * The client's whole data layer.
 *
 * An external store consumed with `useSyncExternalStore`, not React state. That
 * is not a stylistic choice:
 *
 *   - it is the correct primitive for an external, mutable, server-owned source;
 *   - React commits once per batch rather than once per delta;
 *   - and it makes the no-`useEffect` rule easy to honour, because component
 *     state never holds server state, so there is no effect that "syncs" one
 *     into the other.
 *
 * **Subscribe per row, not per thread.** A thread-level subscription re-renders
 * the list container on every 50 ms frame, so a 2,000-row thread runs 2,000
 * memo comparisons twenty times a second to discover that one row changed.
 * `subscribeItem` is why the streaming row is the only thing React touches.
 */

type Listener = () => void;

const notify = (set: Set<Listener> | undefined) => {
	if (!set) return;
	for (const listener of set) listener();
};

export interface FleetSnapshot {
	readonly bots: readonly Bot[];
	readonly threads: readonly Thread[];
}

const EMPTY_FLEET: FleetSnapshot = { bots: [], threads: [] };

export class EvieStore {
	/** Exposed so command senders and presence can share the one connection. */
	readonly client: EvieClient;

	#connection: ConnectionState = { kind: "connecting" };
	#session: SessionInfo | null = null;
	#fleet: FleetSnapshot = EMPTY_FLEET;

	readonly #timelines = new Map<string, Timeline>();
	/** Unsubscribe per open thread. Presence and idle-stop follow this map's keys. */
	readonly #subscriptions = new Map<string, () => void>();

	readonly #connectionListeners = new Set<Listener>();
	readonly #fleetListeners = new Set<Listener>();
	readonly #threadListeners = new Map<string, Set<Listener>>();
	readonly #itemListeners = new Map<string, Set<Listener>>();

	/**
	 * Takes a client *factory*, not a client.
	 *
	 * The client needs an `onState` callback and the callback needs the store, so
	 * building them side by side means a `let` and a moment where one of them is
	 * undefined. Handing the store the factory closes the loop: the store owns
	 * the connection's lifecycle, which it already half did through `dispose`.
	 */
	constructor(
		makeClient: (onState: (state: ConnectionState) => void) => EvieClient,
	) {
		this.client = makeClient((state) => {
			this.#connection = state;
			if (state.kind === "ready") {
				this.#session = state.session;
				// The socket layer restores the transport; only the store knows where
				// in each stream this client had got to.
				this.resumeAll();
			}
			notify(this.#connectionListeners);
		});
	}

	/* --- connection ------------------------------------------------------- */

	subscribeConnection = (listener: Listener): (() => void) => {
		this.#connectionListeners.add(listener);
		return () => this.#connectionListeners.delete(listener);
	};

	getConnection = (): ConnectionState => this.#connection;
	getSession = (): SessionInfo | null => this.#session;

	/* --- fleet ------------------------------------------------------------ */

	subscribeFleet = (listener: Listener): (() => void) => {
		this.#fleetListeners.add(listener);
		return () => this.#fleetListeners.delete(listener);
	};

	getFleet = (): FleetSnapshot => this.#fleet;

	/** Starts the one fleet-level stream. Idempotent; safe to call after a reconnect. */
	watchFleet(): void {
		if (this.#subscriptions.has("@fleet")) return;
		const stop = this.client.stream(
			(client) => client["fleet.subscribe"](),
			(frame) => {
				this.#fleet = {
					bots: frame.bots ?? this.#fleet.bots,
					threads: mergeThreads(
						this.#fleet.threads,
						frame.threads,
						frame.removedThreads,
					),
				};
				notify(this.#fleetListeners);
			},
		);
		this.#subscriptions.set("@fleet", stop);
	}

	/* --- threads ---------------------------------------------------------- */

	subscribeThread = (threadId: ThreadId) => (listener: Listener) => {
		let set = this.#threadListeners.get(threadId);
		if (!set) {
			set = new Set();
			this.#threadListeners.set(threadId, set);
		}
		set.add(listener);
		return () => set.delete(listener);
	};

	getThreadSnapshot = (threadId: ThreadId): TimelineSnapshot =>
		this.#timeline(threadId).snapshot();

	/**
	 * Per-row subscription. The key is `thread/item` rather than a nested map
	 * because a row's lifetime is shorter than a thread's and a flat map makes
	 * removal on unmount a single delete.
	 */
	subscribeItem =
		(threadId: ThreadId, itemId: string) => (listener: Listener) => {
			const key = `${threadId}/${itemId}`;
			let set = this.#itemListeners.get(key);
			if (!set) {
				set = new Set();
				this.#itemListeners.set(key, set);
			}
			set.add(listener);
			return () => {
				set.delete(listener);
				if (set.size === 0) this.#itemListeners.delete(key);
			};
		};

	getItemSnapshot = (
		threadId: ThreadId,
		itemId: string,
	): TimelineItem | undefined => this.#timeline(threadId).get(itemId);

	/**
	 * Opens a thread: fetch a page of history, then subscribe from where that
	 * page ended. Fetch-then-subscribe rather than the reverse would drop
	 * everything that happened in between; subscribing first and reconciling by
	 * `seq` is why the order is this way round.
	 */
	async openThread(threadId: ThreadId, limit = 60): Promise<void> {
		// Idempotent. Clicking a rail row twice is normal, and the naive version
		// hydrates twice and puts every id in `order` a second time -- which shows
		// up as the whole conversation appearing duplicated, not as a store bug.
		if (this.#subscriptions.has(threadId)) return;

		const timeline = this.#timeline(threadId);
		const page = await this.client.rpc((client) =>
			client["threads.timeline"]({ threadId, limit }),
		);
		timeline.hydrate(page.items);
		notify(this.#threadListeners.get(threadId));
		this.#watch(threadId);
	}

	/**
	 * Older history, for scroll-back. Merged by `seq`, so it lands above what is
	 * on screen even when the page overlaps it. Resolves to whether there is more.
	 */
	async loadMore(
		threadId: ThreadId,
		before: number,
		limit = 60,
	): Promise<boolean> {
		const page = await this.client.rpc((client) =>
			client["threads.timeline"]({ threadId, before, limit }),
		);
		if (page.items.length === 0) return false;
		this.#timeline(threadId).hydrate(page.items);
		notify(this.#threadListeners.get(threadId));
		return page.nextBefore !== null;
	}

	closeThread(threadId: ThreadId): void {
		this.#subscriptions.get(threadId)?.();
		this.#subscriptions.delete(threadId);
	}

	/** Threads this client currently has open. Drives `presence.set` and idle-stop. */
	openThreadIds(): readonly ThreadId[] {
		return [...this.#subscriptions.keys()].filter(
			(k) => k !== "@fleet",
		) as ThreadId[];
	}

	/**
	 * Re-arms every subscription from its own cursor after the socket comes back.
	 * The transport layer restores the connection; only the store knows where in
	 * each stream this client had got to.
	 */
	resumeAll(): void {
		const open = this.openThreadIds();
		for (const threadId of open) {
			this.#subscriptions.get(threadId)?.();
			this.#subscriptions.delete(threadId);
			this.#watch(threadId);
		}
		// Stop the old fleet stream before starting a new one. Dropping the key
		// without calling its unsubscribe leaks the fiber, and after enough
		// reconnects every fleet frame is applied N times.
		this.#subscriptions.get("@fleet")?.();
		this.#subscriptions.delete("@fleet");
		this.watchFleet();
	}

	#watch(threadId: ThreadId): void {
		if (this.#subscriptions.has(threadId)) return;
		const timeline = this.#timeline(threadId);
		const stop = this.client.stream(
			(client) =>
				client["threads.subscribe"]({
					threadId,
					since: timeline.snapshot().lastSeq,
				}),
			(frame) => {
				const result = timeline.apply(frame);
				// Rows first, then the container. A row that re-renders after its
				// container has already committed produces a visible one-frame stale
				// paint at the bottom of the list.
				for (const id of result.changed)
					notify(this.#itemListeners.get(`${threadId}/${id}`));
				if (result.threadChanged) notify(this.#threadListeners.get(threadId));
			},
		);
		this.#subscriptions.set(threadId, stop);
	}

	#timeline(threadId: ThreadId): Timeline {
		let timeline = this.#timelines.get(threadId);
		if (!timeline) {
			timeline = new Timeline();
			this.#timelines.set(threadId, timeline);
		}
		return timeline;
	}

	dispose(): void {
		for (const stop of this.#subscriptions.values()) stop();
		this.#subscriptions.clear();
	}
}

/**
 * Fleet frames carry only what moved. Merging by id keeps the rail's rows
 * referentially stable so a bot going busy does not re-render every other row.
 */
const mergeThreads = (
	current: readonly Thread[],
	incoming: readonly Thread[] | undefined,
	removed: readonly string[] | undefined,
): readonly Thread[] => {
	if (!incoming && !removed) return current;
	const byId = new Map(current.map((t) => [t.id as string, t]));
	for (const thread of incoming ?? []) byId.set(thread.id, thread);
	for (const id of removed ?? []) byId.delete(id);
	return [...byId.values()].sort((a, b) => b.lastActivity - a.lastActivity);
};
