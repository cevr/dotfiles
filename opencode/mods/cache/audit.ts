// The ledger audited over a window, for the weekly dream: the hit rate
// (cache reads over every prompt token) overall, per host, agent and model;
// the share of the prompt's cost cache writes took; and the breaks, requests
// of a session whose cache read fell sharply against the request before it,
// each classified by its likely cause and ranked by the tokens it wrote again.
// `scripts/cache-audit.ts` prints it.
//
// The break is found from the tokens alone, not from the ledger's `cause`, so
// a line the server judged wrongly still counts; the cause reads the line's
// evidence (model, kind, gap, lifetime, login, first changed segment).
import { formatTokens } from "./line.ts"
import { NOISE_FLOOR_TOKENS } from "./miss.ts"
import type { LedgerLine } from "./request-log.ts"
import { segmentKey } from "./summary.ts"

/** A miss is sharp when it is at least this share of the prompt both requests share, and above the noise floor. */
export const SHARP_SHARE = 0.2

/** The agents a person talks to: a session's first request on another agent is a subagent's. */
export const PRIMARY_AGENTS: ReadonlySet<string> = new Set(["build", "plan"])

const HOUR_MS = 3_600_000

/**
 * Anthropic's list price multipliers over the input rate (Prompt caching,
 * Pricing): a read 0.1×, a 5-minute write 1.25×, a 1-hour write 2×. Costs here
 * are in input-token equivalents, so no catalog is needed.
 */
export const PRICE = { input: 1, read: 0.1, write5m: 1.25, write1h: 2 } as const

export const writeMultiplier = (ttlMs: number): number => (ttlMs >= HOUR_MS ? PRICE.write1h : PRICE.write5m)

/**
 * Why a session's cache read fell, first match wins:
 * - `model-switch`: the request went to another model.
 * - `compaction`: it is a compaction's summary request, or the first after one.
 * - `ttl-expiry`: it went out after the previous request's lifetime ran out (an idle gap).
 * - `login-move`: the pool sent it on another login (a cache belongs to one organisation).
 * - `ttl-switch`: it asked for another cache lifetime than the request before
 *   (Anthropic keeps a cache per lifetime: a 5-minute prompt is not read by a
 *   request that asks for the hour).
 * - `restart`: the server judged it a session's first request although the
 *   ledger holds an earlier one, or judged it against a request it read back
 *   from the ledger (`restored`): OpenCode restarted between them, and the
 *   prompt it rebuilt was not the one cached (the segment, when restored).
 * - `tool-set`: the first changed segment is a tool (one added, removed or redescribed).
 * - `system-prompt`: the first changed segment is in the system prompt.
 * - `message-edit`: the first changed segment is an earlier message.
 * - `dropped`: the prompt held, or the line names no change: the provider lost it.
 */
export type BreakCause =
  | "model-switch"
  | "compaction"
  | "ttl-expiry"
  | "login-move"
  | "ttl-switch"
  | "restart"
  | "tool-set"
  | "system-prompt"
  | "message-edit"
  | "dropped"

/** A session's first request: `subagent-first` on an agent outside `PRIMARY_AGENTS`, which shares no prefix with its parent. */
export type ColdCause = "subagent-first" | "session-start"

export type Cause = BreakCause | ColdCause

export interface Break {
  readonly host: string
  readonly sessionID: string
  readonly agent: string
  readonly model: string
  readonly at: number
  readonly cause: Cause
  /** Since the previous request of the session went out; none for a first request. */
  readonly gapMs?: number
  /** The lifetime the previous request asked for. */
  readonly ttlMs: number
  readonly prompt: number
  readonly read: number
  readonly write: number
  /** Prompt tokens the previous request cached that this one did not read; a first request's whole prompt. */
  readonly missed: number
  /** The missed tokens it wrote to the cache again: `min(write, missed)`. */
  readonly wasted: number
  /** The first changed segment, message indexes folded (`messages[i] user part 0 (text)`). */
  readonly segment?: string
  readonly head?: string
}

/** Why the read fell from `previous` to `line`, by the order `BreakCause` gives. */
export const classify = (previous: LedgerLine, line: LedgerLine): BreakCause => {
  if (line.model !== previous.model) return "model-switch"
  if (line.kind === "compaction" || previous.kind === "compaction" || line.cause === "compaction") return "compaction"
  if (line.at - previous.at > previous.ttlMs) return "ttl-expiry"
  if (line.login !== undefined && previous.login !== undefined && line.login !== previous.login) return "login-move"
  if (line.ttlMs !== previous.ttlMs) return "ttl-switch"
  if (line.cause === "first" || line.restored === true) return "restart"
  const segment = line.change?.segment
  if (segment === undefined || segment === "end of prompt") return "dropped"
  if (segment.startsWith("tool ")) return "tool-set"
  if (segment.startsWith("system")) return "system-prompt"
  return "message-edit"
}

/**
 * The break `line` is against the session's request before it, if its read
 * fell sharply: the missed part of the prompt both share is above the noise
 * floor and at least `SHARP_SHARE` of it. Undefined for a hit, or for a
 * session that reported no cache activity on either request.
 */
export const detect = (previous: LedgerLine, line: LedgerLine): Break | undefined => {
  if (line.read + line.write === 0 && previous.read + previous.write === 0) return undefined
  const shared = Math.min(previous.prompt, line.prompt)
  const missed = shared - line.read
  if (missed <= NOISE_FLOOR_TOKENS || missed < shared * SHARP_SHARE) return undefined
  const change = line.change
  return {
    host: line.host,
    sessionID: line.sessionID,
    agent: line.agent,
    model: line.model,
    at: line.at,
    cause: classify(previous, line),
    gapMs: Math.max(0, line.at - previous.at),
    ttlMs: previous.ttlMs,
    prompt: line.prompt,
    read: line.read,
    write: line.write,
    missed,
    wasted: Math.min(line.write, missed),
    ...(change === undefined ? {} : { segment: segmentKey(change.segment), ...(change.head === undefined ? {} : { head: change.head }) }),
  }
}

/** A session's first request, as the cold start it is. */
export const coldStart = (line: LedgerLine, primary: ReadonlySet<string> = PRIMARY_AGENTS): Break => ({
  host: line.host,
  sessionID: line.sessionID,
  agent: line.agent,
  model: line.model,
  at: line.at,
  cause: primary.has(line.agent) ? "session-start" : "subagent-first",
  ttlMs: line.ttlMs,
  prompt: line.prompt,
  read: line.read,
  write: line.write,
  missed: line.prompt - line.read,
  wasted: line.write,
})

export interface Usage {
  readonly requests: number
  readonly prompt: number
  readonly read: number
  readonly write: number
  /** Prompt tokens neither read nor written: `prompt - read - write`. */
  readonly uncached: number
  /** `read / (read + write + uncached)`. */
  readonly hitRate: number
  /** `write / prompt`. */
  readonly writeShare: number
  /** The writes' share of the prompt's cost, at `PRICE`. */
  readonly writeCostShare: number
}

export const usageOf = (lines: ReadonlyArray<LedgerLine>): Usage => {
  let prompt = 0
  let read = 0
  let write = 0
  let uncached = 0
  let writeCost = 0
  for (const line of lines) {
    prompt += line.prompt
    read += line.read
    write += line.write
    uncached += Math.max(0, line.prompt - line.read - line.write)
    writeCost += line.write * writeMultiplier(line.ttlMs)
  }
  const cost = uncached * PRICE.input + read * PRICE.read + writeCost
  return {
    requests: lines.length,
    prompt,
    read,
    write,
    uncached,
    hitRate: prompt === 0 ? 0 : read / prompt,
    writeShare: prompt === 0 ? 0 : write / prompt,
    writeCostShare: cost === 0 ? 0 : writeCost / cost,
  }
}

export interface CauseTally {
  readonly cause: Cause
  readonly count: number
  readonly missed: number
  readonly wasted: number
  /** The first changed segments, most wasted first. */
  readonly segments: ReadonlyArray<{ readonly segment: string; readonly count: number; readonly wasted: number }>
}

export interface SessionTally {
  readonly host: string
  readonly sessionID: string
  readonly agent: string
  readonly requests: number
  readonly hitRate: number
  readonly breaks: number
  /** Written again by its mid-session breaks; its first request is not counted. */
  readonly wasted: number
  readonly causes: Readonly<Partial<Record<Cause, number>>>
}

/**
 * The lifetime trade for requests that asked for less than an hour (the
 * orchestrate roles' 5 minutes): what their writes would cost more at the
 * hour's 2× against what their expiries inside an hour cost, in input-token
 * equivalents. An expiry inside the hour would have read (0.1×) what it wrote.
 */
export interface LifetimeTrade {
  readonly requests: number
  readonly write: number
  /** `write × (2 − 1.25)`. */
  readonly extraAtHour: number
  /** Expiries whose gap an hour would have covered. */
  readonly expiriesInsideHour: number
  /** Their wasted tokens × (1.25 − 0.1). */
  readonly savedAtHour: number
}

export interface Audit {
  readonly since: number
  readonly overall: Usage
  readonly byHost: ReadonlyArray<readonly [string, Usage]>
  readonly byAgent: ReadonlyArray<readonly [string, Usage]>
  readonly byModel: ReadonlyArray<readonly [string, Usage]>
  /** Mid-session breaks: what the north star counts. */
  readonly breaks: { readonly count: number; readonly missed: number; readonly wasted: number; readonly byCause: ReadonlyArray<CauseTally> }
  /** First requests of sessions, by kind. */
  readonly coldStarts: ReadonlyArray<CauseTally>
  /** Most wasted first. */
  readonly topSessions: ReadonlyArray<SessionTally>
  /** The biggest single breaks. */
  readonly topBreaks: ReadonlyArray<Break>
  readonly shortLifetime: LifetimeTrade
}

const groupBy = <T, K>(items: ReadonlyArray<T>, key: (item: T) => K): Map<K, Array<T>> => {
  const groups = new Map<K, Array<T>>()
  for (const item of items) {
    const k = key(item)
    const group = groups.get(k)
    if (group === undefined) groups.set(k, [item])
    else group.push(item)
  }
  return groups
}

const usageBy = (lines: ReadonlyArray<LedgerLine>, key: (line: LedgerLine) => string) =>
  [...groupBy(lines, key)].map(([name, group]) => [name, usageOf(group)] as const).sort((a, b) => b[1].prompt - a[1].prompt)

const tallyCauses = (breaks: ReadonlyArray<Break>): ReadonlyArray<CauseTally> =>
  [...groupBy(breaks, (entry) => entry.cause)]
    .map(([cause, group]) => {
      const segments = [...groupBy(group, (entry) => entry.segment)]
        .flatMap(([segment, list]) => (segment === undefined ? [] : [{ segment, count: list.length, wasted: list.reduce((sum, entry) => sum + entry.wasted, 0) }]))
        .sort((a, b) => b.wasted - a.wasted)
      return {
        cause,
        count: group.length,
        missed: group.reduce((sum, entry) => sum + entry.missed, 0),
        wasted: group.reduce((sum, entry) => sum + entry.wasted, 0),
        segments,
      }
    })
    .sort((a, b) => b.wasted - a.wasted)

export interface AuditOptions {
  readonly since: number
  readonly host?: string
  readonly top?: number
  readonly primary?: ReadonlySet<string>
}

/**
 * Audit the lines from `since` on (of `host` when named). Each session's
 * requests are ordered by when they went out, and each is held against the
 * one before it in the whole ledger, so a session that began before the
 * window is not counted as starting in it.
 */
export const audit = (lines: ReadonlyArray<LedgerLine>, options: AuditOptions): Audit => {
  const top = options.top ?? 10
  const primary = options.primary ?? PRIMARY_AGENTS
  const scoped = options.host === undefined ? lines : lines.filter((line) => line.host === options.host)
  const kept: Array<LedgerLine> = []
  const breaks: Array<Break> = []
  const colds: Array<Break> = []
  const sessions: Array<SessionTally> = []
  for (const group of groupBy(scoped, (line) => `${line.host}\u0000${line.sessionID}`).values()) {
    const ordered = group.toSorted((a, b) => a.at - b.at)
    const inWindow: Array<LedgerLine> = []
    const own: Array<Break> = []
    let previous: LedgerLine | undefined
    for (const line of ordered) {
      const before = previous
      previous = line
      if (line.at < options.since) continue
      inWindow.push(line)
      if (before === undefined) {
        colds.push(coldStart(line, primary))
        continue
      }
      const found = detect(before, line)
      if (found !== undefined) own.push(found)
    }
    if (inWindow.length === 0) continue
    kept.push(...inWindow)
    breaks.push(...own)
    const first = inWindow[0]
    const causes: Partial<Record<Cause, number>> = {}
    for (const entry of own) causes[entry.cause] = (causes[entry.cause] ?? 0) + entry.wasted
    sessions.push({
      host: first?.host ?? "",
      sessionID: first?.sessionID ?? "",
      agent: first?.agent ?? "",
      requests: inWindow.length,
      hitRate: usageOf(inWindow).hitRate,
      breaks: own.length,
      wasted: own.reduce((sum, entry) => sum + entry.wasted, 0),
      causes,
    })
  }
  const short = kept.filter((line) => line.ttlMs < HOUR_MS && line.write > 0)
  const insideHour = breaks.filter((entry) => entry.cause === "ttl-expiry" && entry.ttlMs < HOUR_MS && (entry.gapMs ?? Infinity) <= HOUR_MS)
  const shortWrite = short.reduce((sum, line) => sum + line.write, 0)
  return {
    since: options.since,
    overall: usageOf(kept),
    byHost: usageBy(kept, (line) => line.host),
    byAgent: usageBy(kept, (line) => line.agent),
    byModel: usageBy(kept, (line) => line.model),
    breaks: {
      count: breaks.length,
      missed: breaks.reduce((sum, entry) => sum + entry.missed, 0),
      wasted: breaks.reduce((sum, entry) => sum + entry.wasted, 0),
      byCause: tallyCauses(breaks),
    },
    coldStarts: tallyCauses(colds),
    topSessions: sessions.filter((session) => session.wasted > 0).sort((a, b) => b.wasted - a.wasted).slice(0, top),
    topBreaks: breaks.toSorted((a, b) => b.wasted - a.wasted).slice(0, top),
    shortLifetime: {
      requests: short.length,
      write: shortWrite,
      extraAtHour: Math.round(shortWrite * (PRICE.write1h - PRICE.write5m)),
      expiriesInsideHour: insideHour.length,
      savedAtHour: Math.round(insideHour.reduce((sum, entry) => sum + entry.wasted, 0) * (PRICE.write5m - PRICE.read)),
    },
  }
}

const percent = (share: number) => `${(share * 100).toFixed(2)}%`

const usageText = (name: string, usage: Usage) =>
  `  ${name.padEnd(28)} hit ${percent(usage.hitRate).padStart(7)}  write ${formatTokens(usage.write).padStart(6)} (${percent(usage.writeShare)} of prompt, ${percent(usage.writeCostShare)} of cost)  ${usage.requests} req`

const causeText = (tally: CauseTally) =>
  `  ${tally.cause.padEnd(16)} ${String(tally.count).padStart(4)} × wasted ${formatTokens(tally.wasted).padStart(6)}${
    tally.segments.length === 0 ? "" : `  at ${tally.segments.slice(0, 3).map((entry) => `${entry.segment} (${entry.count})`).join(", ")}`
  }`

const minutes = (ms: number | undefined) => (ms === undefined ? "-" : `${Math.round(ms / 60_000)}m`)

/** The audit as the script prints it. */
export const renderAudit = (result: Audit): string => {
  if (result.overall.requests === 0) return "no ledger lines in the window"
  const trade = result.shortLifetime
  return [
    `since ${new Date(result.since).toISOString()}: ${result.overall.requests} requests`,
    usageText("overall", result.overall),
    "per host:",
    ...result.byHost.map(([name, usage]) => usageText(name, usage)),
    "per agent:",
    ...result.byAgent.map(([name, usage]) => usageText(name, usage)),
    "per model:",
    ...result.byModel.map(([name, usage]) => usageText(name, usage)),
    `breaks mid-session: ${result.breaks.count}, wasted ${formatTokens(result.breaks.wasted)} written again (${formatTokens(result.breaks.missed)} missed)`,
    ...result.breaks.byCause.map(causeText),
    "cold starts (first request of a session):",
    ...result.coldStarts.map(causeText),
    `lifetimes under 1h: ${trade.requests} req wrote ${formatTokens(trade.write)}; at 1h they pay ${formatTokens(trade.extraAtHour)} more and save ${formatTokens(trade.savedAtHour)} on ${trade.expiriesInsideHour} expiries inside the hour (input-token equivalents)`,
    "top sessions by wasted writes:",
    ...result.topSessions.map(
      (session) =>
        `  ${session.host} ${session.sessionID} ${session.agent.padEnd(12)} ${formatTokens(session.wasted).padStart(6)}  ${session.breaks} breaks  hit ${percent(session.hitRate)}  ${Object.entries(session.causes)
          .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
          .map(([cause, tokens]) => `${cause} ${formatTokens(tokens ?? 0)}`)
          .join(" · ")}`,
    ),
    "top breaks:",
    ...result.topBreaks.map(
      (entry) =>
        `  ${new Date(entry.at).toISOString().slice(0, 16)} ${entry.sessionID} ${entry.agent.padEnd(12)} ${entry.cause.padEnd(14)} ${formatTokens(entry.wasted).padStart(6)}  gap ${minutes(entry.gapMs)} ttl ${minutes(entry.ttlMs)}${entry.segment === undefined ? "" : `  at ${entry.segment}`}`,
    ),
  ].join("\n")
}
