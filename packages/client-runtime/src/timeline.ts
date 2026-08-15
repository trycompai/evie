import type { ThreadStatus } from "@evie/contracts/thread";
import type {
	Part,
	TimelineFrame,
	TimelineItem,
} from "@evie/contracts/timeline";

/**
 * Applying frames to a thread.
 *
 * The whole performance story of the chat view lives in this file, and it comes
 * down to one rule: **a frame must change the identity of exactly the items it
 * touched, and nothing else.**
 *
 * Rows above the streaming one keep their object identity, so `TimelineRow`'s
 * `memo` skips them and React reconciles one row per frame instead of two
 * thousand. The moment something here rebuilds the map or the item array
 * wholesale, the app stops meeting its budget and it stops looking like
 * anything is wrong -- it just gets slow with a thread open.
 */

export interface TimelineSnapshot {
	/** Item ids in `seq` order. Replaced only when the SET changes, never on a delta. */
	readonly order: readonly string[];
	readonly status: ThreadStatus;
	readonly mode: "full" | "summary";
	/** Highest `seq` applied. What a reconnect resumes from. */
	readonly lastSeq: number;
	/**
	 * The item currently receiving deltas, or null.
	 *
	 * Taken from the deltas themselves -- `appendText`/`appendReasoning` name the
	 * item they extend -- rather than guessed from the tail of `order`, which is
	 * a tool row as often as it is a reply. Null in `summary` mode, where no
	 * deltas arrive and there is nothing honest to point at.
	 */
	readonly streamingId: string | null;
}

export interface ApplyResult {
	/** Ids whose object identity changed. The store notifies exactly these rows. */
	readonly changed: readonly string[];
	/** True when the set of ids or the thread-level state changed. */
	readonly threadChanged: boolean;
}

const READY: ThreadStatus = { kind: "ready" };

export class Timeline {
	readonly #items = new Map<string, TimelineItem>();
	#order: string[] = [];
	#status: ThreadStatus = READY;
	#mode: "full" | "summary" = "full";
	#lastSeq = 0;
	#streamingId: string | null = null;

	/**
	 * Cached so `getSnapshot` can be called on every render without allocating.
	 * `useSyncExternalStore` compares snapshots by reference and loops forever if
	 * a getter builds a fresh object each call -- it is the single easiest way to
	 * get this wrong, so the cache is invalidated in exactly one place.
	 */
	#snapshot: TimelineSnapshot | null = null;

	get(id: string): TimelineItem | undefined {
		return this.#items.get(id);
	}

	snapshot(): TimelineSnapshot {
		this.#snapshot ??= {
			order: this.#order,
			status: this.#status,
			mode: this.#mode,
			lastSeq: this.#lastSeq,
			streamingId: this.#streamingId,
		};
		return this.#snapshot;
	}

	/**
	 * The unfinished reply in the current turn, for the case deltas cannot cover:
	 * a client that opened or reconnected mid-turn has the rows but has seen none
	 * of the chunks that built them.
	 *
	 * Bounded to the current turn -- the scan stops at the user row that started
	 * it -- so a turn that runs fifty tools without narrating never walks the
	 * thread looking for a reply that is not there, and a reply left unfinished
	 * by an older turn is never mistaken for a live one.
	 */
	#unfinishedReply(): string | null {
		for (let i = this.#order.length - 1; i >= 0; i--) {
			const item = this.#items.get(this.#order[i] as string);
			if (item?.kind === "user") return null;
			if (item?.kind === "assistant") {
				return item.finishReason === undefined ? item.id : null;
			}
		}
		return null;
	}

	#invalidate() {
		this.#snapshot = null;
	}

	/**
	 * Seeds from `threads.timeline`, on open and on scroll-back.
	 *
	 * Merges rather than appends, and re-sorts by `seq`. Both matter, and both
	 * only bite in the overlap case:
	 *
	 *   - a page fetched while a frame was in flight legitimately contains rows
	 *     already applied, and appending puts the same id in `order` twice --
	 *     which renders as the conversation appearing duplicated;
	 *   - a page whose rows are *older* than what is already applied has to land
	 *     before them, and "prepend when the caller says so" gets that wrong the
	 *     moment the two overlap.
	 *
	 * Sorting handles both without the caller having to know which case it is in.
	 * This is not the hot path -- it runs on open and on scroll-back, never on a
	 * delta -- so a sort over the whole thread costs nothing worth optimising.
	 */
	hydrate(items: readonly TimelineItem[]): void {
		if (items.length === 0) return;
		for (const item of items) {
			this.#items.set(item.id, item);
			if (item.seq > this.#lastSeq) this.#lastSeq = item.seq;
		}
		this.#order = [...this.#items.values()].sort(bySeq).map((item) => item.id);
		this.#invalidate();
	}

	apply(frame: TimelineFrame): ApplyResult {
		const changed: string[] = [];
		let inserted = false;
		// Deltas name the row they extend, so the streaming row is read rather
		// than inferred. Reset per frame only where the ops say so.
		let streaming = this.#streamingId;

		for (const op of frame.ops) {
			switch (op.op) {
				case "insert": {
					// A resumed stream can replay frames we already applied -- overlap is
					// harmless by design, so an insert of a known id is an update.
					if (!this.#items.has(op.item.id)) inserted = true;
					this.#items.set(op.item.id, op.item);
					changed.push(op.item.id);
					break;
				}
				case "replace": {
					if (!this.#items.has(op.item.id)) inserted = true;
					this.#items.set(op.item.id, op.item);
					changed.push(op.item.id);
					break;
				}
				case "appendText": {
					const next = appendText(
						this.#items.get(op.id),
						op.partIndex,
						op.chunk,
					);
					if (next) {
						this.#items.set(op.id, next);
						changed.push(op.id);
						streaming = op.id;
					}
					break;
				}
				case "appendReasoning": {
					const next = appendReasoning(
						this.#items.get(op.id),
						op.partIndex,
						op.tokens,
						op.chunk,
					);
					if (next) {
						this.#items.set(op.id, next);
						changed.push(op.id);
						streaming = op.id;
					}
					break;
				}
			}
		}

		if (inserted) {
			// Rebuilding the order only when the set changed is what keeps a
			// streaming turn from re-sorting two thousand ids twenty times a second.
			this.#order = [...this.#items.values()].sort(bySeq).map((i) => i.id);
		}

		const statusChanged =
			frame.status !== undefined && frame.status !== this.#status;
		if (frame.status !== undefined) this.#status = frame.status;
		const modeChanged = frame.mode !== this.#mode;
		this.#mode = frame.mode;
		if (frame.seq > this.#lastSeq) this.#lastSeq = frame.seq;

		/*
		 * A reply stops streaming when it says so -- eve stamps `finishReason` on
		 * the terminal version of the row -- or when the turn leaves an in-flight
		 * state, which covers cancel, error, and a provider that dies mid-sentence
		 * without ever finishing the row.
		 */
		if (!live(this.#status)) streaming = null;
		else {
			const item = streaming ? this.#items.get(streaming) : undefined;
			if (
				item === undefined ||
				(item.kind === "assistant" && item.finishReason !== undefined)
			) {
				streaming = this.#unfinishedReply();
			}
		}
		const streamingChanged = streaming !== this.#streamingId;
		this.#streamingId = streaming;

		/*
		 * `threadChanged` is what re-renders the timeline container, and the caret
		 * has to be in it: a reply finishes via `replace` of a row that is already
		 * known, a frame that inserts nothing, so leaving it out leaves a caret
		 * blinking under a finished reply until the next message arrives.
		 */
		const threadChanged =
			inserted || statusChanged || modeChanged || streamingChanged;
		if (threadChanged) this.#invalidate();

		return { changed, threadChanged };
	}
}

/** A turn is in flight. The two states that can be producing a reply. */
const live = (status: ThreadStatus) =>
	status.kind === "thinking" || status.kind === "running";

const bySeq = (a: TimelineItem, b: TimelineItem) => a.seq - b.seq;

/**
 * Copies one part and one parts array; everything else in the item is shared.
 * That is the allocation budget for a streaming delta and it should stay there.
 */
const appendText = (
	item: TimelineItem | undefined,
	index: number,
	chunk: string,
): TimelineItem | undefined => {
	if (!item || !("parts" in item)) return undefined;
	const part = item.parts[index];
	if (!part || part.type !== "text") return undefined;
	const parts = item.parts.slice();
	parts[index] = { type: "text", text: part.text + chunk };
	return { ...item, parts } as TimelineItem;
};

const appendReasoning = (
	item: TimelineItem | undefined,
	index: number,
	tokens: number,
	chunk: string | undefined,
): TimelineItem | undefined => {
	if (!item || !("parts" in item)) return undefined;
	const part = item.parts[index];
	if (!part || part.type !== "reasoning") return undefined;
	const parts: Part[] = item.parts.slice();
	parts[index] = {
		type: "reasoning",
		tokens,
		// `text` accumulates only while this client is watching the block. When it
		// is not, the count still advances -- which is the whole contract: the
		// count persists, the words do not.
		...(chunk !== undefined
			? { text: (part.text ?? "") + chunk }
			: part.text !== undefined
				? { text: part.text }
				: {}),
	};
	return { ...item, parts } as TimelineItem;
};
