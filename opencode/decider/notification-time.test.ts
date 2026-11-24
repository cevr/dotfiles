import { expect, test } from "bun:test"
import { formatNotificationTime } from "./notification-time.ts"

test("notification times name the owner's calendar date, AM/PM and the offset's timezone on either side of DST", () => {
  const examples = [
    ["2026-11-25T19:00:00Z", "Nov 25, 2026, 2:00:00 PM EST"],
    ["2026-07-01T04:00:00Z", "Jul 1, 2026, 12:00:00 AM EDT"],
    ["2026-11-01T05:30:00Z", "Nov 1, 2026, 1:30:00 AM EDT"],
    ["2026-11-01T06:30:00Z", "Nov 1, 2026, 1:30:00 AM EST"],
    ["2027-01-01T00:00:00Z", "Dec 31, 2026, 7:00:00 PM EST"],
  ] as const
  for (const [at, expected] of examples) expect(formatNotificationTime(Date.parse(at))).toBe(expected)
  expect(formatNotificationTime(Date.parse("2026-11-25T19:00:00Z"), "UTC")).toBe("Nov 25, 2026, 7:00:00 PM UTC")
})

test("a fractional retry deadline is displayed at the next second, including across midnight", () => {
  expect(formatNotificationTime(Date.parse("2026-11-25T19:00:00.001Z"))).toBe("Nov 25, 2026, 2:00:01 PM EST")
  expect(formatNotificationTime(Date.parse("2026-11-26T04:59:59.999Z"))).toBe("Nov 26, 2026, 12:00:00 AM EST")
})
