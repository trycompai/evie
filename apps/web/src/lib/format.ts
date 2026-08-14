/**
 * Dates, in the viewer's locale and the viewer's zone.
 *
 * Everything on the wire is Unix milliseconds; formatting is a client concern.
 * A server that pre-formats a timestamp has to guess a locale and a timezone,
 * and it guesses wrong for every remote client -- which is most of them, since
 * reaching your environment from elsewhere is the point of the product.
 *
 * Formatters are built once. `Intl.DateTimeFormat` construction is the
 * expensive part, and the rail re-formats every row on every fleet frame.
 */

const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" })
const monthDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" })
const full = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" })

const DAY = 86_400_000

const startOfDay = (ms: number): number => {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * The rail's timestamp: "3:53 PM" today, "Yesterday", a weekday inside the last
 * week, then a date. Same ladder Mail and Messages use, because the rail is
 * scanned the same way -- you are looking for "has this moved", not for a date.
 */
export function formatRailTime(at: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY)
  if (days <= 0) return time.format(at)
  if (days === 1) return "Yesterday"
  if (days < 7) return weekday.format(at)
  return monthDay.format(at)
}

/** "Today 3:52 PM" — the divider that groups the stream by session. */
export function formatDayDivider(at: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY)
  const clock = time.format(at)
  if (days <= 0) return `Today ${clock}`
  if (days === 1) return `Yesterday ${clock}`
  if (days < 7) return `${weekday.format(at)} ${clock}`
  return `${full.format(at)} ${clock}`
}

/** "2 minutes ago". Used where an exact time would be noise. */
export function formatRelative(at: number, now = Date.now()): string {
  const seconds = Math.round((now - at) / 1000)
  if (seconds < 45) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`
  return monthDay.format(at)
}
