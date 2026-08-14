/**
 * Truncation, in the two places bytes are budgeted.
 */

/** 03's frame budget: payloads over this get head + tail + a blob handle. */
export const TOOL_PAYLOAD_LIMIT = 8 * 1024
const KEEP = 2 * 1024

export interface Truncated {
  readonly value: string
  readonly truncated: boolean
  /** Full byte length, so the UI can say "8.4 KB" without fetching the blob. */
  readonly size: number
}

/**
 * Head and tail of an oversized tool payload.
 *
 * Both ends, not just the head: a stack trace's cause is at the bottom and a
 * command's exit status is the last line, so a head-only truncation reliably
 * hides the part someone opened the row to read.
 */
export const truncatePayload = (json: string): Truncated => {
  const size = Buffer.byteLength(json, "utf8")
  if (size <= TOOL_PAYLOAD_LIMIT) {
    return { value: json, truncated: false, size }
  }
  const head = json.slice(0, KEEP)
  const tail = json.slice(-KEEP)
  return { value: `${head}\n…\n${tail}`, truncated: true, size }
}

/**
 * Thread rail preview.
 *
 * Collapses whitespace first: an assistant reply that opens with a fenced code
 * block would otherwise render as a row of blank space in the sidebar. The
 * ellipsis is a single character, not three dots, so it measures as one glyph
 * against the rail's fixed width.
 */
export const preview = (text: string, max = 64): string => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`
}
