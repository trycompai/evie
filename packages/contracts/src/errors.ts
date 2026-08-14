import { Schema } from "effect"

/**
 * Errors that cross the wire.
 *
 * Every one carries enough for the client to render an action, not just a
 * message. A raw provider stack trace is never one of these -- see 02's failure
 * table: "Turn fails with a typed error and a *Fix in Settings* action."
 *
 * **Every one also overrides `message`.** `Schema.TaggedError` gives a class
 * whose fields are typed and whose `Error.message` is the empty string, so an
 * error that escapes the typed path -- into a log line, a stack trace, a
 * `toThrow` matcher -- reads as `InvalidCommand: ` and tells nobody anything.
 * The getter is what makes the log useful; the fields are still what the client
 * renders. The two must not drift, so the getter is derived from the fields
 * rather than passed in.
 */

/** The client and server disagree about `@evie/contracts`. Naming both is the point. */
export class ContractMismatch extends Schema.TaggedError<ContractMismatch>()("ContractMismatch", {
  client: Schema.Number,
  server: Schema.Number,
}) {
  override get message(): string {
    return `client speaks contract v${this.client}, this environment speaks v${this.server}`
  }
}

/** Every RPC but `session.hello` fails with this until the handshake succeeds. */
export class HandshakeRequired extends Schema.TaggedError<HandshakeRequired>()("HandshakeRequired", {}) {
  override get message(): string {
    return "session.hello must be the first call on a connection"
  }
}

/** No session cookie, or a session that no longer resolves to a member. */
export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()("Unauthenticated", {}) {
  override get message(): string {
    return "no session, or the session no longer resolves to a member"
  }
}

/**
 * The actor is who they say they are and may not do this. `permission` is the
 * statement that failed so the client can say which one rather than "forbidden".
 */
export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {
  permission: Schema.String,
}) {
  override get message(): string {
    return `this member does not hold ${this.permission}`
  }
}

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  resource: Schema.String,
  id: Schema.String,
}) {
  override get message(): string {
    return `no ${this.resource} ${this.id} in this organization`
  }
}

/**
 * The aggregate moved underneath a command between the fold and the append.
 * The handler refolds and retries once; this surfaces only when that also
 * loses, which means a real conflict rather than a race.
 */
export class ConcurrencyConflict extends Schema.TaggedError<ConcurrencyConflict>()("ConcurrencyConflict", {
  aggregate: Schema.String,
  expected: Schema.Number,
  actual: Schema.Number,
}) {
  override get message(): string {
    return `${this.aggregate} moved from v${this.expected} to v${this.actual} under this command`
  }
}

/** The command is well-formed and does not make sense given the aggregate's state. */
export class InvalidCommand extends Schema.TaggedError<InvalidCommand>()("InvalidCommand", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason
  }
}

/**
 * A rule Evie enforces rather than assumes. `just-bash` cannot be selected once
 * a second member exists, a non-loopback bind needs a real credential first.
 * `remedy` is what the UI offers as the way out.
 */
export class PolicyViolation extends Schema.TaggedError<PolicyViolation>()("PolicyViolation", {
  policy: Schema.String,
  reason: Schema.String,
  remedy: Schema.optional(Schema.String),
}) {
  override get message(): string {
    return `${this.policy}: ${this.reason}${this.remedy ? ` -- ${this.remedy}` : ""}`
  }
}

/** An eve runtime failed to start, died, or rejected a dispatch. */
export class RuntimeUnavailable extends Schema.TaggedError<RuntimeUnavailable>()("RuntimeUnavailable", {
  botId: Schema.String,
  reason: Schema.String,
  /** Last stderr lines from the crashed child, so the UI can show them without a log dive. */
  stderr: Schema.optional(Schema.Array(Schema.String)),
}) {
  override get message(): string {
    return `bot ${this.botId} has no runtime: ${this.reason}`
  }
}

/** A model credential is missing or was rejected. Always renders a *Fix in Settings* action. */
export class CredentialProblem extends Schema.TaggedError<CredentialProblem>()("CredentialProblem", {
  secretName: Schema.String,
  reason: Schema.Literals(["missing", "rejected", "expired"]),
}) {
  override get message(): string {
    return `${this.secretName} is ${this.reason}`
  }
}

/** Writes are failing. Degrades to read-only with a banner rather than corrupting state. */
export class StorageUnavailable extends Schema.TaggedError<StorageUnavailable>()("StorageUnavailable", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason
  }
}

/**
 * The union every RPC declares as its error channel.
 *
 * One union rather than per-RPC error sets: the client's error boundary handles
 * `ContractMismatch` and `Unauthenticated` identically no matter which call
 * raised them, and a handler that grows a new failure mode does not become a
 * contract change.
 */
export const EvieError = Schema.Union([
  ContractMismatch,
  HandshakeRequired,
  Unauthenticated,
  Forbidden,
  NotFound,
  ConcurrencyConflict,
  InvalidCommand,
  PolicyViolation,
  RuntimeUnavailable,
  CredentialProblem,
  StorageUnavailable,
])
export type EvieError = typeof EvieError.Type
