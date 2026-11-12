#!/usr/bin/env bun
// The limit tally's view: what each model family costs in % of ONE account's
// usage limit per million tokens, per pool and window, with its 95% range and
// n (the window periods it has tokens in). The pool writes the tally on every
// sweep (`@dotfiles/opencode-pool/limits`); this fits that file's rows again,
// or computes the tally from one dump per host of the OpenCode database
// (pool-limits-dump.ts, run on a copy), the first host as this one. The file
// counts tokens only since its pool first ran (its `since`); a dump counts
// them from the oldest step the pool's ledger placed. After the windows, each
// model's weekly points per own-week point, and every window read with no row
// fitted yet, with why.
//
// Usage: bun pool-limits.ts [--file <limits.json>] [--json]
//        bun pool-limits.ts --dump <host>=<dump.json> [--dump <host>=<dump.json> ...] [--json]
// --json prints { line, tally } (and `hosts` from dumps): the dream reads it.
import { readFileSync } from "node:fs"
import {
  emptyState,
  limitsLine,
  observe,
  recount,
  reportOf,
  resetInside,
  takePeer,
  tally,
  waitingText,
  weeklyRatios,
  type LimitsState,
  type Rate,
  type Tally,
  type Use,
  type WindowTally,
} from "../mods/pool/limits.ts"
import { defaultPath, stateOf } from "../mods/pool/opencode/limits.ts"
import { asReading, type QuotaReading } from "../mods/pool/quota.ts"

interface Dump {
  readonly at: number
  readonly since: number
  /** Each login's newest reading on the host: its own (`own`), and what its peers reported. */
  readonly readings: ReadonlyArray<{ readonly pool: string; readonly credentialID: string; readonly reading: unknown; readonly own?: boolean }>
  readonly claims?: ReadonlyArray<{ readonly pool: string; readonly credentialID: string; readonly at: number }>
  readonly uses: ReadonlyArray<Use>
  readonly unplaced: Readonly<Record<string, number>>
}

/**
 * The tally of hosts' dumps, the first as this host and the rest as its peers:
 * every login's newest reading across them is its row, and each host's steps
 * count on it from the period's start. A row that began before any host's
 * ledger did is left out.
 */
export const fromDumps = (hosts: ReadonlyArray<readonly [string, Dump]>): Tally => {
  const [own, ...peers] = hosts
  if (own === undefined) throw new Error("no dump")
  const now = Math.max(...hosts.map(([, dump]) => dump.at))
  const newest = new Map<string, { pool: string; credentialID: string; reading: QuotaReading }>()
  for (const [, dump] of hosts)
    for (const shared of dump.readings) {
      const reading = asReading(shared.reading)
      const key = `${shared.pool}|${shared.credentialID}`
      if (reading !== undefined && (newest.get(key)?.reading.at ?? -1) < reading.at) newest.set(key, { ...shared, reading })
    }
  const claims = hosts.flatMap(([, dump]) => dump.claims ?? [])
  // A host's rows are of its own logins (a peer may know an account by another id), each at its newest reading on any host.
  const read = (dump: Dump) => {
    const mine = new Set(dump.readings.flatMap((shared) => (shared.own === false ? [] : [`${shared.pool}|${shared.credentialID}`])))
    const state = [...newest]
      .filter(([key]) => mine.has(key))
      .reduce<LimitsState>((held, [, { pool, credentialID, reading }]) => observe(held, pool, credentialID, reading), emptyState(dump.since))
    return recount(
      claims.reduce((held, claim) => resetInside(held, claim.pool, claim.credentialID, claim.at), state),
      dump.uses,
      now,
    )
  }
  let state = read(own[1])
  for (const [name, dump] of peers) state = takePeer(state, name, reportOf(read(dump), now))
  return tally(state, now)
}

const num = (value: number) => (value >= 10 ? value.toFixed(1) : value >= 1 ? value.toFixed(2) : value.toFixed(3))
const rate = (r: Rate) => `${num(r.rate)}${r.low === undefined || r.high === undefined ? "" : ` (${num(r.low)}–${num(r.high)})`}`

/** One window's rows: per family, %/weighted Mtok with its range, %/raw Mtok, n and the tokens. */
export const table = (windows: ReadonlyArray<WindowTally>): ReadonlyArray<string> =>
  windows.flatMap((w) => [
    `  ${w.pool} ${w.window} (${w.rows} periods)`,
    ...w.families.map(
      (f) =>
        `    ${f.family.padEnd(14)} ${rate(f.weighted).padEnd(24)} %/Mtok · raw ${rate(f.raw).padEnd(26)} %/Mtok · n ${String(f.n).padStart(3)} · ${f.mtok.toFixed(1)} Mtok weighted, ${f.rawMtok.toFixed(0)} raw${f.reported === true ? " · its reported part" : ""}`,
    ),
  ])

/** Each pool's weekly points per own-week point, and every window read with no row fitted yet. */
export const notes = (computed: Tally): ReadonlyArray<string> => [
  ...[...new Set(computed.cumulative.map((w) => w.pool))].flatMap((pool) =>
    Object.entries(weeklyRatios(computed, pool)).map(([window, ratio]) => `  ${pool} ${window}: ${rate(ratio)} weekly points per own-week point`),
  ),
  ...(computed.waiting ?? []).map((waiting) => `  ${waiting.pool} ${waiting.window}: none yet (${waitingText(waiting)})`),
]

if (import.meta.main) {
  const args = process.argv.slice(2)
  const option = (name: string) => {
    const at = args.indexOf(name)
    return at < 0 ? undefined : args[at + 1]
  }
  const dumps = args.flatMap((arg, i) => (args[i - 1] === "--dump" ? [arg] : []))
  let answer: { line?: string; tally: Tally; hosts?: Record<string, unknown> }
  if (dumps.length > 0) {
    const hosts = dumps.map((spec): readonly [string, Dump] => {
      const cut = spec.indexOf("=")
      return [spec.slice(0, cut), JSON.parse(readFileSync(spec.slice(cut + 1), "utf8")) as Dump]
    })
    const computed = fromDumps(hosts)
    answer = {
      ...(limitsLine(computed) === undefined ? {} : { line: limitsLine(computed)! }),
      tally: computed,
      hosts: Object.fromEntries(hosts.map(([name, dump]) => [name, { since: new Date(dump.since).toISOString(), uses: dump.uses.length, unplaced: dump.unplaced }])),
    }
  } else {
    const path = option("--file") ?? defaultPath()
    const file = (() => {
      try {
        return JSON.parse(readFileSync(path, "utf8")) as { tally?: Tally }
      } catch {
        return undefined
      }
    })()
    const state = stateOf(file)
    if (state === undefined) {
      console.error(`no limit tally at ${path} (the pool writes it on each sweep)`)
      process.exit(1)
    }
    // Fitted again from the file's rows, so a fit this view knows reads rows a running pool of an older fit wrote.
    const computed = tally(state, Date.now())
    const line = limitsLine(computed)
    answer = { ...(line === undefined ? {} : { line }), tally: computed }
  }
  if (args.includes("--json")) console.log(JSON.stringify(answer))
  else {
    console.log(answer.line ?? "limit/Mtok: no window period with tokens yet")
    console.log(`Last 7 days (since ${new Date(answer.tally.since).toISOString()}; peers ${JSON.stringify(answer.tally.peers)}):`)
    for (const line of table(answer.tally.recent)) console.log(line)
    console.log("All periods kept:")
    for (const line of table(answer.tally.cumulative)) console.log(line)
    const more = notes(answer.tally)
    if (more.length > 0) console.log(["Weekly ratios and windows not fitted yet:", ...more].join("\n"))
    if (answer.hosts !== undefined) console.log(`Hosts: ${JSON.stringify(answer.hosts)}`)
  }
}
