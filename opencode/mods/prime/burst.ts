// Messages that came close together read as one burst: background agents
// started in steps a few seconds apart, workers that finished together.
import type { Message } from "./session.ts"

/** The longest pause between two subagent events that still reads as one burst. */
export const BURST_MS = 60_000

/** Whether `next` starts within the burst window of `previous` ending. */
export function close(previous: Message, next: Message) {
  const end = previous.time.completed ?? previous.time.created
  return next.time.created - end <= BURST_MS
}

/** The stretch of items around `at` that `joins` links pairwise. */
export function stretch<T>(items: ReadonlyArray<T>, at: number, joins: (previous: T, next: T) => boolean): T[] {
  // Whether the item at `index` joins the one before it.
  const joined = (index: number) => {
    const previous = items[index - 1]
    const next = items[index]
    return index > 0 && previous !== undefined && next !== undefined && joins(previous, next)
  }
  let start = at
  while (joined(start)) start--
  let end = at
  while (joined(end + 1)) end++
  return items.slice(start, end + 1)
}
