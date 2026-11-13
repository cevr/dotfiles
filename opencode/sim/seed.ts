// The seed runner: a simulated test runs once per seed, a failing seed names
// itself with the command that replays it, and a file's seeds share one CPU
// budget.
//
// - `SEEDS` (20) fixed seeds by default, then the file's past failing seeds
//   (`runner(file, { past })`). `SIM_SEED=<n>` runs that seed alone.
// - A failure fails with `SIM_SEED=<n> bun test <file>: <what failed>`.
// - A simulated file has `BUDGET_MS` (5 s) of CPU time for all its seeds
//   together; the test that passes it fails, saying the CPU and wall time the
//   file took. CPU, not wall: a simulated file waits on no real clock
//   (sim/static.test.ts), so on a quiet host its wall time is its CPU time,
//   and on a loaded one (the gate runs every file at once, at a load past the
//   cores) the wall time is the host's, not the file's. The wall time is
//   reported beside it, never judged.
// - A test (`seeded`, and `effect`) has `TIMEOUT_MS` of wall time, the
//   runner's own, with bun's timeout `TIMEOUT_GRACE_MS` past it. The body runs
//   raced against the runner's timeout, so a test past it is
//   interrupted where it stands, mid-seed too, and stops playing seeds; it
//   fails naming its timeout, and the next test never sees its seeds run.
//   Without it, bun would fail the test and move on while the body went on
//   against a shared world. The timeout is another process's wall time
//   (`wall-clock.ts`): a seed may hold bun's fake timers (sim-tui's TUI files
//   hold them from their boot on), under which every timer of the process
//   fires on the test's virtual advances, not on wall time.
// - Each body gets `expect`, which counts its calls. With `SIM_EXPECTS=1` the
//   runner runs one seed and prints `sim-expects <file> <test name> <calls>`
//   after each test, which scripts/accept-parity.test.ts reads.
//
// The runner reads wall time, through Effect's live clock, and the process's
// CPU time, to hold the budget; a simulated file itself never does
// (sim/static.test.ts). `bun test` runs a file's tests one at a time, and
// `--parallel` gives each file its own process, so the process's CPU time over
// a seed is that seed's.
import { expect as bunExpect, test } from "bun:test"
import { Cause, Clock, Config, Console, Data, Effect, Exit, Option } from "effect"
import { wallTime } from "./wall-clock.ts"

export const SEEDS = 20
/** CPU time a simulated file's seeds may take together. */
export const BUDGET_MS = 5_000
/**
 * Wall time a simulated test may take, seeds and all, before the runner stops it: far above the CPU budget, since a
 * loaded host (the gate's, at a load past the cores) stretches the wall time many times over.
 */
export const TIMEOUT_MS = 240_000
/** How far past the runner's timeout bun's own sits, so the runner's stops the seeds first. */
export const TIMEOUT_GRACE_MS = 5_000
/** The prefix of the line each test prints under `SIM_EXPECTS`. */
export const EXPECTS = "sim-expects"

/** A seed that failed, or a file past its budget. */
export class SeedFailed extends Data.TaggedError("SeedFailed")<{ readonly message: string }> {}

/**
 * The seeds a run uses: `SIM_SEED` alone, one under `SIM_EXPECTS`, else 1 to `SEEDS` and then the file's past
 * failing seeds (`past`), each once.
 */
export const seedsOf = (past: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    const one = yield* Config.option(Config.Int("SIM_SEED"))
    if (Option.isSome(one)) return [one.value]
    if (Option.isSome(yield* Config.option(Config.String("SIM_EXPECTS")))) return [1]
    const fixed = Array.from({ length: SEEDS }, (_, index) => index + 1)
    return [...fixed, ...[...new Set(past)].filter((seed) => seed > SEEDS).sort((a, b) => a - b)]
  })

/** `seedsOf` a file with no past failing seeds. */
export const seeds = seedsOf([])

export interface Seeded {
  readonly seed: number
  /** Bun's `expect`, counted. */
  readonly expect: typeof bunExpect
}

/**
 * `body` run within `timeoutMs` of wall time, real or fake timers alike: raced against `wallTime(timeoutMs)`
 * (`wall-clock.ts`), so a body past it is interrupted where it stands and plays nothing more into the next test; the
 * test fails naming `label` and the timeout. bun's own timeout for the test sits `TIMEOUT_GRACE_MS` later, so the
 * runner's ends it first.
 */
export const bounded = <A, E>(label: string, timeoutMs: number, body: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromiseExit(
    Effect.raceFirst(
      body,
      wallTime(timeoutMs).pipe(Effect.andThen(Effect.fail(new SeedFailed({ message: timedOut(label, timeoutMs) })))),
    ),
  ).then((exit) => outcome(label, timeoutMs, exit))

/** The failure of a test past the runner's timeout. */
const timedOut = (label: string, timeoutMs: number) => `${label}: past its ${timeoutMs} ms timeout; its seeds were stopped`

/** A bounded body's exit as its test's outcome: an interrupt alone is the runner's timeout, named. */
const outcome = <A, E>(label: string, timeoutMs: number, exit: Exit.Exit<A, E>): Promise<A> =>
  Effect.runPromise(
    Exit.match(exit, {
      onSuccess: (value): Effect.Effect<A, E | SeedFailed> => Effect.succeed(value),
      onFailure: (cause): Effect.Effect<A, E | SeedFailed> => {
        if (!Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
        return Effect.fail(new SeedFailed({ message: timedOut(label, timeoutMs) }))
      },
    }),
  )

/** A bun test whose body is an Effect: the simulated suites' Effect test integration, within `TIMEOUT_MS`. */
export const effect = <A, E>(name: string, body: Effect.Effect<A, E>, timeoutMs = TIMEOUT_MS) =>
  test(name, () => bounded(name, timeoutMs, Effect.asVoid(body)), timeoutMs + TIMEOUT_GRACE_MS)

/** The `expect` a body gets: bun's, each call counted. */
const counting = (count: { calls: number }): typeof bunExpect =>
  Object.assign(<T>(actual?: T, message?: string) => {
    count.calls += 1
    return bunExpect(actual, message)
  }, bunExpect)

/** The process's CPU time so far, user and system, ms. */
const cpuMs = Effect.sync(() => {
  const used = process.cpuUsage()
  return (used.user + used.system) / 1000
})

/** What a file's seeds have spent so far, ms. */
export interface Spent {
  cpu: number
  wall: number
}

/** The failure of a file past its budget: the CPU time judged, the wall time beside it. */
export const overBudget = (file: string, spent: Spent, budgetMs: number) =>
  `${file}: its seeds took ${Math.round(spent.cpu)} ms of CPU time (${Math.round(spent.wall)} ms of wall time), past the ${budgetMs} ms of CPU a simulated file has`

/**
 * One seed of a body, its time charged to `spent`: its expect calls, or the failure naming the seed, or the file's
 * once its seeds are past `budgetMs` of CPU time.
 */
export const once = <E>(file: string, spent: Spent, name: string, seed: number, body: (run: Seeded) => Effect.Effect<void, E>, budgetMs = BUDGET_MS) =>
  Effect.gen(function* () {
    const count = { calls: 0 }
    const began = yield* Clock.currentTimeMillis
    const cpuBegan = yield* cpuMs
    const exit = yield* Effect.exit(body({ seed, expect: counting(count) }))
    spent.cpu += (yield* cpuMs) - cpuBegan
    spent.wall += (yield* Clock.currentTimeMillis) - began
    if (Exit.isFailure(exit))
      return yield* Effect.fail(new SeedFailed({ message: `SIM_SEED=${seed} bun test ${file}: ${name}\n${Cause.pretty(exit.cause)}` }))
    if (spent.cpu > budgetMs) return yield* Effect.fail(new SeedFailed({ message: overBudget(file, spent, budgetMs) }))
    return count.calls
  })

/**
 * A file's runner (`file` as `bun test` names it from opencode/): `seeded(name, body)` registers a test that runs
 * `body` on every seed, within the file's budget. `past` holds the seeds past 1 to `SEEDS` that once failed the file
 * (a wider sweep found them): every run replays them too.
 */
export const runner = (file: string, options: { readonly past?: ReadonlyArray<number>; readonly timeoutMs?: number } = {}) => {
  const spent: Spent = { cpu: 0, wall: 0 }
  const runSeeds = seedsOf(options.past ?? [])
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS

  const seeded = <E>(name: string, body: (run: Seeded) => Effect.Effect<void, E>) =>
    test(
      name,
      () =>
        bounded(
          `${file}: ${name}`,
          timeoutMs,
          Effect.gen(function* () {
            const calls = yield* Effect.forEach(yield* runSeeds, (seed) => once(file, spent, name, seed, body))
            if (Option.isSome(yield* Config.option(Config.String("SIM_EXPECTS")))) yield* Console.log(`${EXPECTS} ${file} ${name} ${Math.max(0, ...calls)}`)
          }),
        ),
      timeoutMs + TIMEOUT_GRACE_MS,
    )
  return { seeded }
}
