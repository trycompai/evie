import type { FileNode } from "@evie/contracts/rpc";

/**
 * One bot's file tree, for the Computer pane.
 *
 * `computer.list` answers one directory and nothing pushes when the bot writes
 * a file, so this is a cache with no stream behind it. The policy that falls
 * out of that: every gesture which reveals a directory re-reads it -- opening
 * the tab, opening a folder -- and closing a folder is how you refresh it.
 * Anything cleverer would be a listing that goes stale the moment it lands and
 * has no way to find out.
 *
 * Pure and synchronous, like `Timeline`: the store owns the RPC. What lives
 * here is the flattening, which is the only part with a decision in it -- rows
 * come out depth-first with the closed subtrees already gone, so the pane maps
 * over one array and never walks a tree.
 */

/** The bot's own directory. Every path the server answers resolves under it. */
export const ROOT = "/";

export interface FileRow {
	readonly path: string;
	readonly name: string;
	readonly kind: "file" | "dir";
	/** Nesting, for the row's indent. The root's own entries are 0. */
	readonly depth: number;
	/** Directories only: false until someone opens it. */
	readonly expanded: boolean;
}

export interface FileTreeSnapshot {
	/** Depth-first, open directories only: exactly the rows the pane draws. */
	readonly rows: readonly FileRow[];
	/**
	 * Whether the root listing has answered.
	 *
	 * "This computer is empty" and "no answer yet" are the same empty array and
	 * mean opposite things -- the same distinction `FleetSnapshot.loaded` draws,
	 * and the same one-frame lie if it is missing.
	 */
	readonly loaded: boolean;
	/** The directory whose last listing failed, so the pane can say which. */
	readonly failed: string | null;
}

export class FileTree {
	readonly #children = new Map<string, readonly FileNode[]>();
	/** The root is always open; it is the pane, not a row. */
	readonly #open = new Set<string>([ROOT]);
	/** Paths with a listing in flight, so a folder clicked twice sends one call. */
	readonly #pending = new Set<string>();
	#failed: string | null = null;

	/**
	 * Cached so `getSnapshot` can be called on every render without allocating,
	 * and invalidated in one place. `useSyncExternalStore` compares by reference
	 * and loops forever if a getter builds a fresh object each call.
	 */
	#snapshot: FileTreeSnapshot | null = null;

	snapshot(): FileTreeSnapshot {
		this.#snapshot ??= {
			rows: flatten(this.#children, this.#open),
			loaded: this.#children.has(ROOT),
			failed: this.#failed,
		};
		return this.#snapshot;
	}

	isOpen(path: string): boolean {
		return this.#open.has(path);
	}

	/** Claims the right to list `path`. False when a request for it is in flight. */
	claim(path: string): boolean {
		if (this.#pending.has(path)) return false;
		this.#pending.add(path);
		return true;
	}

	/**
	 * Shows a directory. Children it was opened with before paint immediately and
	 * the listing replaces them, so re-opening a folder is not a blank moment.
	 */
	open(path: string): void {
		this.#open.add(path);
		this.#invalidate();
	}

	close(path: string): void {
		this.#open.delete(path);
		this.#invalidate();
	}

	/**
	 * A successful listing clears the error, whichever directory failed.
	 *
	 * Not just the one being settled: the banner names a path, but it is the
	 * pane's single error slot, and the read that clears it in practice is the
	 * root re-read fired by every tab reopen and bot switch. Scoping the clear
	 * to `path === failed` left "Could not open /gone." sitting above a
	 * perfectly good listing for the rest of the session -- a stale label, which
	 * is the failure this pane exists to avoid.
	 */
	settle(path: string, nodes: readonly FileNode[]): void {
		this.#pending.delete(path);
		this.#children.set(path, nodes);
		this.#failed = null;
		this.#invalidate();
	}

	/**
	 * A listing that failed. The directory closes again rather than sitting open
	 * and empty, which reads as "nothing in here" -- the one wrong answer.
	 */
	fail(path: string): void {
		this.#pending.delete(path);
		this.#failed = path;
		if (path !== ROOT) this.#open.delete(path);
		this.#invalidate();
	}

	#invalidate() {
		this.#snapshot = null;
	}
}

const flatten = (
	children: ReadonlyMap<string, readonly FileNode[]>,
	open: ReadonlySet<string>,
): readonly FileRow[] => {
	const rows: FileRow[] = [];
	const walk = (path: string, depth: number) => {
		for (const node of children.get(path) ?? []) {
			// Dotfiles are the machinery -- `.eve`, `.git`, `.gitignore` -- and the
			// pane is for the bot's work. Filtered here rather than in `computer.list`
			// so the RPC stays a faithful listing a later "show hidden" can use.
			if (node.name.startsWith(".")) continue;
			const expanded = node.kind === "dir" && open.has(node.path);
			rows.push({
				path: node.path,
				name: node.name,
				kind: node.kind,
				depth,
				expanded,
			});
			if (expanded) walk(node.path, depth + 1);
		}
	};
	walk(ROOT, 0);
	return rows;
};
