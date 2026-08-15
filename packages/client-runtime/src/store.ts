import type { Bot } from "@evie/contracts/bot";
import type { BotId, ThreadId } from "@evie/contracts/ids";
import type { SessionInfo } from "@evie/contracts/org";
import type { Thread } from "@evie/contracts/thread";
import type { TimelineItem } from "@evie/contracts/timeline";
import type { ConnectionState, EvieClient } from "./client.ts";
import { FileTree, ROOT, type FileTreeSnapshot } from "./files.ts";
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
	/**
	 * Whether the fleet stream has delivered a frame.
	 *
	 * "No bots" and "no answer yet" are the same empty array and mean opposite
	 * things: the first is a new account that should see onboarding, the second
	 * is every account for the first few milliseconds after a reload. A client
	 * that cannot tell them apart shows onboarding to everyone and then takes it
	 * away again.
	 */
	readonly loaded: boolean;
}

const EMPTY_FLEET: FleetSnapshot = { bots: [], threads: [], loaded: false };

/** How long a subscription that ended on its own waits before re-arming. */
const REARM_MIN_MS = 500;
const REARM_MAX_MS = 15_000;

export class EvieStore {
	/** Exposed so command senders and presence can share the one connection. */
	readonly client: EvieClient;

	#connection: ConnectionState = { kind: "connecting" };
	#session: SessionInfo | null = null;
	#fleet: FleetSnapshot = EMPTY_FLEET;

	readonly #timelines = new Map<string, Timeline>();
	readonly #fileTrees = new Map<string, FileTree>();
	/** Unsubscribe per open thread. Presence and idle-stop follow this map's keys. */
	readonly #subscriptions = new Map<string, () => void>();
	/** Current backoff per subscription that ended on its own. See `#open`. */
	readonly #rearmDelays = new Map<string, number>();

	readonly #connectionListeners = new Set<Listener>();
	readonly #fleetListeners = new Set<Listener>();
	readonly #threadListeners = new Map<string, Set<Listener>>();
	readonly #itemListeners = new Map<string, Set<Listener>>();
	readonly #fileListeners = new Map<string, Set<Listener>>();

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

	/**
	 * The fleet, once the server has actually answered.
	 *
	 * Resolves synchronously-ish when a frame has already landed, and on the
	 * first frame otherwise. This exists so a route can *await* the fleet in
	 * `beforeLoad` instead of a component rendering a guess and correcting it:
	 * "which screen does a new window open on" is unanswerable until the bots
	 * are known, and answering it early is how an account with a dozen bots got
	 * shown the welcome screen. See `FleetSnapshot.loaded`.
	 *
	 * Never rejects. A fleet that never arrives leaves this pending, which is
	 * the honest outcome -- the connection layer owns surfacing that.
	 */
	whenFleetLoaded = (): Promise<FleetSnapshot> => {
		if (this.#fleet.loaded) return Promise.resolve(this.#fleet);
		return new Promise((resolve) => {
			const stop = this.subscribeFleet(() => {
				if (!this.#fleet.loaded) return;
				stop();
				resolve(this.#fleet);
			});
		});
	};

	/** Starts the one fleet-level stream. Idempotent; safe to call after a reconnect. */
	watchFleet(): void {
		if (this.#subscriptions.has("@fleet")) return;
		this.#open("@fleet", (onEnd) =>
			this.client.stream(
				(client) => client["fleet.subscribe"](),
				(frame) => {
					this.#settled("@fleet");
					this.#fleet = {
						bots: mergeBots(this.#fleet.bots, frame.bots),
						threads: mergeThreads(
							this.#fleet.threads,
							frame.threads,
							frame.removedThreads,
						),
						loaded: true,
					};
					notify(this.#fleetListeners);
				},
				onEnd,
			),
		);
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
		this.#rearmDelays.delete(threadId);
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
		this.#open(threadId, (onEnd) =>
			this.client.stream(
				(client) =>
					client["threads.subscribe"]({
						threadId,
						// Read at open, not at #watch: a re-arm resumes from what this
						// client has actually applied, so the gap is backfilled.
						since: timeline.snapshot().lastSeq,
					}),
				(frame) => {
					this.#settled(threadId);
					const result = timeline.apply(frame);
					// Rows first, then the container. A row that re-renders after its
					// container has already committed produces a visible one-frame stale
					// paint at the bottom of the list.
					for (const id of result.changed)
						notify(this.#itemListeners.get(`${threadId}/${id}`));
					if (result.threadChanged) notify(this.#threadListeners.get(threadId));
				},
				onEnd,
			),
		);
	}

	/**
	 * Opens a subscription that puts itself back up.
	 *
	 * A stream that ends without being told to is a bug upstream -- a frame this
	 * build cannot decode, a handler that died -- and the client cannot see
	 * which. What it can see is that leaving it dead costs the user everything
	 * that happens next: the thread stops moving mid-turn, nothing says so, and
	 * reloading the page "fixes" it. So a subscription re-arms from its own
	 * cursor, exactly as it does after a dropped socket, and backs off to a
	 * request every 15 seconds so a permanently poisoned stream stays cheap.
	 * Each re-arm resumes from `lastSeq`, so recovery pulls the missed rows out
	 * of the read model rather than waiting for the next live delta.
	 */
	#open(key: string, subscribe: (onEnd: () => void) => () => void): void {
		// The slot is claimed before the stream opens: a stream that fails
		// immediately calls back before `subscribe` has returned.
		let stop = () => {};
		this.#subscriptions.set(key, () => stop());
		stop = subscribe(() => this.#rearm(key));
	}

	#rearm(key: string): void {
		const delay = Math.min(
			REARM_MAX_MS,
			(this.#rearmDelays.get(key) ?? REARM_MIN_MS / 2) * 2,
		);
		this.#rearmDelays.set(key, delay);
		const timer = setTimeout(() => {
			// Only if nobody closed or replaced this subscription while we waited.
			if (this.#subscriptions.get(key) !== cancel) return;
			this.#subscriptions.delete(key);
			if (key === "@fleet") this.watchFleet();
			else this.#watch(key as ThreadId);
		}, delay);
		const cancel = () => clearTimeout(timer);
		this.#subscriptions.set(key, cancel);
	}

	/** A frame arrived, so whatever went wrong is over. */
	#settled(key: string): void {
		this.#rearmDelays.delete(key);
	}

	#timeline(threadId: ThreadId): Timeline {
		let timeline = this.#timelines.get(threadId);
		if (!timeline) {
			timeline = new Timeline();
			this.#timelines.set(threadId, timeline);
		}
		return timeline;
	}

	/* --- files ------------------------------------------------------------ */

	subscribeFiles = (botId: BotId) => (listener: Listener) => {
		let set = this.#fileListeners.get(botId);
		if (!set) {
			set = new Set();
			this.#fileListeners.set(botId, set);
		}
		set.add(listener);
		return () => set.delete(listener);
	};

	getFilesSnapshot = (botId: BotId): FileTreeSnapshot =>
		this.#fileTree(botId).snapshot();

	/**
	 * Lists the bot's own directory: what the Computer pane opens on.
	 *
	 * Re-reads every time it is called rather than answering from the cache. A
	 * bot writes files while you are looking at them and nothing pushes when it
	 * does, so the only listing worth showing is the one taken when you asked.
	 */
	browseFiles(botId: BotId): Promise<void> {
		return this.#list(botId, ROOT);
	}

	/** Opens or closes one directory. Opening re-reads it; closing is free. */
	toggleDirectory(botId: BotId, path: string): Promise<void> {
		const tree = this.#fileTree(botId);
		if (tree.isOpen(path)) {
			tree.close(path);
			notify(this.#fileListeners.get(botId));
			return Promise.resolve();
		}
		// Opened first, so a folder you have seen before paints its old children
		// on the click rather than after the round trip.
		tree.open(path);
		notify(this.#fileListeners.get(botId));
		return this.#list(botId, path);
	}

	async #list(botId: BotId, path: string): Promise<void> {
		const tree = this.#fileTree(botId);
		if (!tree.claim(path)) return;
		try {
			const nodes = await this.client.rpc((client) =>
				client["computer.list"]({ botId, path }),
			);
			tree.settle(path, nodes);
		} catch {
			// Which path failed is the whole message; the pane names it. There is
			// nothing here to retry -- the next click re-reads.
			tree.fail(path);
		}
		notify(this.#fileListeners.get(botId));
	}

	#fileTree(botId: BotId): FileTree {
		let tree = this.#fileTrees.get(botId);
		if (!tree) {
			tree = new FileTree();
			this.#fileTrees.set(botId, tree);
		}
		return tree;
	}

	dispose(): void {
		for (const stop of this.#subscriptions.values()) stop();
		this.#subscriptions.clear();
	}
}

/**
 * Bots, merged the same way threads are, and for the same reason: a live frame
 * carries only what moved (`drainFleet` in the server's hub), so assigning
 * `frame.bots` over the list deletes every bot that did not change in that
 * event. Making one bot was enough to make every other bot vanish, which the
 * UI shows as a conversation it can no longer draw -- the thread is right
 * there in the rail and its owner is gone.
 *
 * Removal rides on `archivedAt` rather than a `removedBots` list, because the
 * projector publishes the archived row itself and `archivedAt` is exactly the
 * filter the opening snapshot applies. Archiving a bot therefore takes it out
 * of the fleet here, the same as it never having been sent.
 */
const mergeBots = (
	current: readonly Bot[],
	incoming: readonly Bot[] | undefined,
): readonly Bot[] => {
	if (!incoming) return current;
	const byId = new Map(current.map((b) => [b.id as string, b]));
	for (const bot of incoming) {
		if (bot.archivedAt === null) byId.set(bot.id, bot);
		else byId.delete(bot.id);
	}
	return [...byId.values()];
};

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
