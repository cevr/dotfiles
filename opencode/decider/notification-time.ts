// Notification prose uses the owner's Eastern time on every host, including
// the UTC workbox. Persisted timestamps stay in their original wire format.
export const NOTIFICATION_ZONE = "America/New_York"

/** A dated, zoned 12-hour time. Round up to seconds so a retry never appears earlier than its deadline. */
export const formatNotificationTime = (at: number, zone = NOTIFICATION_ZONE): string =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(Math.ceil(at / 1000) * 1000).replace(" at ", ", ").replaceAll("\u202f", " ")
