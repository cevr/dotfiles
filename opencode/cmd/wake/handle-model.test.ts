// The registry's Quint model (handle.qnt, a copy of the run's acceptance model) checked with its mutants:
// the model holds `safe`; each mutant breaks it (a race that loses a result, a restart that loses another
// owner's call, a late letter); and the witness shows the race is reached. Needs `quint` on PATH.
import { describe, expect } from "bun:test"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, Path, Stream } from "effect"
import { it } from "effect-bun-test"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

/** One run: its step, its invariant, and whether that invariant must hold. */
const RUNS = [
  { step: "step", invariant: "safe", holds: true },
  { step: "stepRace", invariant: "safe", holds: false },
  { step: "stepGlobalRestart", invariant: "safe", holds: false },
  { step: "stepLate", invariant: "safe", holds: false },
  { step: "step", invariant: "raceNeverSeen", holds: false },
] as const

const quint = Effect.fn("HandleModel.quint")(function* (step: string, invariant: string) {
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const model = path.join(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))), "../../mods/wake/handle.qnt")
  const handle = yield* spawner.spawn(
    ChildProcess.make("quint", ["run", model, `--step=${step}`, `--invariant=${invariant}`, "--max-samples=20000", "--max-steps=40"], {
      stdout: "pipe",
      stderr: "pipe",
      forceKillAfter: "5 seconds",
    }),
  )
  const [out, err] = yield* Effect.all([handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.stderr.pipe(Stream.decodeText(), Stream.mkString)], {
    concurrency: 2,
  })
  return `${out}\n${err}`
})

describe("handle.qnt", () => {
  it.effect.layer(BunServices.layer)("holds `safe`, each mutant breaks it, and the race is reached", () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const run of RUNS) {
          const output = yield* quint(run.step, run.invariant)
          expect(output.includes("[ok]"), `${run.step} --invariant=${run.invariant}: ${output}`).toBe(run.holds)
          expect(output.includes("[violation]"), `${run.step} --invariant=${run.invariant}: ${output}`).toBe(!run.holds)
        }
      }),
    ),
    // Five model runs of 20,000 samples each: about 10 s on the Mac (measured: one run 1.6 s).
    60_000,
  )
})
