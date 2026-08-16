/**
 * Cron, in both directions: the cadences the editor offers, and the sentence a
 * row shows instead of `0 9 * * 1-5`.
 *
 * Only the shapes the editor can produce get a sentence. Anything else -- a
 * hand-written expression, or one written by a future editor this build has
 * never seen -- falls back to the raw text rather than to a confident guess.
 * A schedule the UI describes wrongly is worse than one it declines to
 * describe, because nobody re-reads a line they believe.
 *
 * The clock is rendered in the viewer's locale but never in the viewer's zone:
 * the fields are wall-clock numbers in the routine's own `tz`, so they are
 * formatted against a fixed UTC instant and the zone is labelled separately.
 */

export type CadenceKind = "minutes" | "hourly" | "daily" | "weekdays" | "weekly" | "custom"

export interface Cadence {
  readonly kind: CadenceKind
  /** 0-23, for every kind that names an hour. */
  readonly hour: number
  /** 0-59. */
  readonly minute: number
  /** 0-6, Sunday first. `weekly` only. */
  readonly weekday: number
  /** `minutes` only: the interval. */
  readonly every: number
}

export const DEFAULT_CADENCE: Cadence = {
  kind: "daily",
  hour: 9,
  minute: 0,
  weekday: 1,
  every: 15,
}

export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const

const clockFormat = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
})

/** A wall clock, in the viewer's locale. Not an instant -- see the file note. */
export const formatClock = (hour: number, minute: number): string =>
  clockFormat.format(Date.UTC(2000, 0, 1, hour, minute))

const pad = (n: number): string => String(n).padStart(2, "0")

/** The `HH:MM` a time input wants, which is not what a person wants to read. */
export const toTimeInput = (hour: number, minute: number): string =>
  `${pad(hour)}:${pad(minute)}`

export const fromTimeInput = (value: string): { hour: number; minute: number } | null => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return { hour, minute }
}

/** The 5-field expression for a cadence. `custom` has none; the caller owns it. */
export const buildCron = (cadence: Cadence): string => {
  const { hour, minute, weekday, every } = cadence
  switch (cadence.kind) {
    case "minutes":
      return `*/${every} * * * *`
    case "hourly":
      return `${minute} * * * *`
    case "daily":
      return `${minute} ${hour} * * *`
    case "weekdays":
      return `${minute} ${hour} * * 1-5`
    case "weekly":
      return `${minute} ${hour} * * ${weekday}`
    case "custom":
      return ""
  }
}

/** Exactly five whitespace-separated fields. The decider enforces the same. */
export const isFiveField = (cron: string): boolean =>
  cron.trim().split(/\s+/).filter((field) => field.length > 0).length === 5

const asNumber = (field: string, max: number): number | null => {
  if (!/^\d{1,2}$/.test(field)) return null
  const value = Number(field)
  return value <= max ? value : null
}

/**
 * "Weekdays at 9:00 AM", or the expression itself when this build cannot say
 * it in words. Never throws: it is called while rendering a list.
 */
export const describeCron = (cron: string): string => {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return cron
  const [minuteField, hourField, dayOfMonth, month, dayOfWeek] = fields as [
    string,
    string,
    string,
    string,
    string,
  ]
  if (month !== "*") return cron

  const everyMinutes = /^\*\/(\d{1,2})$/.exec(minuteField)
  if (everyMinutes && hourField === "*" && dayOfMonth === "*" && dayOfWeek === "*") {
    const n = Number(everyMinutes[1])
    return n === 1 ? "Every minute" : `Every ${n} minutes`
  }

  const minute = asNumber(minuteField, 59)
  if (minute === null) return cron

  if (hourField === "*" && dayOfMonth === "*" && dayOfWeek === "*") {
    return `Hourly at :${pad(minute)}`
  }

  const hour = asNumber(hourField, 23)
  if (hour === null) return cron
  const at = formatClock(hour, minute)

  if (dayOfMonth === "*" && dayOfWeek === "*") return `Daily at ${at}`
  if (dayOfMonth === "*" && dayOfWeek === "1-5") return `Weekdays at ${at}`
  if (dayOfMonth === "*") {
    const day = asNumber(dayOfWeek, 6)
    if (day === null) return cron
    return `Every ${WEEKDAY_NAMES[day]} at ${at}`
  }
  if (dayOfWeek === "*") {
    const date = asNumber(dayOfMonth, 31)
    if (date === null || date === 0) return cron
    return `Monthly on the ${ordinal(date)} at ${at}`
  }
  return cron
}

const ordinal = (n: number): string => {
  const rem100 = n % 100
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`
  switch (n % 10) {
    case 1:
      return `${n}st`
    case 2:
      return `${n}nd`
    case 3:
      return `${n}rd`
    default:
      return `${n}th`
  }
}

/**
 * The zone a new routine defaults to: the viewer's own.
 *
 * Read once per call rather than cached, because a laptop that changes zone
 * mid-session should offer the zone it is in now. What must never move is the
 * zone already stored on a routine -- that is why `tz` lives on the row.
 */
export const localZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}
