import { randomFillSync } from "node:crypto"

/**
 * Monotonic ULID.
 *
 * Evie's ids are sortable by creation time, and several read paths lean on
 * that: the event log's `seq` is process-wide but an id is the tiebreaker, and
 * a bot list ordered by id is ordered by age without a join.
 *
 * "Monotonic" is the part that matters. Two ULIDs minted in the same
 * millisecond from fresh randomness sort arbitrarily against each other, so a
 * burst -- which is exactly what an ingestion flush is -- would scramble its
 * own order. Within a millisecond we increment the previous random field
 * instead of drawing a new one, per the ULID spec.
 */

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ" // Crockford base32, no I L O U
const TIME_LEN = 10
const RANDOM_LEN = 16
const RANDOM_BYTES = 10

let lastTime = -1
const lastRandom = new Uint8Array(RANDOM_BYTES)

const encodeTime = (now: number): string => {
  let out = ""
  let t = now
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    out = ENCODING[t % 32]! + out
    t = Math.floor(t / 32)
  }
  return out
}

const encodeRandom = (bytes: Uint8Array): string => {
  // 10 bytes -> 80 bits -> exactly 16 base32 characters, read most significant
  // first. Doing it bit-wise rather than byte-wise is what makes the increment
  // below a true ordering increment.
  let out = ""
  let bitBuffer = 0
  let bitCount = 0
  for (let i = 0; i < bytes.length; i++) {
    bitBuffer = (bitBuffer << 8) | bytes[i]!
    bitCount += 8
    while (bitCount >= 5) {
      bitCount -= 5
      out += ENCODING[(bitBuffer >>> bitCount) & 31]!
      bitBuffer &= (1 << bitCount) - 1
    }
  }
  return out.slice(0, RANDOM_LEN)
}

/** Increments the random field in place. Returns false on the 1-in-2^80 overflow. */
const incrementRandom = (): boolean => {
  for (let i = RANDOM_BYTES - 1; i >= 0; i--) {
    if (lastRandom[i]! < 0xff) {
      lastRandom[i]!++
      return true
    }
    lastRandom[i] = 0
  }
  return false
}

/**
 * @param now Injectable so a test can mint a deterministic sequence. Production
 * callers pass nothing and get `Date.now()`.
 */
export const ulid = (now: number = Date.now()): string => {
  if (now === lastTime) {
    if (!incrementRandom()) {
      // Overflowed 80 bits inside one millisecond. Waiting for the next
      // millisecond is the only way to stay monotonic, and it will never
      // happen outside a test that mints 2^80 ids.
      return ulid(now + 1)
    }
  } else {
    lastTime = now
    randomFillSync(lastRandom)
  }
  return encodeTime(now) + encodeRandom(lastRandom)
}

const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/

export const isUlid = (value: string): boolean => ULID_RE.test(value)

/** Milliseconds encoded in a ULID's time field. Cheaper than a table lookup. */
export const ulidTime = (id: string): number => {
  let t = 0
  for (let i = 0; i < TIME_LEN; i++) {
    t = t * 32 + ENCODING.indexOf(id[i]!)
  }
  return t
}
