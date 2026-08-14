import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { NotFound } from "@evie/contracts/errors"
import { ulid } from "@evie/shared/ulid"
import { Context, Effect, Layer, Redacted, Semaphore } from "effect"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { EvieConfig } from "../config.ts"
import { Db } from "../db/Db.ts"

/**
 * Encrypted secret storage: AES-256-GCM over the `secret` table.
 *
 * Plaintext exists in exactly two places -- the encrypt/decrypt calls in this
 * file and the environment of a spawned eve child. It is never in the event
 * log (events carry name and hint only), never in a projection, and never in
 * anything a client receives: the read model is `{ name, hint, configured }`.
 *
 * What the per-row encryption buys is an access-control property of the API,
 * not a cryptographic guarantee against the host owner: there is one key on
 * the machine and whoever administers the host can read it. What it rules out
 * is real -- no Settings screen, export, or logged frame ever surfaces another
 * member's token (05 "Secrets").
 *
 * Scopes are `org:<id>`, `bot:<id>`, `user:<id>` -- the same strings the
 * decider's `secretScopeKey` mints, so the org fold and this table agree.
 */

export type SecretScope = `org:${string}` | `bot:${string}` | `user:${string}`

/** What a client is allowed to see. There is no shape here a value fits in. */
export interface SecretRef {
  readonly scope: string
  readonly name: string
  readonly hint: string | null
  readonly configured: true
}

export interface SecretsShape {
  /** Upsert. Setting an existing name is value rotation; runtimes restart on it. */
  readonly set: (
    scope: SecretScope,
    name: string,
    value: string,
  ) => Effect.Effect<{ hint: string | null }, SqlError>
  readonly remove: (scope: SecretScope, name: string) => Effect.Effect<void, SqlError>
  /** Member removal revokes every `user:<id>` secret in one call (05). */
  readonly removeScope: (scope: SecretScope) => Effect.Effect<void, SqlError>
  readonly list: (
    scopes: ReadonlyArray<SecretScope>,
  ) => Effect.Effect<ReadonlyArray<SecretRef>, SqlError>
  /**
   * The only decrypting read, named for its only legitimate caller: building
   * the env of a spawned eve child. Redacted so an accidental log or frame
   * prints a placeholder, not the value.
   */
  readonly valueForSpawn: (
    scope: SecretScope,
    name: string,
  ) => Effect.Effect<Redacted.Redacted<string>, NotFound | SqlError>
  /**
   * Re-encrypts every row under a fresh key. Returns the row count so the
   * caller knows how many runtimes to restart.
   */
  readonly rotateKey: Effect.Effect<number, SqlError>
}

/* --- key material -------------------------------------------------------------
 * This block is the keychain seam: a later phase swaps these file reads for
 * the OS keychain (macOS Keychain, Windows Credential Manager) and nothing
 * above it changes. On disk the key is 32 bytes hex at 0600.
 */

const readKeyFile = (path: string): Buffer => {
  const key = Buffer.from(readFileSync(path, "utf8").trim(), "hex")
  if (key.length !== 32) throw new Error(`${path} is not a 32-byte hex key`)
  return key
}

const writeKeyFile = (path: string, key: Buffer, flag: "w" | "wx"): void => {
  writeFileSync(path, key.toString("hex"), { mode: 0o600, flag })
}

/* --- crypto -------------------------------------------------------------------- */

const NONCE_LEN = 12
const TAG_LEN = 16

/**
 * Scope and name are bound in as AAD, so a row's ciphertext cannot be replayed
 * under another scope or name by editing the database.
 */
const aad = (scope: string, name: string): Buffer => Buffer.from(`${scope}\n${name}`, "utf8")

const encrypt = (key: Buffer, scope: string, name: string, value: string) => {
  const nonce = randomBytes(NONCE_LEN)
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  cipher.setAAD(aad(scope, name))
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()])
  return { nonce, ciphertext }
}

const decrypt = (
  key: Buffer,
  scope: string,
  name: string,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
): string => {
  const body = Buffer.from(ciphertext)
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce))
  decipher.setAAD(aad(scope, name))
  decipher.setAuthTag(body.subarray(body.length - TAG_LEN))
  return Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_LEN)), decipher.final()])
    .toString("utf8")
}

/** `…a4f2`, or nothing when the value is so short the tail would be most of it. */
const hintOf = (value: string): string | null => (value.length >= 8 ? `…${value.slice(-4)}` : null)

interface CipherRow {
  readonly id: string
  readonly scope: string
  readonly name: string
  readonly nonce: Uint8Array
  readonly ciphertext: Uint8Array
}

const make = Effect.gen(function* () {
  const config = yield* EvieConfig
  const db = yield* Db
  const sql = db.sql

  const keyPath = config.home.secretsKeyPath
  const nextPath = `${keyPath}.next`
  yield* Effect.sync(() => mkdirSync(dirname(keyPath), { recursive: true }))

  /*
   * Rotation is crash-safe by ordering: the new key is written to `.next`
   * first, rows re-encrypt in one transaction, and only then does `.next`
   * rename over the real file. A `.next` found at boot means a crash in that
   * window -- probe one row to learn which side the database is on, and
   * finish (or abandon) the rotation accordingly. Requires the migrated
   * schema, so `Secrets.layer` is provided after `MigrationsLive`.
   */
  if (existsSync(nextPath)) {
    const nextKey = readKeyFile(nextPath)
    const currentKey = existsSync(keyPath) ? readKeyFile(keyPath) : null
    const probe = (yield* sql<CipherRow>`
      select id, scope, name, nonce, ciphertext from secret limit 1`)[0]
    const decrypts = (key: Buffer): boolean => {
      if (probe === undefined) return true
      try {
        decrypt(key, probe.scope, probe.name, probe.nonce, probe.ciphertext)
        return true
      } catch {
        return false
      }
    }
    yield* Effect.sync(() => {
      if (currentKey !== null && probe !== undefined && decrypts(currentKey)) {
        unlinkSync(nextPath) // crashed before re-encrypting; the rotation never happened
      } else if (decrypts(nextKey)) {
        renameSync(nextPath, keyPath) // crashed after; finish the rename
      } else {
        throw new Error(`secrets.key rotation left ${keyPath} undecryptable; refusing to guess`)
      }
    })
  }

  if (!existsSync(keyPath)) {
    yield* Effect.sync(() => writeKeyFile(keyPath, randomBytes(32), "wx"))
  }
  let key = readKeyFile(keyPath)

  // `set` reads `key` before it takes the write lock; a concurrent rotation
  // could commit that row under the outgoing key and orphan it. One permit
  // shared by the two key users closes the window. Reads stay unguarded: a
  // decrypt racing the rotation sees pre-commit rows, which the old key fits.
  const keyLock = yield* Semaphore.make(1)

  const set: SecretsShape["set"] = Effect.fn("Secrets.set")(function* (
    scope: SecretScope,
    name: string,
    value: string,
  ) {
    return yield* keyLock.withPermits(1)(
      Effect.gen(function* () {
        const { nonce, ciphertext } = encrypt(key, scope, name, value)
        const hint = hintOf(value)
        const row = { id: ulid(), scope, name, nonce, ciphertext, hint, created_at: Date.now() }
        yield* db.retryLocked(sql`
          insert into secret ${sql.insert(row)}
          on conflict (scope, name) do update set
            nonce = excluded.nonce,
            ciphertext = excluded.ciphertext,
            hint = excluded.hint`)
        return { hint }
      }),
    )
  })

  const remove: SecretsShape["remove"] = Effect.fn("Secrets.remove")(function* (
    scope: SecretScope,
    name: string,
  ) {
    yield* db.retryLocked(sql`delete from secret where scope = ${scope} and name = ${name}`)
  })

  const removeScope: SecretsShape["removeScope"] = Effect.fn("Secrets.removeScope")(function* (
    scope: SecretScope,
  ) {
    yield* db.retryLocked(sql`delete from secret where scope = ${scope}`)
  })

  const list: SecretsShape["list"] = Effect.fn("Secrets.list")(function* (
    scopes: ReadonlyArray<SecretScope>,
  ) {
    if (scopes.length === 0) return []
    const rows = yield* sql<{ scope: string; name: string; hint: string | null }>`
      select scope, name, hint from secret
      where ${sql.in("scope", scopes)}
      order by scope, name`
    return rows.map(
      (row): SecretRef => ({
        scope: row.scope,
        name: row.name,
        hint: row.hint,
        configured: true,
      }),
    )
  })

  const valueForSpawn: SecretsShape["valueForSpawn"] = Effect.fn("Secrets.valueForSpawn")(
    function* (scope: SecretScope, name: string) {
      const rows = yield* sql<CipherRow>`
        select id, scope, name, nonce, ciphertext from secret
        where scope = ${scope} and name = ${name}`
      const row = rows[0]
      if (row === undefined) {
        return yield* new NotFound({ resource: "secret", id: `${scope}/${name}` })
      }
      // A row that will not decrypt is a corrupt store or a mangled key file:
      // a defect, not an error the caller can act on.
      return Redacted.make(decrypt(key, scope, name, row.nonce, row.ciphertext))
    },
  )

  const rotateKey: SecretsShape["rotateKey"] = keyLock.withPermits(1)(
    Effect.fn("Secrets.rotateKey")(function* () {
      const nextKey = randomBytes(32)
      yield* Effect.sync(() => writeKeyFile(nextPath, nextKey, "w"))
      const count = yield* db.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<CipherRow>`select id, scope, name, nonce, ciphertext from secret`
          for (const row of rows) {
            const plain = decrypt(key, row.scope, row.name, row.nonce, row.ciphertext)
            const fresh = encrypt(nextKey, row.scope, row.name, plain)
            yield* sql`
              update secret
              set nonce = ${fresh.nonce}, ciphertext = ${fresh.ciphertext}
              where id = ${row.id}`
          }
          return rows.length
        }),
      )
      yield* Effect.sync(() => renameSync(nextPath, keyPath))
      key = nextKey
      return count
    })(),
  )

  return { set, remove, removeScope, list, valueForSpawn, rotateKey } satisfies SecretsShape
})

export class Secrets extends Context.Service<Secrets, SecretsShape>()("Secrets") {
  /** Needs the migrated database: provide `Db.layer` and `MigrationsLive` under it. */
  static readonly layer = Layer.effect(Secrets, make)
}
