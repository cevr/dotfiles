// The seed runner's budget: a file whose seeds spend more CPU than its budget
// fails, saying its CPU and wall time; one whose wall time runs long while it
// spends little CPU (a loaded host's time, not the file's work) passes. A
// file's past failing seeds run after the fixed ones. A seeded test past its
// timeout is stopped, its seeds with it, before the next test starts.
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Exit, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { describe, expect } from "bun:test"
import { TestClock } from "effect/testing"
import * as Seed from "./seed.ts"

const FILE = "sim/budget-probe.sim.test.ts"

/** Spends `ms` of this process's CPU time, busy. */
const busy = (ms: number) =>
  Effect.sync(() => {
    const began = process.cpuUsage()
    let spins = 0
    for (;;) {
      const used = process.cpuUsage(began)
      if ((used.user + used.system) / 1000 >= ms) return spins
      spins += 1
    }
  })

/** What `body` on seeds 1 and 2 under `budgetMs` spent, and the message it failed with ("" when it passed). */
const run = (body: Effect.Effect<unknown>, budgetMs: number) =>
  Effect.gen(function* () {
    const spent: Seed.Spent = { cpu: 0, wall: 0 }
    const exit = yield* Effect.exit(Effect.forEach([1, 2], (seed) => Seed.once(FILE, spent, "probe", seed, () => Effect.asVoid(body), budgetMs)))
    return { spent, failed: Exit.match(exit, { onFailure: String, onSuccess: () => "" }) }
  })

describe("the seed runner's budget", () => {
  Seed.effect("a file whose seeds spend more CPU than the budget fails, naming its CPU and wall time",
    Effect.gen(function* () {
      const { spent, failed } = yield* run(busy(40), 60)
      expect(spent.cpu).toBeGreaterThan(60)
      expect(failed).toMatch(/sim\/budget-probe\.sim\.test\.ts: its seeds took \d+ ms of CPU time \(\d+ ms of wall time\), past the 60 ms of CPU a simulated file has/)
    }),
  )

  Seed.effect("a file whose wall time runs past the budget on little CPU passes",
    Effect.gen(function* () {
      // Each seed's wall time is a minute (the clock moved, as a loaded host's does), its CPU next to none.
      const { spent, failed } = yield* run(TestClock.adjust("1 minute"), 50)
      expect(failed).toBe("")
      expect(spent.wall).toBe(120_000)
      expect(spent.cpu).toBeLessThan(50)
    }).pipe(Effect.provide(TestClock.layer())),
  )
})

describe("a file's past failing seeds", () => {
  Seed.effect("run after 1 to SEEDS, in order, each once, with none of 1 to SEEDS twice",
    Effect.gen(function* () {
      const fixed = Array.from({ length: Seed.SEEDS }, (_, index) => index + 1)
      expect(yield* Seed.seedsOf([353, 27, 353, 2])).toEqual([...fixed, 27, 353])
      expect(yield* Seed.seeds).toEqual(fixed)
    }),
  )
})

/** A child's whole output, as text. */
const text = (stream: Stream.Stream<Uint8Array, unknown>) => stream.pipe(Stream.decodeText(), Stream.mkString)

/** A fixture's own `bun test`, from opencode/ in a process group of its own: its stdout and stderr together. */
const fixtureRun = (path: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    // bun's timeout for the fixture's tests: past the timeout fixture runner's 300 ms, short of its 20 seeds' 2 s.
    const child = yield* spawner.spawn(
      ChildProcess.make(process.execPath, ["test", "--timeout", "1000", path], { stdin: "ignore", forceKillAfter: "3 seconds" }),
    )
    const [stdout, stderr] = yield* Effect.all([text(child.stdout), text(child.stderr)], { concurrency: 2 })
    yield* child.exitCode
    return `${stdout}\n${stderr}`
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
const fixture = fixtureRun("./sim/fixtures/seed-timeout.fixture.ts")

describe("a seeded test past its timeout", () => {
  Seed.effect("is stopped with its seeds: the next test sees none of them run, and it fails naming its timeout",
    Effect.gen(function* () {
      const said = yield* fixture
      expect(said).toMatch(/seed-timeout: \d+ seeds ran before, 0 after/)
      expect(said).toContain("sim/fixtures/seed-timeout.fixture.ts: seeds that run past the timeout: past its 300 ms timeout; its seeds were stopped")
      // The timed-out test is the one failure: the next test passed.
      expect(said).toContain("(fail) seeds that run past the timeout")
      expect(said).not.toContain("(fail) the next test")
      expect(said).toMatch(/^ 1 pass\n 1 fail$/m)
      expect(said).not.toContain("Unhandled error between tests")
    }),
  )
  // sim-tui's TUI files hold bun's fake timers from their boot on: a timer the runner armed under them moved on
  // the seeds' virtual advances (16 seeds past 240 s of virtual time in 4 s of wall time) and stopped a test that had
  // run for seconds.
  Seed.effect("is judged on wall time: a test under fake timers whose seeds move the virtual clock far past it runs every seed",
    Effect.gen(function* () {
      const said = yield* fixtureRun("./sim/fixtures/seed-fake-timers.fixture.ts")
      expect(said).toContain(`seed-fake-timers: ${Seed.SEEDS} seeds ran`)
      expect(said).not.toContain("past its 1000 ms timeout")
      expect(said).toMatch(/^ 4 pass\n 0 fail$/m)
    }),
  )
  // A seed still running at the runner's timeout and past bun's own (the 5 s grace) once ran on into the next test,
  // and its failure landed between the tests: the runner checked its deadline only between seeds.
  Seed.effect("stops a seed mid-run: one that would outlast bun's own timeout never runs on into the next test",
    Effect.gen(function* () {
      const said = yield* fixtureRun("./sim/fixtures/seed-hang.fixture.ts")
      expect(said).toContain("seed-hang: during the next test: (none)")
      expect(said).toContain("sim/fixtures/seed-hang.fixture.ts: a seed that outlasts bun's timeout: past its 300 ms timeout; its seeds were stopped")
      expect(said).toContain("(fail) a seed that outlasts bun's timeout")
      expect(said).not.toContain("timed out after")
      expect(said).toMatch(/^ 1 pass\n 1 fail$/m)
      expect(said).not.toContain("Unhandled error between tests")
    }),
  )
})
