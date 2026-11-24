// Notification prose uses the owner's Eastern time on every host, including
// the UTC workbox. Persisted timestamps stay in their original wire format.
import { Match } from "effect"

export const NOTIFICATION_ZONE = "America/New_York"

const formatterOf = (timeZone: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZoneName: "short",
  })

// Lease refusals can render this often; compiling the same Intl formatter
// each time is much more expensive than formatting with it.
const eastern = formatterOf(NOTIFICATION_ZONE)

/** A dated, zoned 12-hour time. Round up to seconds so a retry never appears earlier than its deadline. */
export const formatNotificationTime = (at: number, zone = NOTIFICATION_ZONE): string =>
  Match.value(zone).pipe(
    Match.when(NOTIFICATION_ZONE, () => eastern),
    Match.orElse(formatterOf),
  ).format(Math.ceil(at / 1000) * 1000).replace(" at ", ", ").replaceAll("\u202f", " ")
