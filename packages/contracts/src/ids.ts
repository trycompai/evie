import { Schema } from "effect"

/**
 * Branded identifiers.
 *
 * Every id in Evie is a ULID except the three Better Auth owns -- `UserId`,
 * `OrgId`, and `TeamId` -- which are whatever Better Auth minted, and `BlobId`,
 * which is a content hash. Branding is what stops a `ThreadId` being passed
 * where a `BotId` belongs: structurally they are both `string`, and every one
 * of these is used as a bare argument somewhere.
 *
 * Types are derived (`typeof BotId.Type`), never declared alongside. Two
 * declarations of one shape drift, and the drift surfaces as a decode failure
 * in production rather than a compile error in review.
 */

/** A ULID minted by Evie. Sortable by creation time, which the projections rely on. */
const Ulid = Schema.String.check(Schema.isULID())

/** An id minted by another system (Better Auth, eve, a content hash). Opaque to us. */
const Foreign = Schema.String.check(Schema.isMinLength(1))

export const OrgId = Foreign.pipe(Schema.brand("OrgId"))
export type OrgId = typeof OrgId.Type

export const UserId = Foreign.pipe(Schema.brand("UserId"))
export type UserId = typeof UserId.Type

export const TeamId = Foreign.pipe(Schema.brand("TeamId"))
export type TeamId = typeof TeamId.Type

export const BotId = Ulid.pipe(Schema.brand("BotId"))
export type BotId = typeof BotId.Type

export const ThreadId = Ulid.pipe(Schema.brand("ThreadId"))
export type ThreadId = typeof ThreadId.Type

export const MessageId = Ulid.pipe(Schema.brand("MessageId"))
export type MessageId = typeof MessageId.Type

export const TurnId = Ulid.pipe(Schema.brand("TurnId"))
export type TurnId = typeof TurnId.Type

export const RoutineId = Ulid.pipe(Schema.brand("RoutineId"))
export type RoutineId = typeof RoutineId.Type

export const ConnectionId = Ulid.pipe(Schema.brand("ConnectionId"))
export type ConnectionId = typeof ConnectionId.Type

export const SecretId = Ulid.pipe(Schema.brand("SecretId"))
export type SecretId = typeof SecretId.Type

/**
 * Evie mints ULIDs, but mirror rows carry eve's `meta.id` (`evt_<ULID>`), an id
 * from a runtime we supervise but do not control -- so this stays opaque.
 */
export const EventId = Foreign.pipe(Schema.brand("EventId"))
export type EventId = typeof EventId.Type

/** eve mints this. We supervise the runtime but do not control its id format. */
export const SessionId = Foreign.pipe(Schema.brand("SessionId"))
export type SessionId = typeof SessionId.Type

/** A content hash, so the same bytes uploaded twice produce the same id. */
export const BlobId = Foreign.pipe(Schema.brand("BlobId"))
export type BlobId = typeof BlobId.Type

/** A client device, for push endpoints and pairing revocation. */
export const DeviceId = Ulid.pipe(Schema.brand("DeviceId"))
export type DeviceId = typeof DeviceId.Type

/**
 * Unix milliseconds. Every timestamp on the wire and in SQLite is this, never
 * an ISO string: it sorts and diffs without a parse, and SQLite has no date
 * type to disagree with.
 */
export const Millis = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export type Millis = typeof Millis.Type
