// How `bun run accept` orders its files: the acceptance files run in a parallel
// pool as wide as the host can take at the start, then the timing-sensitive
// ones one at a time. A file is timing-sensitive when it asserts an upper bound
// on a time, rate or CPU (how long something took at most, that it happened by a
// time, how many frames a second, what share of a core): a loaded host breaks
// those. A wait for an event under a generous deadline only takes longer there,
// and a lower bound (at least 5 s between retries) only gains slack. The file says
// so itself, with the marker line (`// accept: one at a time (<why>)`); the
// runner keeps no list of them. scripts/accept.test.ts checks that every file
// whose text, or the scenario it drives, asserts such a bound carries the marker.
import { Option } from "effect"

/** The marker line a timing-sensitive acceptance file carries: `// accept: one at a time (<why>)`. */
export const SERIAL_MARKER = /^\/\/ accept: one at a time\b/m

/** Whether an acceptance file's text marks it timing-sensitive. */
export const isSerial = (text: string) => SERIAL_MARKER.test(text)

/** An assertion: a line that calls `expect(`. */
const ASSERTS = /\bexpect\(/
/** A matcher that bounds a number from above: what load makes larger can break it. */
const BOUND = /\.(?:toBeLessThan|toBeLessThanOrEqual|toBeWithin)\(/
/** What names a time, a rate or CPU in such a line. */
const MEASURE = /Date\.now|performance\.now|_MS\b|\d_000\b|\.at\b|\bat\[|\bdue\b|\bbegan\b|\bstarted\b|\bseconds\b|\bretryAt\b|\bshare\b|\bloops\b|\bcpu\b|\bBUDGET\b|\bQUIET\b/
/** A comparison with a `_MS` budget inside an assertion, the rows over it expected none: `expect(rows.filter((row) => !(row.cpu < LIVE_CPU_MS))).toEqual([])`. */
const AGAINST_BUDGET = /[<>]=?\s*[A-Z][A-Z_]*_MS\b/

/**
 * Why a file's text reads as timing-sensitive, one line per assertion that bounds a time, a rate
 * or CPU from above; none when it reads as not. Waiting (`waitUntil`, a retry, a `_MS` deadline)
 * is no sign, nor is a lower bound (`toBeGreaterThanOrEqual(5_000)`): only an assertion that a
 * measured number stays under a limit is.
 * - `expect(Date.now() - started).toBeLessThan(5_000)`, `expect(summaries[0]?.at).toBeLessThan(due + 5_000)`;
 * - `expect(result.quiet.loops).toBeLessThan(QUIET)`, `expect(result.busy[0]!.share).toBeLessThan(BUDGET)`;
 * - `expect(locations.filter((location) => !(location.cpu < LIVE_CPU_MS)))`.
 */
export const timingSigns = (text: string): ReadonlyArray<string> =>
  text
    .split("\n")
    .filter((line) => ASSERTS.test(line) && ((BOUND.test(line) && MEASURE.test(line)) || AGAINST_BUDGET.test(line)))
    .map((line) => `bounds a time, rate or CPU from above: ${line.trim()}`)

/** The scenarios an acceptance file drives (`scenarios/<name>.ts`, as `opencode-drive run` takes them). */
export const scenariosOf = (text: string): ReadonlyArray<string> => [...new Set([...text.matchAll(/\bscenarios\/[\w-]+\.ts\b/g)].map((match) => match[0]))]

/** The pool width `--parallel=N` asks for, none when it is not given, or why the argument is wrong. */
export type Requested = { readonly ok: true; readonly width: Option.Option<number> } | { readonly ok: false; readonly problem: string }

export const requestedWidth = (args: ReadonlyArray<string>): Requested => {
  const given = args.filter((arg) => arg.startsWith("--parallel="))
  const widths = given.map((arg) => Number(arg.slice("--parallel=".length)))
  if (widths.every((width) => Number.isInteger(width) && width > 0)) return { ok: true, width: Option.fromIterable(widths.slice(-1)) }
  return { ok: false, problem: `--parallel takes a positive whole number, not ${given.join(" ")}` }
}

/** How wide the parallel pool runs: the cores the host's 1-minute load leaves free (at least one), capped by a width the caller asked for. */
export const poolWidth = (cores: number, load1: number, requested: Option.Option<number> = Option.none()) => {
  const free = Math.max(1, Math.floor(cores - load1))
  return Math.max(1, Math.min(free, Option.getOrElse(requested, () => free)))
}

/** One `bun test` run of the plan: its files and how many run at once. */
export interface Phase {
  readonly name: "pool" | "one at a time"
  readonly files: ReadonlyArray<string>
  readonly width: number
}

/**
 * The run's phases, in order: the unmarked files in a pool `width` wide, then the marked
 * ones one at a time, after the pool has ended. An empty phase is left out.
 */
export const plan = (files: ReadonlyArray<string>, text: (file: string) => string, width: number): ReadonlyArray<Phase> => {
  const serial = files.filter((file) => isSerial(text(file)))
  const pool = files.filter((file) => !serial.includes(file))
  const phases: ReadonlyArray<Phase> = [
    { name: "pool", files: pool, width: Math.max(1, Math.min(width, pool.length)) },
    { name: "one at a time", files: serial, width: 1 },
  ]
  return phases.filter((phase) => phase.files.length > 0)
}

/** The line accept prints before a phase runs; the pool's names the host it was sized for. */
export const heading = (phase: Phase, cores: number, load1: number) => {
  if (phase.name === "pool") return `accept: ${phase.files.length} files, ${phase.width} at a time (${cores} cores, 1-minute load ${load1.toFixed(1)})`
  return `accept: ${phase.files.length} timing-sensitive files, one at a time`
}
