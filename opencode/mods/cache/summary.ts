// The ledger summed over a window: cache-write tokens by cause, by the segment
// a changed prefix changed first, per host and day (the unexplained part is
// the check: a miss inside the lifetime that no wait explains), and per
// session-hour. `scripts/cache-ledger.ts` prints it. Hours and days are UTC.
import { formatTokens } from "./line.ts"
import { UNEXPLAINED, type Cause, type LedgerLine } from "./request-log.ts"

export interface Tally {
  readonly write: number
  readonly steps: number
}

export interface HostDay {
  readonly host: string
  /** `2026-11-06`. */
  readonly day: string
  readonly write: number
  /** Written by a `login`, `prefix` or `unchanged` miss. */
  readonly unexplained: number
}

export interface SessionHour {
  readonly host: string
  readonly sessionID: string
  /** `2026-11-06T14`. */
  readonly hour: string
  readonly write: number
  readonly byCause: Readonly<Partial<Record<Cause, number>>>
}

export interface Summary {
  readonly lines: number
  readonly write: number
  readonly byCause: ReadonlyArray<readonly [Cause, Tally]>
  /** The first changed segment of the `prefix`, `login` and `compaction` misses that name one, message indexes folded. */
  readonly bySegment: ReadonlyArray<readonly [string, Tally]>
  readonly byHostDay: ReadonlyArray<HostDay>
  /** Most written first. */
  readonly sessionHours: ReadonlyArray<SessionHour>
}

const add = (tally: Tally | undefined, write: number): Tally => ({ write: (tally?.write ?? 0) + write, steps: (tally?.steps ?? 0) + 1 })

const byWrite = <K>(entries: Iterable<readonly [K, Tally]>) => [...entries].sort((a, b) => b[1].write - a[1].write)

/** `messages[12] user part 0 (text)` reads `messages[i] user part 0 (text)`: the place in the message, not which message. */
export const segmentKey = (segment: string): string => segment.replace(/^messages\[\d+\]/, "messages[i]")

/** The lines from `since` (epoch ms) on, of `host` when one is named, summed. */
export const summarize = (lines: ReadonlyArray<LedgerLine>, since: number, host?: string): Summary => {
  const kept = lines.filter((line) => line.at >= since && (host === undefined || line.host === host))
  const causes = new Map<Cause, Tally>()
  const segments = new Map<string, Tally>()
  const days = new Map<string, { host: string; day: string; write: number; unexplained: number }>()
  const hours = new Map<string, { host: string; sessionID: string; hour: string; write: number; byCause: Partial<Record<Cause, number>> }>()
  let write = 0
  for (const line of kept) {
    write += line.write
    causes.set(line.cause, add(causes.get(line.cause), line.write))
    if (line.change !== undefined && line.cause !== "expired") {
      const key = segmentKey(line.change.segment)
      segments.set(key, add(segments.get(key), line.write))
    }
    const stamp = new Date(line.at).toISOString()
    const day = stamp.slice(0, 10)
    const dayKey = `${line.host}\u0000${day}`
    const dayEntry = days.get(dayKey) ?? { host: line.host, day, write: 0, unexplained: 0 }
    dayEntry.write += line.write
    if (UNEXPLAINED.has(line.cause)) dayEntry.unexplained += line.write
    days.set(dayKey, dayEntry)
    const hour = stamp.slice(0, 13)
    const hourKey = `${line.host}\u0000${line.sessionID}\u0000${hour}`
    const hourEntry = hours.get(hourKey) ?? { host: line.host, sessionID: line.sessionID, hour, write: 0, byCause: {} }
    hourEntry.write += line.write
    hourEntry.byCause[line.cause] = (hourEntry.byCause[line.cause] ?? 0) + line.write
    hours.set(hourKey, hourEntry)
  }
  return {
    lines: kept.length,
    write,
    byCause: byWrite(causes),
    bySegment: byWrite(segments),
    byHostDay: [...days.values()].sort((a, b) => a.host.localeCompare(b.host) || a.day.localeCompare(b.day)),
    sessionHours: [...hours.values()].sort((a, b) => b.write - a.write),
  }
}

const tallyText = ([name, tally]: readonly [string, Tally]) => `  ${name.padEnd(28)} ${formatTokens(tally.write).padStart(6)}  ${tally.steps} steps`

/** The summary as the script prints it, with the `top` session-hours and segments. */
export const render = (summary: Summary, top: number): string => {
  if (summary.lines === 0) return "no ledger lines in the window"
  return [
    `cache writes: ${formatTokens(summary.write)} tokens over ${summary.lines} requests`,
    "by cause:",
    ...summary.byCause.map(tallyText),
    "unexplained (login, prefix, unchanged) per host and day:",
    ...summary.byHostDay.map((day) => `  ${day.host.padEnd(16)} ${day.day}  ${formatTokens(day.unexplained).padStart(6)} of ${formatTokens(day.write)}`),
    ...(summary.bySegment.length === 0 ? [] : ["first changed segment:", ...summary.bySegment.slice(0, top).map(tallyText)]),
    "top session-hours:",
    ...summary.sessionHours.slice(0, top).map(
      (entry) =>
        `  ${entry.host} ${entry.hour}  ${entry.sessionID}  ${formatTokens(entry.write)}  ${Object.entries(entry.byCause)
          .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
          .map(([cause, tokens]) => `${cause} ${formatTokens(tokens ?? 0)}`)
          .join(" · ")}`,
    ),
  ].join("\n")
}
