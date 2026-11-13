// The seed runner: a simulated test runs once per seed, a failing seed names
// itself with the command that replays it, and a file's seeds share one wall
// budget.
//
// - `SEEDS` (20) fixed seeds by default. `SIM_SEED=<n>` runs that seed alone.
// - A failure fails with `SIM_SEED=<n> bun test <file>: <what failed>`.
// - A simulated file has `BUDGET_MS` (5 s) of wall time for all its seeds
//   together; the test that passes it fails, saying how long the file took.
// - Each body gets `expect`, which counts its calls. With `SIM_EXPECTS=1` the
//   runner runs one seed and prints `sim-expects <file> <test name> <calls>`
//   after each test, which scripts/accept-parity.test.ts reads.
//
// The runner reads wall time, through Effect's live clock, to hold the budget;
// a simulated file itself never does (sim/static.test.ts).
import { expect as bunExpect, test } from "bun:test"
import { Cause, Clock, Config, Console, Data, Effect, Exit, Option } from "effect"

export const SEEDS = 20
/** Wall time a simulated file's seeds may take together. */
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

/** A file's runner (`file` as `bun test` names it from opencode/): `seeded(name, body)` registers a test that runs `body` on every seed, within the file's budget. */
export const runner = (file: string) => {
  const spent = { ms: 0 }

  /** One seed of a body: its expect calls, or the failure naming the seed. */
  const once = <E>(name: string, seed: number, body: (run: Seeded) => Effect.Effect<void, E>) =>
    Effect.gen(function* () {
      const count = { calls: 0 }
      const began = yield* Clock.currentTimeMillis
      const exit = yield* Effect.exit(body({ seed, expect: counting(count) }))
      spent.ms += (yield* Clock.currentTimeMillis) - began
      if (Exit.isFailure(exit))
        return yield* Effect.fail(new SeedFailed({ message: `SIM_SEED=${seed} bun test ${file}: ${name}\n${Cause.pretty(exit.cause)}` }))
      if (spent.ms > BUDGET_MS)
        return yield* Effect.fail(
          new SeedFailed({ message: `${file}: its seeds took ${Math.round(spent.ms)} ms of wall time, past the ${BUDGET_MS} ms a simulated file has` }),
        )
      return count.calls
    })

  const seeded = <E>(name: string, body: (run: Seeded) => Effect.Effect<void, E>) =>
    test(name, () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const calls = yield* Effect.forEach(yield* seeds, (seed) => once(name, seed, body))
          if (Option.isSome(yield* Config.option(Config.String("SIM_EXPECTS")))) yield* Console.log(`${EXPECTS} ${file} ${name} ${Math.max(0, ...calls)}`)
        }),
      ),
    )
  return { seeded }
}
