import { Notification } from "electron"

/**
 * Delivery, and only delivery.
 *
 * `NotifyReactor` on the server already owns every hard decision here: it is
 * snooze-aware, it notifies the thread's owner rather than whoever acted, and
 * it refuses to fire for any event older than its own start time so that a
 * replay after a crash does not carpet the user in week-old toasts. None of
 * that belongs in a shell that can be quit and relaunched at will.
 *
 * So the server writes one line per notification and this reads it. The reactor
 * only appends its `NotificationDelivered` receipt when the transport reports
 * success, which is why `EVIE_NOTIFY_STDOUT` has to be a real transport and not
 * a logger -- with `layerNoop` wired, no receipt was ever written.
 */

export interface NotifyPayload {
  readonly title: string
  readonly body: string
  readonly threadId: string | null
}

const isPayload = (value: unknown): value is NotifyPayload => {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record["title"] === "string" &&
    typeof record["body"] === "string" &&
    (record["threadId"] === null || typeof record["threadId"] === "string")
  )
}

/** Returns the payload, or null for a line that is not one. Never throws. */
export const parseNotify = (line: string): NotifyPayload | null => {
  try {
    const parsed: unknown = JSON.parse(line)
    return isPayload(parsed) ? parsed : null
  } catch {
    return null
  }
}

export const showNotification = (
  payload: NotifyPayload,
  onActivate: (threadId: string | null) => void,
): void => {
  if (!Notification.isSupported()) return
  const notification = new Notification({ title: payload.title, body: payload.body })
  // Clicking a notification about a thread should land you in that thread, not
  // merely raise the window onto whatever you were last looking at.
  notification.on("click", () => onActivate(payload.threadId))
  notification.show()
}
