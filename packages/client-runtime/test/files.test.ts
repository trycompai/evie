import type { BotId } from "@evie/contracts/ids";
import type { FileNode } from "@evie/contracts/rpc";
import { describe, expect, it } from "vitest";
import type { EvieClient } from "../src/client.ts";
import { FileTree, ROOT } from "../src/files.ts";
import { EvieStore } from "../src/store.ts";

/**
 * The Computer pane's file tree.
 *
 * `computer.list` answers one directory, so what the store owns is the tree
 * built out of several answers: which of them are showing, what order the rows
 * come out in, and what happens when one of the calls fails. All three are
 * invisible from a single call and all three are what the pane draws.
 */

const bot = "bot_a" as BotId;

const dir = (path: string, name: string): FileNode => ({ path, name, kind: "dir" });
const file = (path: string, name: string): FileNode => ({ path, name, kind: "file" });

/** Stands in for the generated client: hands the thunk back its own payload. */
type Thunk = (client: {
	readonly "computer.list": (payload: { readonly path: string }) => {
		readonly path: string;
	};
}) => { readonly path: string };

const harness = (listings: Record<string, readonly FileNode[]>) => {
	const asked: string[] = [];
	const client = {
		rpc: (f: Thunk) => {
			const { path } = f({ "computer.list": (payload) => payload });
			asked.push(path);
			const nodes = listings[path];
			// A directory the fixture does not name is one the bot deleted between
			// the listing and the click.
			return nodes === undefined
				? Promise.reject(new Error("no such directory"))
				: Promise.resolve(nodes);
		},
		stream: () => () => {},
		close: () => Promise.resolve(),
	} as unknown as EvieClient;

	return { store: new EvieStore(() => client), asked };
};

const drawn = (store: EvieStore) =>
	store.getFilesSnapshot(bot).rows.map((row) => `${"  ".repeat(row.depth)}${row.name}`);

describe("the bot's file tree", () => {
	it("reports itself unloaded until the root answers", async () => {
		const { store } = harness({ "/": [file("/notes.md", "notes.md")] });
		expect(store.getFilesSnapshot(bot).loaded).toBe(false);

		await store.browseFiles(bot);
		expect(store.getFilesSnapshot(bot).loaded).toBe(true);
		expect(drawn(store)).toEqual(["notes.md"]);
	});

	it("nests a directory's children under it, and hides them again on close", async () => {
		const { store } = harness({
			"/": [dir("/src", "src"), file("/notes.md", "notes.md")],
			"/src": [file("/src/main.ts", "main.ts")],
		});
		await store.browseFiles(bot);
		await store.toggleDirectory(bot, "/src");

		expect(drawn(store)).toEqual(["src", "  main.ts", "notes.md"]);
		expect(store.getFilesSnapshot(bot).rows[0]?.expanded).toBe(true);

		await store.toggleDirectory(bot, "/src");
		expect(drawn(store)).toEqual(["src", "notes.md"]);
	});

	it("re-reads a directory every time it is opened", async () => {
		const { store, asked } = harness({
			"/": [dir("/src", "src")],
			"/src": [file("/src/main.ts", "main.ts")],
		});
		await store.browseFiles(bot);
		await store.toggleDirectory(bot, "/src");
		await store.toggleDirectory(bot, "/src");
		await store.toggleDirectory(bot, "/src");

		// Nothing pushes when the bot writes a file, so opening a folder is the
		// only moment its contents can be true.
		expect(asked).toEqual(["/", "/src", "/src"]);
	});

	it("sends one listing when the same directory is asked for twice at once", async () => {
		const { store, asked } = harness({ "/": [] });
		const first = store.browseFiles(bot);
		await store.browseFiles(bot);
		await first;

		expect(asked).toEqual(["/"]);
	});

	it("names the directory that failed and closes it again", async () => {
		const { store } = harness({ "/": [dir("/gone", "gone")] });
		await store.browseFiles(bot);
		await store.toggleDirectory(bot, "/gone");

		// Open-and-empty reads as "nothing in here", which is the wrong answer.
		expect(store.getFilesSnapshot(bot).failed).toBe("/gone");
		expect(store.getFilesSnapshot(bot).rows[0]?.expanded).toBe(false);
	});

	it("caches the snapshot so useSyncExternalStore does not loop", async () => {
		const { store } = harness({ "/": [file("/notes.md", "notes.md")] });
		await store.browseFiles(bot);

		expect(store.getFilesSnapshot(bot)).toBe(store.getFilesSnapshot(bot));
	});
});

describe("the pane's error slot", () => {
	/*
	 * The regression the original "names the directory that failed" test stopped
	 * one assertion short of catching: the slot belongs to the pane, not to the
	 * directory, so any successful listing has to clear it. Otherwise the root
	 * re-read that fires on every tab reopen paints a listing under a permanent
	 * complaint about a directory the user stopped caring about.
	 */
	it("clears a failure once any directory lists successfully", () => {
		const tree = new FileTree();
		tree.open("/gone");
		tree.fail("/gone");
		expect(tree.snapshot().failed).toBe("/gone");

		tree.settle(ROOT, [{ name: "src", path: "/src", kind: "dir" }]);
		expect(tree.snapshot().failed).toBeNull();
	});
});
