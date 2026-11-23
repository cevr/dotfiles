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
import { Array as Arr, Option, Schema } from "effect"

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

/**
 * How wide the parallel pool runs: the width the caller asked for (`--parallel=N`: the post-land step's
 * deep run asks for two at any load), else the cores the host's 1-minute load leaves free, at least one.
 */
export const poolWidth = (cores: number, load1: number, requested: Option.Option<number> = Option.none()) =>
  Math.max(1, Option.getOrElse(requested, () => Math.floor(cores - load1)))

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

// ---- The swarm: fresh seeds over the simulated suites (`*.sim.test.ts`), each its own `bun test` under
// sim/seed.ts's swarm mode (`SIM_SWARM`, `SIM_SWARM_MS`). A land run swarms the suites the change reaches
// for a third of its budget (20 s of 60) before its real files; the deep run swarms every suite for
// 10 minutes once a day. A failing seed fails the run and is printed as the command that replays it.

/** The seeds sim/seed.ts runs in the gate (its `SEEDS`); a swarm's start past them. */
export const FIXED_SEEDS = 20
/** The largest seed a swarm starts from, so its seeds stay inside a 32-bit integer for a day's swarm and more. */
const SEED_SPAN = 1_000_000_000

export { isSimSuite } from "./test-population.ts"

/** The swarm's box in a land run of `budgetMs`: a third of it (20 s of 60). */
export const swarmBox = (budgetMs: number) => Math.floor(budgetMs / 3)

/** The daily long swarm's box, and how often it is due. */
export const LONG_SWARM_MS = 600_000
export const LONG_SWARM_EVERY_MS = 24 * 60 * 60 * 1000

/** The simulated suites a change reaches: those whose reach (`reachOf`, the suite itself included) holds a changed file. */
export const reachedSuites = (suites: ReadonlyArray<string>, reachOf: (suite: string) => ReadonlySet<string>, changed: ReadonlyArray<string>) =>
  suites.filter((suite) => changed.some((file) => file === suite || reachOf(suite).has(file)))

/** A swarm's first seed, from the head's hash and what the swarm is for (`land`, `daily:<date>`): fresh for each head, past the fixed seeds. */
export const swarmFirst = (head: string, label: string) => FIXED_SEEDS + 1 + (Number(BigInt(Bun.hash(`${head}:${label}`)) % BigInt(SEED_SPAN)))

/** Each suite's box when `count` suites share `boxMs`, `width` at a time: the whole box when they all fit at once. */
export const swarmSlot = (boxMs: number, width: number, count: number) => Math.floor(boxMs * Math.min(1, Math.max(1, width) / Math.max(1, count)))

/** What one suite's swarm printed: the seeds that passed, and each seed that failed (`SIM_SEED=<n> bun test <file>`). */
export const swarmRead = (output: string, file: string) => {
  const passed = output.split("\n").filter((line) => line.startsWith(`sim-swarm ${file} `)).length
  const failing = [...new Set([...output.matchAll(/SIM_SEED=(\d+) bun test (\S+?):/g)].flatMap((match) => Arr.filter([Number(match[1])], () => match[2] === file)))]
  return { passed, failing }
}

/**
 * What of a suite's CPU budgets its run reported and did not judge, past their limit on a loaded host: each
 * `sim-unjudged <file> <what>` line (sim/seed.ts `unjudgedLine`) as its `<what>`. The run owes such a suite, `waits
 * for a settled host`, so a real slowdown shows in the closing line however busy the host always is.
 */
export const unjudgedRead = (output: string, file: string) =>
  output.split("\n").flatMap((line) => Arr.filter([line.slice(`sim-unjudged ${file} `.length).trim()], () => line.startsWith(`sim-unjudged ${file} `)))

/** Where the line under way at `at` ends in `text` (past its newline): `at` itself at a line's start, the text's end when the line has none. */
const lineEnd = (text: string, at: number) => {
  if (at <= 0 || text[at - 1] === "\n") return Math.max(0, at)
  const newline = text.indexOf("\n", at)
  return (newline < 0 && text.length) || newline + 1
}

/** One stream a suite's swarm printed to: all it printed, and how much of it had arrived when the runner decided to stop it. */
export interface Heard {
  readonly text: string
  readonly atStop: number
}

/**
 * What the swarm of a suite the runner stopped (its box, a signal, a yield) printed to its streams: the seeds it
 * passed, the seeds that failed before the stop (a line under way at the stop counts as before it), and apart, as
 * `stopped`, the seeds that failed only while it was stopped: the stop's own (a TUI torn down under the test that
 * ran), never a failing seed.
 */
export const swarmCut = (streams: ReadonlyArray<Heard>, file: string) => {
  const split = streams.map(({ text, atStop }) => {
    const at = lineEnd(text, atStop)
    return { before: text.slice(0, at), after: text.slice(at) }
  })
  const failing = swarmRead(split.map((each) => each.before).join("\n"), file).failing
  const after = swarmRead(split.map((each) => each.after).join("\n"), file).failing
  return { passed: swarmRead(streams.map((each) => each.text).join("\n"), file).passed, failing, stopped: after.filter((seed) => !failing.includes(seed)) }
}

/** The line that replays a failing seed. */
export const replayLine = (file: string, seed: number) => `SIM_SEED=${seed} bun test ${file}`

/** The swarm's summary line: the seeds it ran over the suites, in how long, and how many a second. */
export const swarmLine = (what: string, suites: ReadonlyArray<string>, seeds: number, ms: number, first: number) =>
  `accept: swarm (${what}): ${seeds} seeds over ${suites.length} simulated suites in ${(ms / 1000).toFixed(1)} s, ${(seeds / Math.max(0.001, ms / 1000)).toFixed(1)} seeds/s, from seed ${first}${Arr.filter([`: ${suites.join(", ")}`], () => suites.length > 0).join("")}`

/** When the daily long swarm last ran to its end on a host, and at which head (beside the ledger, `swarm.json`). */
const SwarmState = Schema.fromJsonString(Schema.Struct({ at: Schema.Finite, head: Schema.String }))
export const encodeSwarmState = Schema.encodeSync(SwarmState)
export const decodeSwarmState = Schema.decodeUnknownOption(SwarmState)

/** Whether the daily long swarm is due at `now`: it never ran, or last ran `LONG_SWARM_EVERY_MS` ago. */
export const longSwarmDue = (lastAt: Option.Option<number>, now: number) => Option.match(lastAt, { onNone: () => true, onSome: (at) => now - at >= LONG_SWARM_EVERY_MS })

/**
 * The describe blocks of scripts/accept.test.ts whose real runs carry a clock bound: tests/accept-clock.test.ts runs
 * them with ACCEPT_TIMED=1, filtered by `timedFilter`.
 */
export const TIMED_RUNS: ReadonlyArray<string> = ["a land run under its budget", "a deep run yields the lock to a land run", "a land run's swarm"]

/** The `bun test -t` filter of the timed runs. */
export const timedFilter = TIMED_RUNS.join("|")

/**
 * How many tests each of `names` holds in `text` (scripts/accept.test.ts): the `test(` calls at its top indent
 * between `describe("<name>"` and the next top-level `describe(`; none for a describe the text lacks. Derived from
 * the file, so a test added to a timed describe is counted the moment it lands, not in a hand-kept number a deep
 * run alone checks (sim-load added one; TIMED_COUNT stayed 7 and the deep run went red).
 */
export const timedCounts = (text: string, names: ReadonlyArray<string> = TIMED_RUNS) =>
  names.map((name) => {
    const at = `\n${text}`.indexOf(`\ndescribe("${name}"`)
    if (at < 0) return { name, tests: 0 }
    const rest = text.slice(at)
    const next = rest.indexOf("\ndescribe(")
    const body = (next < 0 && rest) || rest.slice(0, next)
    return { name, tests: body.split("\n").filter((line) => /^ {2}test\(/.test(line)).length }
  })

/** The line accept prints before a phase runs; the pool's names the host it was sized for. */
export const heading = (phase: Phase, cores: number, load1: number) => {
  if (phase.name === "pool") return `accept: ${phase.files.length} files, ${phase.width} at a time (${cores} cores, 1-minute load ${load1.toFixed(1)})`
  return `accept: ${phase.files.length} timing-sensitive files, one at a time`
}
