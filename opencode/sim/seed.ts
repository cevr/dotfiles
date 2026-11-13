// The seed runner: a simulated test runs once per seed, a failing seed names
// itself with the command that replays it, and a file's seeds share one CPU
// budget.
//
// - `SEEDS` (20) fixed seeds by default. `SIM_SEED=<n>` runs that seed alone.
// - A failure fails with `SIM_SEED=<n> bun test <file>: <what failed>`.
// - A simulated file has `BUDGET_MS` (5 s) of CPU time for all its seeds
//   together; the test that passes it fails, saying the CPU and wall time the
//   file took. CPU, not wall: a simulated file waits on no real clock
//   (sim/static.test.ts), so on a quiet host its wall time is its CPU time,
//   and on a loaded one (the gate runs every file at once, at a load past the
//   cores) the wall time is the host's, not the file's. The wall time is
//   reported beside it, never judged.
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

export const SEEDS = 20
/** CPU time a simulated file's seeds may take together. */
export const BUDGET_MS = 5_000
/** The prefix of the line each test prints under `SIM_EXPECTS`. */
export const EXPECTS = "sim-expects"

/** A seed that failed, or a file past its budget. */
export class SeedFailed extends Data.TaggedError("SeedFailed")<{ readonly message: string }> {}

/** The seeds a run uses: `SIM_SEED` alone, one under `SIM_EXPECTS`, else 1 to `SEEDS`. */
export const seeds = Effect.gen(function* () {
  const one = yield* Config.option(Config.Int("SIM_SEED"))
  if (Option.isSome(one)) return [one.value]
  if (Option.isSome(yield* Config.option(Config.String("SIM_EXPECTS")))) return [1]
  return Array.from({ length: SEEDS }, (_, index) => index + 1)
})

export interface Seeded {
  readonly seed: number
  /** Bun's `expect`, counted. */
  readonly expect: typeof bunExpect
}

/** A bun test whose body is an Effect: the simulated suites' Effect test integration. */
export const effect = <A, E>(name: string, body: Effect.Effect<A, E>) => test(name, () => Effect.runPromise(Effect.asVoid(body)))

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

/** A file's runner (`file` as `bun test` names it from opencode/): `seeded(name, body)` registers a test that runs `body` on every seed, within the file's budget. */
export const runner = (file: string) => {
  const spent: Spent = { cpu: 0, wall: 0 }

  const seeded = <E>(name: string, body: (run: Seeded) => Effect.Effect<void, E>) =>
    test(name, () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const calls = yield* Effect.forEach(yield* seeds, (seed) => once(file, spent, name, seed, body))
          if (Option.isSome(yield* Config.option(Config.String("SIM_EXPECTS")))) yield* Console.log(`${EXPECTS} ${file} ${name} ${Math.max(0, ...calls)}`)
        }),
      ),
    )
  return { seeded }
}
