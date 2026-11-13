// What `bun run accept` owes and what it may skip: a ledger of passes, keyed on
// what each acceptance file reaches (scripts/reach.ts `acceptKey`), and the
// tiers that spend it. This module is pure: scripts/accept.ts reads the files,
// the clock and the processes and hands them in.
//
// - A file is due when the ledger holds no pass with its current key younger
//   than 24 h: something it can load changed, or its pass expired (the daily run).
// - Its tier is in its own text: `// accept: deep (<why>)` or `// accept: one at a time`
//   make it deep; every other file is land. A land run (`accept:land`) runs the
//   due land files under a 60 s budget and owes the rest, by name; an owed run
//   (`accept:owed`) runs every due file with no deadline.
// - The ledger is one JSON file per host, written whole to a temporary file and
//   renamed, so a run killed between two writes leaves one of the two.
import { Array as Arr, Option, Order, Schema } from "effect"
import { isSerial } from "./accept-plan.ts"

/** The ledger's and the key's version: a new one makes every old pass a miss. */
export const KEY_VERSION = 1
/** How long a pass counts: the daily run, with no scheduler. */
export const PASS_TTL_MS = 86_400_000
/** How many passes a file keeps, so going back to an earlier state (a revert, a branch) hits too. */
export const KEPT = 8
/** A land run's wall time, start to exit, the lock wait aside. */
export const BUDGET_MS = 60_000
/** What one land file may take on a quiet host. */
export const LAND_SHARE_MS = 20_000
/** What one deep file may take on a quiet host (reported here; judged from the deep tier's own unit). */
export const DEEP_SHARE_MS = 60_000
/** How long a finished file's processes have to end before one still running counts as leaked. */
export const LEAK_GRACE_MS = 5000

const Pass = Schema.Struct({ key: Schema.String, at: Schema.Finite })
export type Pass = typeof Pass.Type

/** The ledger: per file its newest passes, newest first, and its last measured run time. */
export const Ledger = Schema.Struct({
  version: Schema.Literal(KEY_VERSION),
  passes: Schema.Record(Schema.String, Schema.Array(Pass)),
  times: Schema.Record(Schema.String, Schema.Finite),
})
export type Ledger = typeof Ledger.Type

export const emptyLedger: Ledger = { version: KEY_VERSION, passes: {}, times: {} }

const LedgerJson = Schema.fromJsonString(Ledger)
const decode = Schema.decodeUnknownOption(LedgerJson)
export const encodeLedger = Schema.encodeSync(LedgerJson)

/** The file system the ledger needs: scripts/accept.ts gives node:fs, the model test a map. */
export interface Disk {
  /** The file's text; none when it does not exist. */
  readonly read: (file: string) => Option.Option<string>
  readonly write: (file: string, text: string) => void
  readonly rename: (from: string, to: string) => void
}

/** Where a writer puts the next ledger before it renames it into place. */
export const tempOf = (file: string, pid: number) => `${file}.${pid}.tmp`

/** A ledger read: an absent file is empty and fine; one that does not parse is empty, with the problem to print. */
export interface Read {
  readonly ledger: Ledger
  readonly problem: Option.Option<string>
}

export const readLedger = (disk: Disk, file: string): Read =>
  Option.match(disk.read(file), {
    onNone: () => ({ ledger: emptyLedger, problem: Option.none() }),
    onSome: (text) =>
      Option.match(decode(text), {
        onNone: () => ({
          ledger: emptyLedger,
          problem: Option.some(`the ledger ${file} is unreadable (not a version ${KEY_VERSION} ledger); reading it as empty, so every file is due`),
        }),
        onSome: (ledger) => ({ ledger, problem: Option.none() }),
      }),
  })

/** Writes the ledger whole to a temporary file, then renames it over the old one. */
export const writeLedger = (disk: Disk, file: string, pid: number, ledger: Ledger) => {
  const temp = tempOf(file, pid)
  disk.write(temp, encodeLedger(ledger))
  disk.rename(temp, file)
}

const passesOf = (ledger: Ledger, file: string): ReadonlyArray<Pass> => Option.getOrElse(Option.fromUndefinedOr(ledger.passes[file]), () => [])

const fresh = (pass: Pass, now: number) => now - pass.at < PASS_TTL_MS

/** Whether `file` must run: no pass with `key` younger than 24 h. */
export const isDue = (ledger: Ledger, file: string, key: string, now: number) => !passesOf(ledger, file).some((pass) => pass.key === key && fresh(pass, now))

/** The ledger with a pass of `file` at `key`, newest first; expired ones and all past the newest KEPT dropped. */
export const withPass = (ledger: Ledger, file: string, key: string, at: number): Ledger => {
  const kept = passesOf(ledger, file).filter((pass) => pass.key !== key && fresh(pass, at))
  return { ...ledger, passes: { ...ledger.passes, [file]: [{ key, at }, ...kept].slice(0, KEPT) } }
}

/** The ledger with `file`'s last measured run time. */
export const withTime = (ledger: Ledger, file: string, ms: number): Ledger => ({ ...ledger, times: { ...ledger.times, [file]: Math.round(ms) } })

/** The time `file` is expected to take: its last measured one, else the land share. */
export const estimate = (ledger: Ledger, file: string) => Option.getOrElse(Option.fromUndefinedOr(ledger.times[file]), () => LAND_SHARE_MS)

/** The marker of a file that leaves the land tier: `// accept: deep (<measured s> s alone on a quiet host: <why>)`. */
export const DEEP_MARKER = /^\/\/ accept: deep \(/m

export type Tier = "land" | "deep"

/** A file's tier: deep when it says so, or runs one at a time (a file that bounds a time cannot share 60 s with a pool). */
export const tierOf = (text: string): Tier => {
  if (isSerial(text) || DEEP_MARKER.test(text)) return "deep"
  return "land"
}

/** Which files a run takes: `land` the due land files, `owed` every due file, `all` every file. */
export type Mode = "land" | "owed" | "all"

/** Why a file is owed: a deep file in a land run, past a land run's budget, skipped tests, left out by naming, stopped by a signal, or only listed. */
export type Why = "deep" | "budget" | "skipped" | "unnamed" | "signal" | "listed"

/** Where a file ended: run and passed or failed, owed (with why), or skipped because it passed before with its key unchanged. */
export type Outcome =
  | { readonly file: string; readonly status: "passed"; readonly ms: number }
  | { readonly file: string; readonly status: "failed"; readonly ms: number; readonly reason: string }
  | { readonly file: string; readonly status: "owed"; readonly why: Why; readonly detail: string }
  | { readonly file: string; readonly status: "before" }

export interface Candidate {
  readonly file: string
  readonly tier: Tier
  readonly key: string
}

export interface Selection {
  /** The files to run, in the order given. */
  readonly run: ReadonlyArray<string>
  /** The files settled without running. */
  readonly settled: ReadonlyArray<Outcome>
}

export const owe = (file: string, why: Why, detail = ""): Outcome => ({ file, status: "owed", why, detail })

/** What a run of `mode` does with each candidate; `named` (when any) narrows the run to those files, and the others it would have run are owed. */
export const select = (mode: Mode, candidates: ReadonlyArray<Candidate>, ledger: Ledger, now: number, named: ReadonlyArray<string> = []): Selection => {
  const settled: Array<Outcome> = []
  const run: Array<string> = []
  for (const candidate of candidates) {
    if (mode !== "all" && !isDue(ledger, candidate.file, candidate.key, now)) settled.push({ file: candidate.file, status: "before" })
    else if (mode === "land" && candidate.tier === "deep") settled.push(owe(candidate.file, "deep"))
    else if (named.length > 0 && !named.includes(candidate.file)) settled.push(owe(candidate.file, "unnamed"))
    else run.push(candidate.file)
  }
  return { run, settled }
}

const NAMED_PACKAGE = /(?<![\w.-])(cmd|mods)\/([a-z0-9][a-z0-9-]*)/g

/** The packages (`mods/prime`, `cmd/rift`) the texts name. */
export const namedPackages = (texts: ReadonlyArray<string>): ReadonlySet<string> =>
  new Set(texts.flatMap((text) => [...text.matchAll(NAMED_PACKAGE)].map((match) => `${match[1]}/${match[2]}`)))

/**
 * Whether a file is near a change: its own text or a scenario it drives (`texts`) names the
 * package of a changed file, or it reaches (`reached`) a changed file outside the packages.
 */
export const isNear = (texts: ReadonlyArray<string>, reached: ReadonlySet<string>, changed: ReadonlyArray<string>, packageOf: (file: string) => Option.Option<string>) => {
  const named = namedPackages(texts)
  return changed.some((file) => Option.match(packageOf(file), { onSome: (dir) => named.has(dir), onNone: () => reached.has(file) }))
}

/** A land run's order: the files near the change first, then the others, each cheapest first by `ms`, then by name. */
export const landOrder = (files: ReadonlyArray<string>, near: ReadonlySet<string>, ms: (file: string) => number): ReadonlyArray<string> =>
  Arr.sort(
    files,
    Order.combine(
      Order.mapInput(Order.Number, (file: string) => Number(!near.has(file))),
      Order.combine(Order.mapInput(Order.Number, ms), Order.String),
    ),
  )

/** When, on the run's clock (ms from the process start, the lock wait aside), files may start, are stopped, and the run ends. */
export interface Window {
  readonly startBy: number
  readonly stopAt: number
  readonly end: number
}

/** A land run's window: no file starts after 3/4 of the budget (45 s), the pool is stopped at 5/6 (50 s), the leak check has the rest. */
export const windowOf = (budgetMs: number): Window => ({ startBy: (budgetMs * 3) / 4, stopAt: (budgetMs * 5) / 6, end: budgetMs })

/** No deadline: an owed or full run. */
export const OPEN: Window = { startBy: Number.POSITIVE_INFINITY, stopAt: Number.POSITIVE_INFINITY, end: Number.POSITIVE_INFINITY }

export const canStart = (window: Window, elapsed: number) => elapsed < window.startBy

/** How long a finished file's leak check may wait at `elapsed`: the grace, cut so the run still ends inside its window. */
export const leakGrace = (window: Window, elapsed: number) => Math.max(0, Math.min(LEAK_GRACE_MS, window.end - 4000 - elapsed))

/** The free cores, at least one. */
const freeCores = (cores: number, load1: number) => Math.max(1, Math.floor(cores - load1))

/** A land run's width: what `--parallel` asks, else the free cores, at least 4 (its files bound no time; load only slows them, and the deadline holds). */
export const landWidth = (cores: number, load1: number, requested: Option.Option<number>) => Option.getOrElse(requested, () => Math.max(4, freeCores(cores, load1)))

/** One file of a simulated pool: when it started and ended, and whether the stop ended it. */
export interface Slot {
  readonly file: string
  readonly start: number
  readonly end: number
  readonly stopped: boolean
}

export interface Simulation {
  readonly ran: ReadonlyArray<Slot>
  readonly unstarted: ReadonlyArray<string>
}

/**
 * The pool a land run plays: `width` at once in `order`, from `from` on the run's clock, each file
 * taking `duration`; a file starts only before `window.startBy`, and one still running at
 * `window.stopAt` is stopped there. scripts/accept.ts runs the same rule on the real clock; `--list`
 * predicts with it.
 */
export const simulate = (order: ReadonlyArray<string>, duration: (file: string) => number, width: number, window: Window, from = 0): Simulation => {
  const free = Arr.makeBy(Math.max(1, width), () => from)
  const ran: Array<Slot> = []
  const unstarted: Array<string> = []
  for (const file of order) {
    const slot = free.indexOf(Math.min(...free))
    const start = free[slot] ?? from
    if (!canStart(window, start)) unstarted.push(file)
    else {
      const end = Math.min(start + Math.max(0, duration(file)), window.stopAt)
      ran.push({ file, start, end, stopped: start + duration(file) > window.stopAt })
      free[slot] = end
    }
  }
  return { ran, unstarted }
}

/** What `bun test --reporter=junit` counted for a file. */
export interface Report {
  readonly tests: number
  readonly failures: number
  readonly skipped: number
}

/** The counts on the root `<testsuites>` element of a junit report; none when there is none. */
export const parseReport = (xml: string): Option.Option<Report> => {
  const root = /<testsuites\b([^>]*)>/.exec(xml)
  const count = (attrs: string, name: string) => Option.map(Option.fromNullishOr(new RegExp(`\\b${name}="(\\d+)"`).exec(attrs)), (match) => Number(match[1]))
  return Option.flatMap(Option.fromNullishOr(root), (match) => {
    const attrs = String(match[1])
    return Option.all({ tests: count(attrs, "tests"), failures: count(attrs, "failures"), skipped: count(attrs, "skipped") })
  })
}

/** How a finished `bun test` of one file ended, from its exit code, its report and the leak check. */
export interface Finish {
  readonly file: string
  readonly code: number
  readonly report: Option.Option<Report>
  readonly leaked: boolean
  readonly ms: number
  /** Whether a pass may be recorded: no bun test flags (a filter) narrowed the run. */
  readonly recordable: boolean
}

/** A finished file's outcome: a pass needs exit 0, a report with tests and no failure or skip, no leak, and no narrowing flags. */
export const verdict = (finish: Finish): Outcome => {
  const { file, ms } = finish
  if (finish.leaked) return { file, status: "failed", ms, reason: "it left an OpenCode server or drive run behind" }
  if (finish.code !== 0) return { file, status: "failed", ms, reason: `bun test exited ${finish.code}` }
  return Option.match(finish.report, {
    onNone: () => ({ file, status: "failed", ms, reason: "bun test wrote no report" }),
    onSome: (report): Outcome => {
      if (report.failures > 0) return { file, status: "failed", ms, reason: `${report.failures} tests failed` }
      if (report.skipped > 0 || report.tests === 0) return owe(file, "skipped", `${report.skipped} of ${report.tests} tests skipped: no pass recorded`)
      if (!finish.recordable) return owe(file, "skipped", "bun test flags narrowed it: no pass recorded")
      return { file, status: "passed", ms }
    },
  })
}

/** The ledger after `outcome`: a pass for a passed file at its key, the time of any file that ran to its end, nothing for the rest. */
export const record = (ledger: Ledger, outcome: Outcome, key: string, now: number): Ledger => {
  if (outcome.status === "passed") return withTime(withPass(ledger, outcome.file, key, now), outcome.file, outcome.ms)
  if (outcome.status === "failed") return withTime(ledger, outcome.file, outcome.ms)
  return ledger
}

const WHYS: ReadonlyArray<readonly [Why, string]> = [
  ["deep", "deep"],
  ["budget", "past the budget"],
  ["skipped", "skipped"],
  ["unnamed", "not named"],
  ["signal", "stopped by a signal"],
  ["listed", "listed, not run"],
]

/** The counts the closing line states. */
export interface Counts {
  readonly passed: number
  readonly failed: number
  readonly owed: number
  readonly before: number
  readonly why: ReadonlyMap<Why, number>
}

type Owed = Extract<Outcome, { readonly status: "owed" }>
const isOwed = (outcome: Outcome): outcome is Owed => outcome.status === "owed"
const owedOf = (outcomes: ReadonlyArray<Outcome>): ReadonlyArray<Owed> => outcomes.filter(isOwed)

export const countsOf = (outcomes: ReadonlyArray<Outcome>): Counts => {
  const of = (status: Outcome["status"]) => outcomes.filter((outcome) => outcome.status === status)
  const owed = owedOf(outcomes).map((outcome) => outcome.why)
  return {
    passed: of("passed").length,
    failed: of("failed").length,
    owed: owed.length,
    before: of("before").length,
    why: new Map(WHYS.map(([why]) => [why, owed.filter((each) => each === why).length])),
  }
}

/**
 * The run's last lines: how many passed before (skipped), each owed file, then the closing line,
 * `accept: land <p> passed, <f> failed, <o> owed in <s> s (owed: <d> deep, <b> past the budget; run bun run accept:owed)`;
 * an owed reason beyond those two is added only when it counts.
 */
export const closing = (mode: Mode, outcomes: ReadonlyArray<Outcome>, seconds: number): ReadonlyArray<string> => {
  const counts = countsOf(outcomes)
  const count = (why: Why) => Option.getOrElse(Option.fromUndefinedOr(counts.why.get(why)), () => 0)
  const reasons = WHYS.flatMap(([why, said]) => Arr.filter([`${count(why)} ${said}`], () => why === "deep" || why === "budget" || count(why) > 0))
  const words = (why: Why) => Option.getOrElse(Option.map(Arr.findFirst(WHYS, ([each]) => each === why), ([, said]) => said), () => why)
  // A listed file is already on its own `due:` line.
  const owedLines = owedOf(outcomes)
    .filter((outcome) => outcome.why !== "listed")
    .map((outcome) => `  owed: ${outcome.file} (${[words(outcome.why), outcome.detail].filter(Boolean).join(": ")})`)
  const before = Arr.filter([`accept: ${counts.before} files passed before with their keys unchanged; skipped`], () => counts.before > 0)
  return [
    ...before,
    ...owedLines,
    `accept: ${mode} ${counts.passed} passed, ${counts.failed} failed, ${counts.owed} owed in ${seconds.toFixed(1)} s (owed: ${reasons.join(", ")}; run bun run accept:owed)`,
  ]
}

/** The closing line's counts, read back: the model test and accept.test.ts check them against the outcomes. */
export const parseClosing = (line: string) =>
  Option.map(Option.fromNullishOr(/^accept: (land|owed|all) (\d+) passed, (\d+) failed, (\d+) owed in [\d.]+ s \(owed: (\d+) deep, (\d+) past the budget/.exec(line)), (match) => ({
    mode: String(match[1]),
    passed: Number(match[2]),
    failed: Number(match[3]),
    owed: Number(match[4]),
    deep: Number(match[5]),
    budget: Number(match[6]),
  }))

/** Whether the host is quiet: every 1-minute load read (at the start and the end) under half the cores. */
export const isQuiet = (cores: number, loads: ReadonlyArray<number>) => loads.every((load) => load < cores / 2)

/** A file's run time against its share. */
export interface Timed {
  readonly file: string
  readonly tier: Tier
  readonly ms: number
}

export interface Shares {
  /** Lines that fail the run. */
  readonly broken: ReadonlyArray<string>
  /** Lines only reported. */
  readonly reported: ReadonlyArray<string>
}

const seconds = (ms: number) => (ms / 1000).toFixed(1)

/**
 * The shares a run broke. In a land run a land file at or over its 20 s share fails the run on a
 * quiet host and is only reported on a loaded one; in other runs a file over the 60 s deep share is reported.
 */
export const shares = (mode: Mode, timed: ReadonlyArray<Timed>, quiet: boolean): Shares => {
  if (mode !== "land") {
    const over = timed.filter((each) => each.ms > DEEP_SHARE_MS)
    return { broken: [], reported: over.map((each) => `accept: ${each.file} took ${seconds(each.ms)} s of its ${DEEP_SHARE_MS / 1000} s deep share (reported; judged from the deep tier on)`) }
  }
  const over = timed.filter((each) => each.tier === "land" && each.ms >= LAND_SHARE_MS)
  if (quiet)
    return {
      broken: over.map((each) => `accept: ${each.file} took ${seconds(each.ms)} s of its ${LAND_SHARE_MS / 1000} s land share on a quiet host: speed it up or mark it // accept: deep (<why>)`),
      reported: [],
    }
  return { broken: [], reported: over.map((each) => `accept: ${each.file} took ${seconds(each.ms)} s of its ${LAND_SHARE_MS / 1000} s land share on a loaded host: reported, not judged`) }
}

/** The run's exit code: 1 when a file failed or a share broke; owed files never fail it. */
export const exitOf = (outcomes: ReadonlyArray<Outcome>, broken: ReadonlyArray<string>) => Number(broken.length > 0 || outcomes.some((outcome) => outcome.status === "failed"))

/** Who holds the machine's accept lock: `<lock>/owner.json`. */
const Owner = Schema.Struct({ pid: Schema.Finite, root: Schema.String })
const OwnerJson = Schema.fromJsonString(Owner)
export const encodeOwner = Schema.encodeSync(OwnerJson)
export const decodeOwner = Schema.decodeUnknownOption(OwnerJson)

/** A glob split at its first segment with a wildcard: where to scan from, and the pattern under it. */
export const globRoot = (pattern: string) => {
  const parts = pattern.split("/")
  let fixed = parts.findIndex((part) => /[*?[\]{}]/.test(part))
  if (fixed < 0) fixed = parts.length - 1
  return { dir: parts.slice(0, fixed).join("/") || "/", rest: parts.slice(fixed).join("/") }
}
