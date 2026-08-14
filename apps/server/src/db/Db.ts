import { mkdirSync } from "node:fs";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { ConcurrencyConflict } from "@evie/contracts/errors";
import { Context, Effect, Layer, Schedule } from "effect";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Row } from "effect/unstable/sql/SqlConnection";
import { SqlError } from "effect/unstable/sql/SqlError";
import { EvieConfig } from "../config.ts";

/**
 * The process's only SQLite writer.
 *
 * `node:sqlite` is synchronous: a second writer in this process turns lock
 * contention into an event-loop stall that freezes every stream at once (02,
 * "One writer"). So this layer owns the one write handle, `busy_timeout` is
 * 250 ms rather than 5 s -- a blocked event loop is worse than a failed write --
 * and contention surfaces as a typed retryable error handled off the hot path.
 *
 * Better Auth does not open the file either: it executes through `execute` /
 * `executeRaw` below (the driver exposes no raw `DatabaseSync` handle, see
 * .evie-build-notes/sql.md §6), so its Kysely dialect shares this connection.
 */

export interface DbShape {
	readonly sql: SqlClient.SqlClient;
	/** `BEGIN IMMEDIATE` at depth 0, savepoints when nested. */
	readonly withTransaction: <A, E, R>(
		effect: Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E | SqlError, R>;
	/**
	 * Retries retryable `SqlError`s (lock timeouts, busy) with jittered backoff.
	 * For writes that lost the 250 ms `busy_timeout` race -- never wrap a
	 * streaming path in this; batching belongs there instead.
	 */
	readonly retryLocked: <A, E, R>(
		effect: Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E, R>;
	/**
	 * Reruns the effect once when it fails with `ConcurrencyConflict`. The effect
	 * must contain the whole fold-decide-append cycle, so the rerun refolds
	 * against the moved aggregate rather than replaying a stale decision.
	 */
	readonly retryConflict: <A, E, R>(
		effect: Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E, R>;
	/** Dynamically-built SQL through this connection. Rows, decoded by the driver. */
	readonly execute: (
		sqlText: string,
		params?: ReadonlyArray<unknown>,
	) => Effect.Effect<ReadonlyArray<Row>, SqlError>;
	/** Same, but the driver's raw result: `{ changes, lastInsertRowid }` for writes. */
	readonly executeRaw: (
		sqlText: string,
		params?: ReadonlyArray<unknown>,
	) => Effect.Effect<unknown, SqlError>;
}

const lockRetryPolicy = Schedule.exponential("20 millis").pipe(
	Schedule.jittered,
	Schedule.upTo({ times: 3 }),
);

const make = Effect.gen(function* () {
	const config = yield* EvieConfig;

	// First boot creates the home. mkdirSync is recursive, so userdata arrives
	// with its children; sync is fine here, nothing else is running yet.
	yield* Effect.sync(() => {
		mkdirSync(config.home.blobsDir, { recursive: true });
		mkdirSync(config.home.orgsDir, { recursive: true });
	});

	const client = yield* SqliteClient.make({
		filename: config.home.statePath,
		// WAL is the driver default. 250 ms, not 5 s: see the module comment.
		busyTimeout: "250 millis",
	});

	yield* client`pragma synchronous = NORMAL`;
	yield* client`pragma foreign_keys = ON`;

	const db: DbShape = {
		sql: client,
		withTransaction: client.withTransaction,
		retryLocked: (effect) =>
			Effect.retry(effect, {
				while: (error) => error instanceof SqlError && error.reason.isRetryable,
				schedule: lockRetryPolicy,
			}),
		retryConflict: (effect) =>
			Effect.retry(effect, {
				while: (error) => error instanceof ConcurrencyConflict,
				times: 1,
			}),
		execute: (sqlText, params) => client.unsafe<Row>(sqlText, params),
		executeRaw: (sqlText, params) => client.unsafe(sqlText, params).raw,
	};

	return Context.make(Db, db).pipe(
		Context.add(SqlClient.SqlClient, client),
		Context.add(SqliteClient.SqliteClient, client),
	);
});

export class Db extends Context.Service<Db, DbShape>()("Db") {
	/** Provides `Db` plus the `SqlClient` tag, so `sql` is yieldable downstream. */
	static readonly layer = Layer.effectContext(make).pipe(
		Layer.provide(Reactivity.layer),
	);
}
