// The dock's wake item while the session has wakes pending or notices unread,
// counts only: `2 wakes · 1 monitor · 1 notice`. Alarms count as wakes.
// Parts drop from the right as the width shrinks. The reading comes from the wake mod's RPC (opencode/wakes.ts).

/** What the dock reads of a session's wakes: each pending entry's kind and time, and the unread notices. */
export type Wakes = {
  /** The wake server's clock when it answered, epoch ms. */
  readonly now: number
  /** An alarm's due time, a monitor's deadline. */
  readonly entries: ReadonlyArray<{ readonly kind: "alarm" | "monitor"; readonly dueAt: number }>
  readonly notices: number
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/**
 * The wake item, in at most `max` cells (the first part always
 * shows): `success` while anything is pending, `warning` with only notices
 * unread. Undefined when nothing is pending or unread.
 */
export const wakeItem = (wakes: Wakes, max: number): { readonly text: string; readonly tone: "success" | "warning" } | undefined => {
  const alarms = wakes.entries.filter((entry) => entry.kind === "alarm")
  const monitors = wakes.entries.filter((entry) => entry.kind === "monitor")
  if (alarms.length === 0 && monitors.length === 0 && wakes.notices === 0) return undefined
  const counts = [...(alarms.length === 0 ? [] : [plural(alarms.length, "wake", "wakes")]), ...(monitors.length === 0 ? [] : [plural(monitors.length, "monitor", "monitors")])]
  const notices = wakes.notices === 0 ? [] : [plural(wakes.notices, "notice", "notices")]
  const parts = [...counts, ...notices]
  let kept = parts.length
  while (kept > 1 && [...parts.slice(0, kept).join(" · ")].length > max) kept -= 1
  return { text: parts.slice(0, kept).join(" · "), tone: wakes.entries.length > 0 ? "success" : "warning" }
}
