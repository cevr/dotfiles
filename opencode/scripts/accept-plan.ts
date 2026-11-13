// How `bun run accept` orders its files: the acceptance files run in a parallel
// pool as wide as the host can take at the start, then the timing-sensitive
// ones one at a time. A file is timing-sensitive when it says so itself, with
// the marker line (`// accept: one at a time`, and why) in its own text; the
// runner keeps no list of them. scripts/accept.test.ts checks that every file
// whose text, or the scenario it drives, measures time or waits under a short
// deadline carries the marker.
import { Option } from "effect"

/** The marker line a timing-sensitive acceptance file carries: `// accept: one at a time (<why>)`. */
export const SERIAL_MARKER = /^\/\/ accept: one at a time\b/m

/** Whether an acceptance file's text marks it timing-sensitive. */
export const isSerial = (text: string) => SERIAL_MARKER.test(text)

/** A deadline shorter than this, named as a `_MS` constant, is short enough that a loaded host breaks it. */
const SHORT_MS = 30_000

/** A number as written in source: `20_000`, `150`. */
const numberOf = (written: string) => Number(written.replaceAll("_", ""))

/**
 * Why a file's text reads as timing-sensitive, one line per sign; none when it reads as not:
 * - it measures elapsed time (`Date.now() - start`, `performance.now() - t`, `start + ms - Date.now()`);
 * - it names a deadline under 30 s (`const BACK_WITHIN_MS = 20_000`);
 * - it asserts a bound on a time, a share or a count of frames (`toBeLessThan(due + 5_000)`,
 *   `expect(result.quiet.loops).toBeLessThan(QUIET)`).
 */
export const timingSigns = (text: string): ReadonlyArray<string> => {
  const lines = text.split("\n")
  // `Date.now() - 1000` sets a time in the past; only a name or a call after the minus measures.
  const elapsed = lines.filter((line) => /\b(?:Date|performance)\.now\(\)\s*-\s*[A-Za-z_(]|-\s*(?:Date|performance)\.now\(\)/.test(line))
  const deadlines = lines.filter((line) => [...line.matchAll(/\bconst [A-Z][A-Z_]*_MS = ([\d_]+)\b/g)].some((named) => numberOf(String(named[1])) < SHORT_MS))
  const bounds = lines.filter(
    (line) => /toBeLessThan(?:OrEqual)?\(/.test(line) && /_MS\b|\d_000\b|\.at\b|\bbegan\b|\bstarted\b|\bdue\b|\bBUDGET\b|\bshare\b|\bloops\b|Date\.now/.test(line),
  )
  return [
    ...elapsed.map((line) => `measures elapsed time: ${line.trim()}`),
    ...deadlines.map((line) => `names a short deadline: ${line.trim()}`),
    ...bounds.map((line) => `bounds a time or rate: ${line.trim()}`),
  ]
}

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
