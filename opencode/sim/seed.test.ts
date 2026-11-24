// @reads all
// @reads-reason computed read at sim/seed.test.ts: const missing = yield* Effect.filter(listed, ([file]) => Effect.map(fs.exists(file), (exists) =
// The seed runner's budget: a file whose seeds spend more CPU than its budget
// fails, saying its CPU and wall time; one whose wall time runs long while it
// spends little CPU (a loaded host's time, not the file's work) passes. A
// file's past failing seeds run after the fixed ones. A seeded test past its
// timeout is stopped, its seeds with it, before the next test starts.
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Exit, FileSystem, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { describe, expect, test } from "bun:test"
import { TestClock } from "effect/testing"
import { type HostLoad as SeedHostLoad, type Spent as SeedSpent, once as SeedOnce, cpuVerdict as SeedCpuVerdict, unjudgedLine as SeedUnjudgedLine, simulationTest, SEEDS as SeedSEEDS, seedsOf as SeedSeedsOf, seeds as SeedSeeds, FOUND as SeedFOUND } from "./seed.ts"

const FILE = "sim/budget-probe.sim.test.ts"

/** A settled host and a loaded one, as the budget reads them: the judgement never depends on the host the test runs on. */
const SETTLED: SeedHostLoad = { load: 3, cores: 12 }
const LOADED: SeedHostLoad = { load: 40, cores: 12 }

/** What `body` on seeds 1 and 2 under `budgetMs` on `host` spent, and the message it failed with ("" when it passed). */
const run = (body: Effect.Effect<unknown>, cpuPerSeed: number, budgetMs: number, host: SeedHostLoad = SETTLED) =>
  Effect.gen(function* () {
    let readings = 0
    const cpu = Effect.sync(() => Math.floor(++readings / 2) * cpuPerSeed)
    const spent: SeedSpent = { cpu: 0, wall: 0 }
    const exit = yield* Effect.exit(Effect.forEach([1, 2], (seed) => SeedOnce(FILE, spent, "probe", seed, () => Effect.asVoid(body), budgetMs, Effect.succeed(host), cpu)))
    return { spent, failed: Exit.match(exit, { onFailure: String, onSuccess: () => "" }) }
  })

describe("a CPU budget's verdict", () => {
  test("is judged under three quarters of the cores, reported at or past them, and within the limit at any load", () => {
    expect([
      SeedCpuVerdict(4_001, 4_000, 3, 12),
      SeedCpuVerdict(4_001, 4_000, 8.9, 12),
      SeedCpuVerdict(4_001, 4_000, 9, 12),
      // orch-tools at load 11.2-11.7 took 4868-5512 ms against 4731-5204 ms at load 5.3-6.0: inflated, not judged.
      SeedCpuVerdict(5_489, 5_000, 11.5, 12),
      SeedCpuVerdict(4_262, 4_000, 48, 12),
      SeedCpuVerdict(4_000, 4_000, 48, 12),
      SeedCpuVerdict(2_700, 4_000, 3, 12),
      SeedCpuVerdict(4_001, 4_000, 2.9, 4),
      SeedCpuVerdict(4_001, 4_000, 3, 4),
    ]).toEqual(["over", "over", "unjudged", "unjudged", "unjudged", "within", "within", "over", "unjudged"])
  })

  test("a reported budget's line names its file, what passed its limit and the host's load", () => {
    expect(SeedUnjudgedLine("cmd/a.sim.test.tsx", "boot: 4262 ms of CPU time, past the 4000 ms a boot has", { load: 41.24, cores: 12 })).toBe(
      "sim-unjudged cmd/a.sim.test.tsx boot: 4262 ms of CPU time, past the 4000 ms a boot has, on a loaded host (load 41.2, 12 cores): reported, not judged",
    )
  })
})

describe("the seed runner's budget", () => {
  simulationTest("a file whose seeds spend more CPU than the budget on a settled host fails, naming its CPU and wall time",
    Effect.gen(function* () {
      const { spent, failed } = yield* run(Effect.void, 40, 60)
      expect(spent.cpu).toBe(80)
      expect(failed).toMatch(/sim\/budget-probe\.sim\.test\.ts: its seeds took \d+ ms of CPU time \(\d+ ms of wall time\), past the 60 ms of CPU a simulated file has/)
    }),
  )

  simulationTest("past the budget on a loaded host, a file passes, reported and not judged again for its other seeds",
    Effect.gen(function* () {
      const { spent, failed } = yield* run(Effect.void, 40, 30, LOADED)
      expect(spent.cpu).toBe(80)
      expect(spent.unjudged).toBe(true)
      expect(failed).toBe("")
    }),
  )

  simulationTest("a file whose wall time runs past the budget on little CPU passes",
    Effect.gen(function* () {
      // Each seed's wall time is a minute (the clock moved, as a loaded host's does), its CPU next to none.
      const { spent, failed } = yield* run(TestClock.adjust("1 minute"), 1, 50)
      expect(failed).toBe("")
      expect(spent.wall).toBe(120_000)
      expect(spent.cpu).toBe(2)
    }).pipe(Effect.provide(TestClock.layer())),
  )
})

describe("a file's past failing seeds", () => {
  simulationTest("run after 1 to SEEDS, in order, each once, with none of 1 to SEEDS twice",
    Effect.gen(function* () {
      const fixed = Array.from({ length: SeedSEEDS }, (_, index) => index + 1)
      expect(yield* SeedSeedsOf([353, 27, 353, 2])).toEqual([...fixed, 27, 353])
      expect(yield* SeedSeeds).toEqual(fixed)
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
  simulationTest("is stopped with its seeds: the next test sees none of them run, and it fails naming its timeout",
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
  simulationTest("is judged on wall time: a test under fake timers whose seeds move the virtual clock far past it runs every seed",
    Effect.gen(function* () {
      const said = yield* fixtureRun("./sim/fixtures/seed-fake-timers.fixture.ts")
      expect(said).toContain(`seed-fake-timers: ${SeedSEEDS} seeds ran`)
      expect(said).not.toContain("past its 1000 ms timeout")
      expect(said).toMatch(/^ 4 pass\n 0 fail$/m)
    }),
  )
  // A seed still running at the runner's timeout and past bun's own (the 5 s grace) once ran on into the next test,
  // and its failure landed between the tests: the runner checked its deadline only between seeds.
  simulationTest("stops a seed mid-run: one that would outlast bun's own timeout never runs on into the next test",
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

describe("the seeds a swarm once found (sim/seeds.json)", () => {
  simulationTest("each is replayed on every run of its file: the fixture listed there fails on its listed seed",
    Effect.gen(function* () {
      const said = yield* fixtureRun("./sim/fixtures/seeds-json.fixture.ts")
      expect(said).toContain("SIM_SEED=77777 bun test sim/fixtures/seeds-json.fixture.ts: a seed sim/seeds.json lists is replayed")
      expect(said).toMatch(/^ 0 pass\n 1 fail$/m)
    }),
  )

  simulationTest("names only files that exist, each with whole seeds past the fixed ones",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const listed = Object.entries(SeedFOUND)
      const missing = yield* Effect.filter(listed, ([file]) => Effect.map(fs.exists(file), (exists) => !exists))
      expect({ missing, wrong: listed.filter(([, seeds]) => !seeds.every((seed) => Number.isInteger(seed) && seed > SeedSEEDS)) }).toEqual({ missing: [], wrong: [] })
    }).pipe(Effect.provide(NodeServices.layer)),
  )
})
