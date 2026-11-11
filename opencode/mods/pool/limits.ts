// What each model family costs in percentage points of ONE account's usage
// limit per million tokens, per window (the shared week, a model's own week,
// the 5-hour window). Pure: the pool's Limits store (opencode/limits.ts) feeds
// it the readings and the tokens each request used, and the CLI view
// (opencode/scripts/pool-limits.ts) feeds it a copy of the owner's database.
//
// - A row is one window period of one account: the utilization its last
//   reading in the period showed (whole points, read since the period began),
//   against the tokens every host sent on that account from the period's
//   start (its reset less its length) to that reading. A whole period's rise
//   is many points, so readings coarse to 1 point cost little precision, and
//   no reading history is needed.
// - Several models on one account: the rates are solved as non-negative least
//   squares over the rows of a pool and window (rise ≈ Σ rate_f × Mtok_f), not
//   by splitting a rise by list price: a split by price would presuppose the
//   answer (that limit cost follows price). The range is the 95% interval from
//   the fit's standard errors; `n` counts the rows the family has tokens in.
// - A reset inside a period (utilization falls under the same reset time, as a
//   claimed reset does): the row is dropped. A period that began before the
//   tokens were recorded (on this host or on a peer) is dropped.
// - Tokens are weighed two ways: raw (every token, cache reads included), and
//   input-equivalent at the model's list price (cost ÷ input price), so cache
//   reads do not dominate. The headline rate is per weighted Mtok.
import { limitsModel, scopeOf, type QuotaReading } from "./quota.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** How long the tokens of each request are kept: a week's period and a day of slack. */
export const USE_KEPT_MS = 8 * DAY
/** The span of the recent tally: rows whose period ended (or is open) in the last 7 days. */
export const RECENT_MS = 7 * DAY
/** A period's reset time as read can move by a little between readings: one period's resets round to this. */
const RESET_ROUND_MS = 10 * MINUTE
/** A fall of more than this (points) under the same reset is a reset inside the period. */
const FALL_POINTS = 1.5
/** A family's share of a window's weighted tokens under which it is left out of the fit. */
export const MIN_SHARE = 0.01
/** A row's sums are recounted while its period ended less than this ago; older rows are final. */
const OPEN_MS = DAY

/** Tokens of one request; `output` counts reasoning too. */
export interface Tokens {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/** One request a pool served: on which account, of which model, with its tokens, ended at `at` (epoch ms). */
export interface Use {
  readonly at: number
  readonly pool: string
  readonly credentialID: string
  readonly model: string
  readonly tokens: Tokens
}

/**
 * $ per million tokens: input, cache write (shortest lifetime), cache read,
 * output. The rows of skills/orchestrate/scripts/models/prices.ts (claude-api
 * skill's table and models.dev, read 2026-11-09; OpenAI's Standard row, read
 * 2026-10-30). A model with no row weighs as its family's row, else raw.
 */
export const PRICE: Readonly<Record<string, readonly [number, number, number, number]>> = {
  "claude-opus-5-5": [4, 5, 0.2, 20],
  "claude-sonnet-5-5": [2, 2.5, 0.2, 10],
  "claude-haiku-5-5": [0.1, 0.125, 0.01, 0.5],
  "claude-fable-5-1": [10, 12.5, 0.25, 50],
  "claude-fable-5-2": [8, 10, 0.2, 40],
  "gpt-6.1-sol": [2, 2.5, 0.1, 10],
  "gpt-6-luna": [0.1, 0.125, 0.01, 0.5],
  "gpt-6-astra": [10, 12.5, 1, 50],
  "gpt-5.6-luna": [0.2, 0.25, 0.02, 1.2],
}

/**
 * A model's family, as the tally names it: a Claude model by its name
 * (`claude-opus-5-5` → `Opus`), a GPT model by what follows its version
 * (`gpt-6.1-sol` → `sol`, `gpt-6.1-sol-ultrafast` → `sol-ultrafast`), any
 * other by its id.
 */
export const familyOf = (model: string): string => {
  const id = model.replace(/^[\w-]+\//, "").toLowerCase()
  const claude = /^claude-([a-z]+)/.exec(id)
  if (claude?.[1] !== undefined) return claude[1].charAt(0).toUpperCase() + claude[1].slice(1)
  const gpt = /^gpt-[\d.]+-(.+)$/.exec(id)
  if (gpt?.[1] !== undefined) return gpt[1]
  return id
}

/** The model's price row: its own, else a row of its family or of the family it extends (`sol-ultrafast` → `sol`). */
const priceOf = (model: string): readonly [number, number, number, number] | undefined => {
  const own = PRICE[model.replace(/^[\w-]+\//, "")]
  if (own !== undefined) return own
  let family = familyOf(model)
  for (;;) {
    const row = Object.entries(PRICE).find(([id]) => familyOf(id) === family)?.[1]
    if (row !== undefined) return row
    const cut = family.lastIndexOf("-")
    if (cut <= 0) return undefined
    family = family.slice(0, cut)
  }
}

/** Every token, cache reads included. */
export const rawOf = (tokens: Tokens): number => tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite

/** Input-equivalent tokens: the tokens' list price over the model's input price; raw when the model has no price. */
export const weightedOf = (model: string, tokens: Tokens): number => {
  const price = priceOf(model)
  if (price === undefined || price[0] <= 0) return rawOf(tokens)
  const [input, write, read, output] = price
  return tokens.input + (tokens.cacheWrite * write + tokens.cacheRead * read + tokens.output * output) / input
}

/** Tokens per family: input-equivalent (`w`) and raw. */
export type Sums = Readonly<Record<string, { readonly w: number; readonly raw: number }>>

/** A window's length from its name (`5h`, `7d`, `300m`, `7d:Fable`); none for a name that names no length. */
export const windowMs = (name: string): number | undefined => {
  const match = /^(\d+)([mhd])(?::|$)/.exec(name)
  if (match === null) return undefined
  const amount = Number(match[1])
  return amount * (match[2] === "m" ? MINUTE : match[2] === "h" ? HOUR : DAY)
}

/** One window period of one account: what its last reading showed, and the tokens sent on the account in it. */
export interface LimitRow {
  readonly pool: string
  readonly credentialID: string
  readonly window: string
  /** The period's start: its reset less the window's length. */
  readonly start: number
  readonly resetAt: number
  /** The last reading in the period, epoch ms. */
  readonly at: number
  /** Points of the limit used at `at` (0 to 100). */
  readonly rise: number
  /** A reset came inside the period: its start is not known, and the row is left out. */
  readonly broken?: boolean
  /** This host's tokens on the account from `start` to `at`. */
  readonly own: Sums
  /** Each peer host's, as its last report said. */
  readonly peers: Readonly<Record<string, Sums>>
}

/** What the tally keeps between processes: since when this host records tokens, each peer's, and every row. */
export interface LimitsState {
  readonly since: number
  readonly peerSince: Readonly<Record<string, number>>
  readonly rows: Readonly<Record<string, LimitRow>>
}

export const emptyState = (since: number): LimitsState => ({ since, peerSince: {}, rows: {} })

/** A row's key: the pool, the account, the window and its period (the reset, rounded). */
export const rowKey = (pool: string, credentialID: string, window: string, resetAt: number) =>
  `${pool}|${credentialID}|${window}|${Math.round(resetAt / RESET_ROUND_MS) * RESET_ROUND_MS}`

/**
 * The state with a reading of one account taken in: each window with a reset
 * and a length is its period's newest reading. An older reading changes
 * nothing; a fall under the same reset breaks the row.
 */
export const observe = (state: LimitsState, pool: string, credentialID: string, reading: QuotaReading): LimitsState => {
  let rows: Record<string, LimitRow> | undefined
  for (const window of reading.windows) {
    const length = windowMs(window.name)
    if (window.resetAt === undefined || length === undefined) continue
    const key = rowKey(pool, credentialID, window.name, window.resetAt)
    const held = (rows ?? state.rows)[key]
    if (held !== undefined && held.at >= reading.at) continue
    const rise = window.utilization * 100
    const broken = held?.broken === true || (held !== undefined && rise < held.rise - FALL_POINTS)
    rows ??= { ...state.rows }
    rows[key] = {
      pool,
      credentialID,
      window: window.name,
      start: window.resetAt - length,
      resetAt: window.resetAt,
      at: reading.at,
      rise,
      ...(broken ? { broken: true } : {}),
      own: held?.own ?? {},
      peers: held?.peers ?? {},
    }
  }
  return rows === undefined ? state : { ...state, rows }
}

/** Whether a window counts a model's tokens: a model's own window (`7d:Fable`) counts only that model's. */
const counts = (window: string, model: string): boolean => {
  const scope = scopeOf(window)
  return scope === undefined || limitsModel(scope, model)
}

const add = (sums: Record<string, { w: number; raw: number }>, use: Use) => {
  const family = familyOf(use.model)
  const held = sums[family] ?? { w: 0, raw: 0 }
  sums[family] = { w: held.w + weightedOf(use.model, use.tokens), raw: held.raw + rawOf(use.tokens) }
}

/** The tokens `uses` sent on the row's account from its start to its last reading, of the models its window counts. */
export const sumsOf = (row: Pick<LimitRow, "pool" | "credentialID" | "window" | "start" | "at">, uses: Iterable<Use>): Sums => {
  const sums: Record<string, { w: number; raw: number }> = {}
  for (const use of uses)
    if (use.pool === row.pool && use.credentialID === row.credentialID && use.at > row.start && use.at <= row.at && counts(row.window, use.model))
      add(sums, use)
  return sums
}

/** The state with this host's sums of every row still open (its period ended less than a day ago) counted again from `uses`. */
export const recount = (state: LimitsState, uses: ReadonlyArray<Use>, now: number): LimitsState => {
  const byAccount = new Map<string, Array<Use>>()
  for (const use of uses) {
    const key = `${use.pool}|${use.credentialID}`
    const list = byAccount.get(key)
    if (list === undefined) byAccount.set(key, [use])
    else list.push(use)
  }
  const rows: Record<string, LimitRow> = {}
  for (const [key, row] of Object.entries(state.rows))
    rows[key] = row.resetAt < now - OPEN_MS ? row : { ...row, own: sumsOf(row, byAccount.get(`${row.pool}|${row.credentialID}`) ?? []) }
  return { ...state, rows }
}

/** One open row's sums, as a host reports them to its peers. */
export interface PeriodUse {
  readonly key: string
  readonly sums: Sums
}

/** What a host tells its peers: since when it records tokens, and its sums of each row still open. */
export interface LimitsReport {
  readonly since: number
  readonly rows: ReadonlyArray<PeriodUse>
}

export const reportOf = (state: LimitsState, now: number): LimitsReport => ({
  since: state.since,
  rows: Object.entries(state.rows).flatMap(([key, row]) =>
    row.resetAt >= now - OPEN_MS && Object.keys(row.own).length > 0 ? [{ key, sums: row.own }] : [],
  ),
})

/** A row key without its login: the pool, the window and the period. */
const periodOf = (key: string) => {
  const [pool, , ...rest] = key.split("|")
  return [pool, ...rest].join("|")
}

/**
 * The state with a peer's report taken in: its sums on each row this host
 * holds. A host may know one account by another login id (a ChatGPT account
 * signed in on each host has an id per host): a row the peer names that this
 * host does not hold is the one row here of the same pool, window and period,
 * when there is exactly one.
 */
export const takePeer = (state: LimitsState, peer: string, report: LimitsReport): LimitsState => {
  const rows: Record<string, LimitRow> = { ...state.rows }
  const byPeriod = new Map<string, Array<string>>()
  for (const key of Object.keys(rows)) byPeriod.set(periodOf(key), [...(byPeriod.get(periodOf(key)) ?? []), key])
  for (const { key, sums } of report.rows) {
    const same = byPeriod.get(periodOf(key)) ?? []
    const target = rows[key] !== undefined ? key : same.length === 1 ? same[0] : undefined
    const row = target === undefined ? undefined : rows[target]
    if (target !== undefined && row !== undefined) rows[target] = { ...row, peers: { ...row.peers, [peer]: sums } }
  }
  return { ...state, peerSince: { ...state.peerSince, [peer]: report.since }, rows }
}

/** The state with every row of the account whose period a reset claimed at `at` cut short broken: its start is not known. */
export const resetInside = (state: LimitsState, pool: string, credentialID: string, at: number): LimitsState => ({
  ...state,
  rows: Object.fromEntries(
    Object.entries(state.rows).map(([key, row]) => [
      key,
      row.pool === pool && row.credentialID === credentialID && row.start < at && at <= row.at ? { ...row, broken: true } : row,
    ]),
  ),
})

const total = (sums: Sums | undefined) => Object.values(sums ?? {}).reduce((sum, family) => sum + family.raw, 0)

/** Two states of the same host (two plugin instances, or the file and memory) as one: per row the newer reading and the larger sums. */
export const merge = (left: LimitsState, right: LimitsState): LimitsState => {
  const rows: Record<string, LimitRow> = { ...left.rows }
  for (const [key, row] of Object.entries(right.rows)) {
    const held = rows[key]
    if (held === undefined) {
      rows[key] = row
      continue
    }
    const newer = row.at > held.at ? row : held
    const peers: Record<string, Sums> = { ...held.peers }
    for (const [peer, sums] of Object.entries(row.peers)) if (total(sums) >= total(peers[peer])) peers[peer] = sums
    rows[key] = {
      ...newer,
      ...(held.broken === true || row.broken === true ? { broken: true } : {}),
      own: total(row.own) >= total(held.own) ? row.own : held.own,
      peers,
    }
  }
  return { since: Math.min(left.since, right.since), peerSince: { ...left.peerSince, ...right.peerSince }, rows }
}

// ── The fit ──

/** One family's rate on one window: points per Mtok, with its 95% range when the fit has one. */
export interface Rate {
  readonly rate: number
  readonly low?: number
  readonly high?: number
}

export interface FamilyEstimate {
  readonly family: string
  /** Points of one account's limit per million input-equivalent tokens. */
  readonly weighted: Rate
  /** Points per million raw tokens (cache reads included). */
  readonly raw: Rate
  /** Rows the family has tokens in. */
  readonly n: number
  /** The family's tokens over those rows, in millions. */
  readonly mtok: number
  readonly rawMtok: number
}

export interface WindowTally {
  readonly pool: string
  readonly window: string
  /** Rows fitted. */
  readonly rows: number
  readonly families: ReadonlyArray<FamilyEstimate>
  /** Families with under MIN_SHARE of the window's tokens, left out of the fit (their tokens too), with their Mtok. */
  readonly ignored?: ReadonlyArray<{ readonly family: string; readonly mtok: number }>
}

/** The tally: the rows of the last 7 days, and every row kept. */
export interface Tally {
  readonly at: number
  /** Since when this host records tokens. */
  readonly since: number
  /** The peers whose tokens count, each since when. */
  readonly peers: Readonly<Record<string, number>>
  readonly recent: ReadonlyArray<WindowTally>
  readonly cumulative: ReadonlyArray<WindowTally>
}

/** Two-sided 95% t quantiles by degrees of freedom; 1.96 past 30. */
const T95 = [12.71, 4.3, 3.18, 2.78, 2.57, 2.45, 2.36, 2.31, 2.26, 2.23, 2.2, 2.18, 2.16, 2.14, 2.13, 2.12, 2.11, 2.1, 2.09, 2.09]
const t95 = (df: number) => (df <= 0 ? Number.NaN : df <= T95.length ? T95[df - 1]! : df <= 30 ? 2.04 : 1.96)

/** The inverse of a small symmetric matrix by Gauss–Jordan; none when singular. */
const inverse = (a: ReadonlyArray<ReadonlyArray<number>>): number[][] | undefined => {
  const n = a.length
  const m = a.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r
    const scale = Math.max(...a.map((row) => Math.abs(row[c]!)), 1e-300)
    if (Math.abs(m[p]![c]!) < 1e-12 * scale) return undefined
    ;[m[c], m[p]] = [m[p]!, m[c]!]
    const pivot = m[c]![c]!
    for (let j = 0; j < 2 * n; j++) m[c]![j]! /= pivot
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = m[r]![c]!
      if (f !== 0) for (let j = 0; j < 2 * n; j++) m[r]![j]! -= f * m[c]![j]!
    }
  }
  return m.map((row) => row.slice(n))
}

/** A fit's points: the rise, and each column's Mtok. */
export interface Point {
  readonly y: number
  readonly x: ReadonlyArray<number>
}

/**
 * Non-negative least squares through the origin over few columns: the best
 * free fit among every subset of them whose rates are all at least 0, with
 * each rate's 95% range from the residual's variance (none with no degree of
 * freedom left). A column left out of the best subset rates 0.
 */
export const nnls = (points: ReadonlyArray<Point>, columns: number): ReadonlyArray<Rate> => {
  const sse = (k: ReadonlyArray<number>) => points.reduce((sum, p) => sum + (p.y - p.x.reduce((s, x, j) => s + x * (k[j] ?? 0), 0)) ** 2, 0)
  let best: { k: number[]; cols: number[]; inv?: number[][]; sse: number } = {
    k: Array.from({ length: columns }, () => 0),
    cols: [],
    sse: sse([]),
  }
  for (let mask = 1; mask < 1 << columns; mask++) {
    const cols = [...Array(columns).keys()].filter((j) => mask & (1 << j))
    const xtx = cols.map((i) => cols.map((j) => points.reduce((s, p) => s + p.x[i]! * p.x[j]!, 0)))
    const xty = cols.map((i) => points.reduce((s, p) => s + p.x[i]! * p.y, 0))
    const inv = inverse(xtx)
    if (inv === undefined) continue
    const solved = inv.map((row) => row.reduce((s, v, j) => s + v * xty[j]!, 0))
    if (solved.some((v) => !(v >= 0))) continue
    const k = Array.from({ length: columns }, () => 0)
    cols.forEach((j, i) => (k[j] = solved[i]!))
    const error = sse(k)
    if (error < best.sse - 1e-12) best = { k, cols, inv, sse: error }
  }
  const df = points.length - best.cols.length
  const variance = df > 0 ? best.sse / df : Number.NaN
  return best.k.map((rate, j) => {
    const at = best.cols.indexOf(j)
    if (at < 0 || best.inv === undefined || !Number.isFinite(variance)) return { rate }
    const half = t95(df) * Math.sqrt(Math.max(variance * best.inv[at]![at]!, 0))
    return { rate, low: Math.max(rate - half, 0), high: rate + half }
  })
}

/** A row's tokens of every host. */
const allSums = (row: LimitRow): Record<string, { w: number; raw: number }> => {
  const sums: Record<string, { w: number; raw: number }> = {}
  for (const part of [row.own, ...Object.values(row.peers)])
    for (const [family, value] of Object.entries(part)) {
      const held = sums[family] ?? { w: 0, raw: 0 }
      sums[family] = { w: held.w + value.w, raw: held.raw + value.raw }
    }
  return sums
}

/** Whether a row is fitted: not broken, and its period began after every host whose tokens it counts began recording. */
export const usable = (state: Pick<LimitsState, "since" | "peerSince">, row: LimitRow): boolean =>
  row.broken !== true && row.start >= state.since && Object.values(state.peerSince).every((since) => row.start >= since)

/** Each pool and window's rates over `rows`. */
export const fitRows = (rows: ReadonlyArray<LimitRow>): ReadonlyArray<WindowTally> => {
  const groups = new Map<string, Array<LimitRow>>()
  for (const row of rows) {
    const key = `${row.pool}|${row.window}`
    const list = groups.get(key)
    if (list === undefined) groups.set(key, [row])
    else list.push(row)
  }
  return [...groups.values()]
    .map((group): WindowTally => {
      const sums = group.map(allSums)
      const seen = [...new Set(sums.flatMap((s) => Object.keys(s)))].sort()
      const weightOf = (family: string) => sums.reduce((t, s) => t + (s[family]?.w ?? 0), 0)
      const all = seen.reduce((t, family) => t + weightOf(family), 0)
      // A family with a sliver of the tokens cannot be told from noise: its column would soak up the residual.
      const families = seen.filter((family) => weightOf(family) >= MIN_SHARE * all)
      const ignored = seen.filter((family) => !families.includes(family)).map((family) => ({ family, mtok: weightOf(family) / 1e6 }))
      const weighted = nnls(group.map((row, i) => ({ y: row.rise, x: families.map((f) => (sums[i]![f]?.w ?? 0) / 1e6) })), families.length)
      const raw = nnls(group.map((row, i) => ({ y: row.rise, x: families.map((f) => (sums[i]![f]?.raw ?? 0) / 1e6) })), families.length)
      return {
        pool: group[0]!.pool,
        window: group[0]!.window,
        rows: group.length,
        families: families.map((family, j) => ({
          family,
          weighted: weighted[j]!,
          raw: raw[j]!,
          n: sums.filter((s) => (s[family]?.raw ?? 0) > 0).length,
          mtok: sums.reduce((t, s) => t + (s[family]?.w ?? 0), 0) / 1e6,
          rawMtok: sums.reduce((t, s) => t + (s[family]?.raw ?? 0), 0) / 1e6,
        })),
        ...(ignored.length === 0 ? {} : { ignored }),
      }
    })
    .sort((a, b) => `${a.pool}|${a.window}`.localeCompare(`${b.pool}|${b.window}`))
}

/** The tally at `now`: the usable rows that are idle or not yet ended, of the last 7 days and of all time. */
export const tally = (state: LimitsState, now: number): Tally => {
  const rows = Object.values(state.rows).filter((row) => usable(state, row) && Object.keys(allSums(row)).length > 0)
  return {
    at: now,
    since: state.since,
    peers: state.peerSince,
    recent: fitRows(rows.filter((row) => row.resetAt >= now - RECENT_MS)),
    cumulative: fitRows(rows),
  }
}

/**
 * Weekly points per point of each model's own week in a pool, by the own
 * week's name (`7d:Fable`): the model's rate on the weekly window over its
 * rate on its own week, both per weighted Mtok of the same tokens. The range
 * divides the low end of one by the high end of the other, and the other way.
 * The last 7 days' fit when it has the model on both windows, else every
 * row's. None for a model either fit lacks or rates 0 on its own week.
 */
export const weeklyRatios = (
  tally: Tally,
  pool: string,
): Readonly<Record<string, { readonly rate: number; readonly low?: number; readonly high?: number; readonly source: "tally" }>> => {
  const ratios: Record<string, { rate: number; low?: number; high?: number; source: "tally" }> = {}
  for (const windows of [tally.cumulative, tally.recent]) {
    const weekly = windows.find((window) => window.pool === pool && window.window === "7d")
    if (weekly === undefined) continue
    for (const own of windows.filter((window) => window.pool === pool && window.window.startsWith("7d:"))) {
      const scope = scopeOf(own.window)
      if (scope === undefined) continue
      const ownRate = own.families.find((family) => family.n > 0 && limitsModel(scope, family.family))?.weighted
      const weeklyRate = weekly.families.find((family) => family.n > 0 && limitsModel(scope, family.family))?.weighted
      if (ownRate === undefined || weeklyRate === undefined || !(ownRate.rate > 0)) continue
      const low = weeklyRate.low !== undefined && ownRate.high !== undefined && ownRate.high > 0 ? weeklyRate.low / ownRate.high : undefined
      const high = weeklyRate.high !== undefined && ownRate.low !== undefined && ownRate.low > 0 ? weeklyRate.high / ownRate.low : undefined
      // The recent fit, read second, wins where it has the model.
      ratios[own.window] = { rate: weeklyRate.rate / ownRate.rate, ...(low === undefined ? {} : { low }), ...(high === undefined ? {} : { high }), source: "tally" }
    }
  }
  return ratios
}

// ── The line ──

const num = (value: number) => (value >= 10 ? value.toFixed(0) : value >= 1 ? value.toFixed(1) : value.toFixed(2))
const range = (rate: Rate) => (rate.low === undefined || rate.high === undefined ? "" : ` ${num(rate.low)}–${num(rate.high)}`)

/**
 * The tally on one line, per family on the shared week (`7d`), with a model's
 * own week after it: `limit/Mtok 7d: Opus 0.90% 0.70–1.1 n 12 · Fable 1.6% …
 * (own week 0.30%) · sol 0.40% n 3 (last 7 days)`. The 5-hour window when no
 * row of a week is usable yet. None when nothing is fitted.
 */
export const limitsLine = (tally: Tally): string | undefined => {
  const pick = (windows: ReadonlyArray<WindowTally>, name: string) => windows.filter((w) => w.window === name)
  const span = tally.recent.length > 0 ? "last 7 days" : "all rows"
  const windows = tally.recent.length > 0 ? tally.recent : tally.cumulative
  const shown = pick(windows, "7d").length > 0 ? "7d" : pick(windows, "5h").length > 0 ? "5h" : undefined
  if (shown === undefined) return undefined
  const parts = pick(windows, shown).flatMap((w) =>
    w.families
      .filter((f) => f.n > 0)
      .map((f) => {
        const own = windows.find((o) => o.pool === w.pool && o.window.startsWith(`${shown}:`) && o.families.some((g) => g.family === f.family && g.n > 0))
        const ownRate = own?.families.find((g) => g.family === f.family)?.weighted
        return `${f.family} ${num(f.weighted.rate)}%${range(f.weighted)} n ${f.n}${ownRate === undefined ? "" : ` (own week ${num(ownRate.rate)}%)`}`
      }),
  )
  return parts.length === 0 ? undefined : `limit/Mtok ${shown}: ${parts.join(" · ")} (${span})`
}
