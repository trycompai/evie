import type {
  CompiledQuery,
  DatabaseConnection,
  DatabaseIntrospector,
  Dialect,
  DialectAdapter,
  Driver,
  Kysely,
  QueryCompiler,
  QueryResult,
} from "kysely"
import { SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from "kysely"

/**
 * The Phase 0 spike from 05 "One database handle", resolved in favour of
 * option 1: Better Auth's Kysely instance executes through the connection
 * `Db` already owns, so `state.sqlite` keeps exactly one writer.
 *
 * The executor is `Db.executeRaw` run to a Promise. The sqlite-node driver's
 * raw result is shape-discriminated: a row-producing statement (`SELECT`,
 * `RETURNING`, pragmas) comes back as an array of rows, a mutation as
 * `{ changes, lastInsertRowid }` -- the driver decides via `stmt.columns()`,
 * so no SQL sniffing happens here either.
 */

export interface SharedSqlExecutor {
  /** `Db.executeRaw` bridged to a Promise. Retry-on-busy belongs in the bridge. */
  readonly executeRaw: (
    sqlText: string,
    params?: ReadonlyArray<unknown>,
  ) => Promise<unknown>
}

interface RawWriteResult {
  readonly changes: number | bigint
  readonly lastInsertRowid: number | bigint
}

class SharedConnection implements DatabaseConnection {
  readonly #executor: SharedSqlExecutor

  constructor(executor: SharedSqlExecutor) {
    this.#executor = executor
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const result = await this.#executor.executeRaw(
      compiledQuery.sql,
      compiledQuery.parameters,
    )
    if (Array.isArray(result)) {
      return { rows: result as Array<R> }
    }
    const { changes, lastInsertRowid } = result as RawWriteResult
    return {
      rows: [],
      numAffectedRows: BigInt(changes),
      insertId: BigInt(lastInsertRowid),
    }
  }

  // eslint-disable-next-line require-yield -- the throw is the implementation
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("The shared Evie sqlite connection does not stream")
  }
}

/**
 * No pooling and no connection pinning: the Effect client serializes every
 * statement on its own semaphore, and nothing here carries state between
 * statements because transactions are refused below.
 */
class SharedDriver implements Driver {
  readonly #connection: SharedConnection

  constructor(executor: SharedSqlExecutor) {
    this.#connection = new SharedConnection(executor)
  }

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    return this.#connection
  }

  /**
   * A Kysely `begin` would leave the shared connection inside a transaction
   * that Effect SQL knows nothing about, and every concurrent Evie statement
   * would interleave into it. Better Auth's Kysely adapter defaults to
   * `transaction: false` and Evie passes it explicitly; anything that still
   * asks fails loudly rather than corrupting the one writer.
   */
  async beginTransaction(): Promise<void> {
    throw new Error(
      "Transactions are not available on the shared Evie connection; keep `transaction: false`",
    )
  }

  async commitTransaction(): Promise<void> {
    throw new Error("Transactions are not available on the shared Evie connection")
  }

  async rollbackTransaction(): Promise<void> {
    throw new Error("Transactions are not available on the shared Evie connection")
  }

  async releaseConnection(): Promise<void> {}

  /** `Db`'s scope owns the underlying handle; Kysely never closes it. */
  async destroy(): Promise<void> {}
}

export class EvieKyselyDialect implements Dialect {
  readonly #executor: SharedSqlExecutor

  constructor(executor: SharedSqlExecutor) {
    this.#executor = executor
  }

  createDriver(): Driver {
    return new SharedDriver(this.#executor)
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler()
  }

  createAdapter(): DialectAdapter {
    return new SqliteAdapter()
  }

  /** Kysely's own pragma-based introspector; `getMigrations()` depends on it. */
  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SqliteIntrospector(db)
  }
}
