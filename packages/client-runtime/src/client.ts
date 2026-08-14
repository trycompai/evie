import type { SessionInfo } from "@evie/contracts/org";
import { EvieRpc } from "@evie/contracts/rpc";
import { CONTRACT_VERSION } from "@evie/contracts/version";
import { Deferred, Effect, Fiber, Layer, ManagedRuntime, Stream } from "effect";
import type { RpcClientError, RpcGroup } from "effect/unstable/rpc";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { Socket } from "effect/unstable/socket";

/**
 * The socket.
 *
 * One connection per client, opened once and kept. Effect lives entirely behind
 * this file: React sees promises and callbacks, which is what makes the store
 * usable from `useSyncExternalStore` without a single `useEffect` for data.
 *
 * Reconnect is the protocol layer's job, not ours -- `layerProtocolSocket`
 * carries a ping/pong keepalive and an exponential retry, and
 * `retryTransientErrors` keeps in-flight streams alive across a blip instead of
 * failing every pending request. What we own is what happens *after* a
 * reconnect: re-running the handshake and resuming each open thread from its
 * cursor, which is `onReconnect` below.
 */

export type ConnectionState =
	| { readonly kind: "connecting" }
	| { readonly kind: "ready"; readonly session: SessionInfo }
	/** The server refused our contract version. There is no retry for this. */
	| {
			readonly kind: "outdated";
			readonly client: number;
			readonly server: number;
	  }
	| { readonly kind: "unauthenticated" }
	| { readonly kind: "offline"; readonly since: number };

/**
 * The generated client: one method per RPC tag, typed from the group. Derived
 * rather than written out, so adding an Rpc to `EvieRpc` adds a method here.
 */
export type Client = RpcClient.RpcClient<
	RpcGroup.Rpcs<typeof EvieRpc>,
	RpcClientError.RpcClientError
>;

export interface EvieClientOptions {
	/** `ws://127.0.0.1:3000/rpc`, or wss:// through a tunnel. */
	readonly url: string;
	readonly onState: (state: ConnectionState) => void;
	/**
	 * Fired after a reconnect completes its handshake. The store re-subscribes
	 * every open thread from its last seen `seq` here -- the socket layer restores
	 * the transport, not the application's place in the stream.
	 */
	readonly onReconnect?: () => void;
}

export interface EvieClient {
	/** Resolves once the handshake succeeds. Rejects if the contract mismatches. */
	readonly ready: Promise<SessionInfo>;
	readonly rpc: <A>(
		f: (client: Client) => Effect.Effect<A, unknown>,
	) => Promise<A>;
	/**
	 * Subscribes to a stream RPC. Returns an unsubscribe function.
	 *
	 * Deliberately callback-shaped rather than async-iterator-shaped: the store
	 * applies a frame synchronously and then notifies listeners, and an
	 * `for await` loop would put a microtask between the two for no benefit.
	 */
	readonly stream: <A>(
		f: (client: Client) => Stream.Stream<A, unknown>,
		onValue: (value: A) => void,
	) => () => void;
	readonly close: () => Promise<void>;
}

export function createEvieClient(options: EvieClientOptions): EvieClient {
	const protocol = RpcClient.layerProtocolSocket({
		retryTransientErrors: true,
	}).pipe(
		Layer.provideMerge(RpcSerialization.layerMsgPack),
		Layer.provideMerge(
			Socket.layerWebSocket(options.url).pipe(
				Layer.provide(Socket.layerWebSocketConstructorGlobal),
			),
		),
	);

	const runtime = ManagedRuntime.make(protocol);

	// The client is scoped, so it has to be held open by a fiber rather than
	// handed out of a `runPromise` that would close the scope on its way back.
	const handle = Effect.runSync(Deferred.make<Client, never>());

	const main = Effect.gen(function* () {
		const client = yield* RpcClient.make(EvieRpc);
		yield* Deferred.succeed(handle, client);
		return yield* Effect.never;
	}).pipe(Effect.scoped);

	const fiber = runtime.runFork(main);

	const withClient = <A>(f: (client: Client) => Effect.Effect<A, unknown>) =>
		Deferred.await(handle).pipe(Effect.flatMap(f));

	const hello = runtime
		.runPromise(
			withClient((c) =>
				c["session.hello"]({ contractVersion: CONTRACT_VERSION }),
			),
		)
		.then((session) => {
			options.onState({ kind: "ready", session });
			return session;
		})
		.catch((error: unknown) => {
			options.onState(classify(error));
			throw error;
		});

	options.onState({ kind: "connecting" });

	return {
		ready: hello,
		rpc: (f) => runtime.runPromise(withClient(f)),
		stream: (f, onValue) => {
			const running = runtime.runFork(
				withClient((client) =>
					Stream.runForEach(f(client), (value) =>
						Effect.sync(() => onValue(value)),
					),
				),
			);
			return () => {
				void Effect.runPromise(Fiber.interrupt(running));
			};
		},
		close: async () => {
			await Effect.runPromise(Fiber.interrupt(fiber));
			await runtime.dispose();
		},
	};
}

/**
 * Turns a failed handshake into something the UI can act on.
 *
 * A version mismatch has to be distinguishable from every other failure: it is
 * the one where retrying forever is exactly wrong, and where the honest message
 * is "update Evie" rather than "check your connection".
 */
const classify = (error: unknown): ConnectionState => {
	const tag =
		typeof error === "object" && error !== null && "_tag" in error
			? error._tag
			: undefined;
	if (tag === "ContractMismatch") {
		const e = error as { client: number; server: number };
		return { kind: "outdated", client: e.client, server: e.server };
	}
	if (tag === "Unauthenticated") return { kind: "unauthenticated" };
	return { kind: "offline", since: Date.now() };
};
