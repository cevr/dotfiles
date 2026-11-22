// The fork's feature checks (scripts/fork-checks.ts): the declared list parses and resolves at the fork, a red
// test, a lost file and a run that could not finish each hold the merge, and an expectation holds only on the
// host it declares. The upstream merge cases call the daily's own check step (scripts/upstream.ts `mergeChecks`)
// with fakes for the install, `bun run check` and the acceptance links, and the real feature step (the CLI) over
// a fake fork whose origin and upstream are local bare repositories: nothing is pushed anywhere else.
// @reads scripts/fork-checks.json
import * as BunServices from "@effect/platform-bun/BunServices"
import { Array as Arr, Config, Console, Context, Effect, FileSystem, Layer, Option, Path, Ref, Result, Stream } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { gitClone, gitInit, withProcessEnv } from "../tests/git-repo.ts"
import {
  casesOf,
  checkFork,
  declaredList,
  encodeListText,
  activeList,
  HostGauge,
  hostGauge,
  type Input,
  judge,
  LIMITS,
  type Limits,
  type List,
  listProblems,
  live,
  missingFiles,
  type Plan,
  plansOf,
  rangeOf,
  reportLines,
  type Ran,
  type Run,
  RunLock,
  TestRunner,
  type Verdict,
} from "./fork-checks.ts"
import { forkNamed, NO_FORK } from "./fork.ts"
import { ROOT } from "./reach.ts"
import { featureStep, mergeChecks, mergeUpstream, type StepRun, unlocked } from "./upstream.ts"

const list = (): List => Result.getOrThrow(declaredList)

const COMPOUND = "real-shell compound syntax > bash: printf '%s' \"$(probe() case value in value) scan_probe;; *) scan_other;; esac; probe)\""

/** Writes each of `files` (relative to `root`) with `text`, making its folders. */
const writeAll = (root: string, files: ReadonlyArray<readonly [string, string]>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* Effect.forEach(files, ([file, text]) =>
      fs.makeDirectory(path.dirname(path.join(root, file)), { recursive: true }).pipe(Effect.andThen(fs.writeFileString(path.join(root, file), text))),
    )
  })

describe("the declared list", () => {
  it.live.layer(BunServices.layer)("parses, has no problems, names the request that proved each feature, and every file is in the fork named by OPENCODE_DEV", () =>
    Effect.gen(function* () {
      const declared = list()
      expect(listProblems(declared)).toEqual([])
      expect(declared.features.every((feature) => feature.proved.length > 0)).toBe(true)
      // No fallback path: the gate names the fork, and without it the test fails saying so.
      const fork = yield* Effect.fromResult(forkNamed(Option.none(), yield* Config.option(Config.String("OPENCODE_DEV"))))
      // A feature whose `since` this checkout does not contain is not required here, and says so in the output.
      const active = yield* activeList(declared, fork)
      yield* Effect.forEach(active.notes, (note) => Console.log(`fork-checks list at ${fork}: ${note}`))
      expect(active.features.length + active.notes.length).toBe(declared.features.length)
      expect(yield* missingFiles({ features: active.features }, fork)).toEqual([])
      // The bash 3.2 expectation names a test the list runs.
      expect(declared.expectations.map((each) => each.test)).toContain(COMPOUND)
    }),
  )

  it.live.layer(BunServices.layer)("a file the fork lacks is named (red control)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "fork-checks-missing-" })
      yield* writeAll(dir, [["packages/x/test/a.test.ts", ""]])
      const one: List = { ...list(), features: [{ id: "x", feature: "x", package: "packages/x", files: ["test/a.test.ts", "test/gone.test.ts"], proved: "here" }], expectations: [] }
      expect(yield* missingFiles(one, dir)).toEqual([{ package: "packages/x", file: "test/gone.test.ts", test: "", why: "the listed file is not in the fork" }])
    }).pipe(Effect.scoped),
  )

  it.effect("names a package with no command, a twice-listed id and an expectation on an unlisted file", () =>
    Effect.sync(() => {
      const feature = { id: "x", feature: "x", package: "packages/none", files: ["test/a.test.ts"] as const, proved: "here" }
      const bad: List = { ...list(), features: [feature, { ...feature, package: "packages/core" }], expectations: [{ package: "packages/core", file: "test/b.test.ts", test: "t", host: { bash: "3.2.57" }, reason: "r" }] }
      expect(listProblems(bad)).toEqual(["x: package packages/none has no command", "x: the id is listed twice", 'expectation "t": packages/core/test/b.test.ts is in no feature'])
      const short: List = { ...list(), features: [{ ...feature, package: "packages/core", since: "5d44dfd789" }], expectations: [] }
      expect(listProblems(short)).toEqual(['x: since "5d44dfd789" is not a full commit sha'])
    }),
  )
})

describe("the fork a run checks", () => {
  it.effect("is --fork, else OPENCODE_DEV; with neither (or an empty one) the run fails naming both", () =>
    Effect.sync(() => {
      const none = Result.fail(NO_FORK)
      expect(NO_FORK).toContain("OPENCODE_DEV is not set")
      expect(forkNamed(Option.some("/flag"), Option.some("/dev"))).toEqual(Result.succeed("/flag"))
      expect(forkNamed(Option.none(), Option.some("/dev"))).toEqual(Result.succeed("/dev"))
      expect(forkNamed(Option.none(), Option.none())).toEqual(none)
      expect(forkNamed(Option.none(), Option.some(""))).toEqual(none)
    }),
  )

  it.live.layer(BunServices.layer)("the CLI with no fork named could not run (exit 2) and says to set OPENCODE_DEV", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const path = yield* Path.Path
      const out = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(ChildProcess.make("bun", [path.join(ROOT, "scripts/fork-checks.ts")], { env: { OPENCODE_DEV: "" }, extendEnv: true, stdin: "ignore", forceKillAfter: "1 second" }))
          return yield* Effect.all({ said: handle.all.pipe(Stream.decodeText(), Stream.mkString), code: handle.exitCode }, { concurrency: 2 })
        }),
      )
      expect(Number(out.code)).toBe(2)
      expect(out.said).toContain(`fork-checks: COULD NOT RUN: ${NO_FORK}`)
    }),
  )
})

/** A JUnit report as bun writes it: a file's suite, a describe block in it, and its tests. */
const junit = (file: string, tests: ReadonlyArray<readonly [describe: string, name: string, failed: boolean]>) =>
  [
    `<testsuites><testsuite name="${file}" file="${file}">`,
    ...tests.map(([block, name, failed]) => {
      const escaped = name.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("'", "&apos;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      const body = `<testcase name="${escaped}" file="${file}">${Arr.filter(['<failure type="AssertionError" message="no"/>'], () => failed).join("")}</testcase>`
      if (block === "") return body
      return `<testsuite name="${block}" file="${file}" line="2">${body}</testsuite>`
    }),
    "</testsuite></testsuites>",
  ].join("\n")

const COMPOUND_NAME = "bash: printf '%s' \"$(probe() case value in value) scan_probe;; *) scan_other;; esac; probe)\""

describe("reading a report", () => {
  it.effect("gives each test its describe blocks, its file and whether it failed", () =>
    Effect.sync(() => {
      expect(casesOf(junit("test/a.test.ts", [["real-shell compound syntax", COMPOUND_NAME, true], ["", "top", false]]))).toEqual([
        { file: "test/a.test.ts", test: COMPOUND, failed: true },
        { file: "test/a.test.ts", test: "top", failed: false },
      ])
    }),
  )
})

describe("an expectation", () => {
  const compound = Arr.head(list().expectations)
  const empty: Plan = { package: "", files: [], expected: [] }
  const plan = (bash: string): Plan => Option.getOrElse(Arr.findFirst(plansOf(list(), Option.some(bash)), (each) => each.package === "packages/core"), () => empty)
  const file = "test/shell-scan/compound-parity.test.ts"
  const others = (each: Plan) => each.files.filter((name) => name !== file).map((name) => ({ file: name, test: "passes", failed: false }))
  const run = (each: Plan, failed: boolean) => [...others(each), ...casesOf(junit(file, [["real-shell compound syntax", COMPOUND_NAME, failed]]))]

  it.effect("on the declared bash (3.2.57), its test failing is a note, not a red", () =>
    Effect.sync(() => {
      const judged = judge(plan("3.2.57"), 1, run(plan("3.2.57"), true))
      expect(judged.reds).toEqual([])
      expect(judged.notes).toEqual([`expected red on bash 3.2.57: packages/core/${file} > ${COMPOUND} (${Option.getOrElse(Option.map(compound, (each) => each.reason), () => "")})`])
    }),
  )

  it.effect("on any other bash the same failure is red (red control)", () =>
    Effect.sync(() => {
      expect(plan("5.2.37").expected).toEqual([])
      expect(judge(plan("5.2.37"), 1, run(plan("5.2.37"), true)).reds).toEqual([{ package: "packages/core", file, test: COMPOUND, why: "failed" }])
      expect(plansOf(list(), Option.none()).every((each) => each.expected.length === 0)).toBe(true)
    }),
  )

  it.effect("its test passing on the declared bash is red: a stale expectation cannot stay", () =>
    Effect.sync(() => {
      expect(judge(plan("3.2.57"), 0, run(plan("3.2.57"), false)).reds).toEqual([
        { package: "packages/core", file, test: COMPOUND, why: "declared red on bash 3.2.57 but it passed: remove the expectation" },
      ])
    }),
  )

  it.effect("its test gone from the run on the declared bash is red", () =>
    Effect.sync(() => {
      expect(judge(plan("3.2.57"), 0, [...others(plan("3.2.57")), { file, test: "another", failed: false }]).reds).toEqual([
        { package: "packages/core", file, test: COMPOUND, why: "declared red on bash 3.2.57 but it did not run: the expectation names a test that is gone" },
      ])
    }),
  )
})

describe("judging a run", () => {
  const plan: Plan = { package: "packages/x", files: ["test/a.test.ts", "test/b.test.ts"], expected: [] }
  it.effect("a listed file absent from the report ran no test, and is red", () =>
    Effect.sync(() => {
      expect(judge(plan, 1, [{ file: "test/a.test.ts", test: "t", failed: false }]).reds).toEqual([{ package: "packages/x", file: "test/b.test.ts", test: "", why: "the file ran no test (it did not load, or holds none)" }])
    }),
  )
  it.effect("a red exit with every test green is red", () =>
    Effect.sync(() => {
      const cases = plan.files.map((file) => ({ file, test: "t", failed: false }))
      expect(judge(plan, 0, cases).reds).toEqual([])
      expect(judge(plan, 1, cases).reds).toEqual([{ package: "packages/x", file: "(the run)", test: "", why: "bun test exited 1 with no failed test" }])
    }),
  )
})

/** A runner's answer: each run's files in a report, `failing` ones failed. */
const report = (run: Run, failing: ReadonlyArray<string> = []): Ran => ({
  kind: "exited",
  code: Number(failing.length > 0),
  log: "log",
  junit: Option.some(run.files.map((file) => junit(file, [["", "t", failing.includes(file)]])).join("\n")),
})

interface Fakes {
  /** The runner's answers, one per run, the last repeated. */
  readonly answers?: ReadonlyArray<(run: Run) => Ran>
  /** The 1-minute loads read in turn, the last repeated. */
  readonly loads?: ReadonlyArray<number>
  readonly floored?: boolean
  readonly freeBytes?: number
  /** Whether the lock is free. */
  readonly free?: boolean
}

/** What the fake services answer now, and what they were asked. */
interface Scene {
  readonly fakes: Fakes
  readonly runs: ReadonlyArray<Run>
  readonly reads: number
}

/** The scene the fake runner, gauge and lock play: a test sets it, then reads the runs. */
class Script extends Context.Service<Script, Ref.Ref<Scene>>()("fork-checks.test/Script") {}

const nth = <A>(items: ReadonlyArray<A>, at: number, fallback: A) => Option.getOrElse(Arr.get(items, Math.min(at, items.length - 1)), () => fallback)
const fakesOf = (scene: Scene) => ({
  answers: Option.getOrElse(Option.fromUndefinedOr(scene.fakes.answers), () => [(run: Run) => report(run)]),
  loads: Option.getOrElse(Option.fromUndefinedOr(scene.fakes.loads), () => [3]),
  floored: Option.getOrElse(Option.fromUndefinedOr(scene.fakes.floored), () => true),
  freeBytes: Option.getOrElse(Option.fromUndefinedOr(scene.fakes.freeBytes), () => 100 * 2 ** 30),
  free: Option.getOrElse(Option.fromUndefinedOr(scene.fakes.free), () => true),
})

/** The runner, gauge and lock over the script. */
const fakeServices = Layer.effectContext(
  Effect.gen(function* () {
    const script = yield* Script
    const run = (each: Run) =>
      Ref.modify(script, (scene) => {
        const next = { ...scene, runs: [...scene.runs, each] }
        return [nth(fakesOf(scene).answers, scene.runs.length, (one: Run) => report(one))(each), next] as const
      })
    const load = Ref.modify(script, (scene) => [nth(fakesOf(scene).loads, scene.reads, 0), { ...scene, reads: scene.reads + 1 }] as const)
    const scene = Ref.get(script)
    return Context.make(TestRunner, TestRunner.of({ run })).pipe(
      Context.add(
        HostGauge,
        HostGauge.of({
          bash: Effect.succeed(Option.some("5.2.37")),
          floored: Effect.map(scene, (now) => fakesOf(now).floored),
          load,
          freeBytes: () => Effect.map(scene, (now) => fakesOf(now).freeBytes),
        }),
      ),
      Context.add(
        RunLock,
        RunLock.of({
          holding: (_file, inner) => Effect.flatMap(scene, (now) => Effect.when(inner, Effect.succeed(fakesOf(now).free))),
        }),
      ),
    )
  }),
)

const fakeLayer = Layer.provideMerge(fakeServices, Layer.effect(Script, Ref.make<Scene>({ fakes: {}, runs: [], reads: 0 })))

/** A one-package fork in a scratch folder holding `files`, and the input over it. */
const fakeFork = (files: readonly [string, ...Array<string>]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "fork-checks-" })
    yield* writeAll(path.join(dir, "packages/x"), files.map((file) => [file, ""] as const))
    const listed: List = { about: "", packages: { "packages/x": ["bun", "test"] }, features: [{ id: "x", feature: "x", package: "packages/x", files, proved: "here" }], expectations: [] }
    return { dir, input: { list: listed, fork: dir, limits: LIMITS, lock: path.join(dir, "lock") } satisfies Input }
  })

/** The checks over `input` with the fake services playing `over`: the verdict and the runs asked for. */
const checkWith = (input: Input, over: Fakes) =>
  Effect.gen(function* () {
    const script = yield* Script
    yield* Ref.set(script, { fakes: over, runs: [], reads: 0 })
    const verdict = yield* checkFork(input)
    const scene = yield* Ref.get(script)
    return { verdict, runs: scene.runs, reads: scene.reads }
  })

describe("a run of the checks", () => {
  const test = it.scoped.layer(Layer.merge(fakeLayer, BunServices.layer))

  test("green: one run of the package, width 4, its files in list order", () =>
    Effect.gen(function* () {
      const { dir, input } = yield* fakeFork(["test/a.test.ts", "test/b.test.ts"])
      const { verdict, runs } = yield* checkWith(input, {})
      expect(verdict).toEqual({ kind: "green", notes: [] })
      expect(runs.map((run) => [run.cwd, run.files, run.threads])).toEqual([[`${dir}/packages/x`, ["test/a.test.ts", "test/b.test.ts"], 4]])
    }),
  )

  test("a file red twice is red; a file green on its rerun is a named flake", () =>
    Effect.gen(function* () {
      const { input } = yield* fakeFork(["test/a.test.ts", "test/b.test.ts"])
      const twice = yield* checkWith(input, { answers: [(run) => report(run, ["test/b.test.ts"])] })
      expect(twice.verdict).toMatchObject({ kind: "red", reds: [{ package: "packages/x", file: "test/b.test.ts", test: "t", why: "failed" }] })
      expect(twice.runs.map((run) => run.files)).toEqual([["test/a.test.ts", "test/b.test.ts"], ["test/b.test.ts"]])
      const once = yield* checkWith(input, { answers: [(run) => report(run, ["test/b.test.ts"]), (run) => report(run)] })
      expect(once.verdict).toEqual({ kind: "green", notes: ["flaky, green on the rerun: packages/x/test/b.test.ts"] })
    }),
  )

  test("a missing file is red before anything runs", () =>
    Effect.gen(function* () {
      const { input } = yield* fakeFork(["test/a.test.ts"])
      const lost: List = { ...input.list, features: [{ id: "x", feature: "x", package: "packages/x", files: ["test/a.test.ts", "test/gone.test.ts"], proved: "here" }] }
      const { verdict, runs } = yield* checkWith({ ...input, list: lost }, {})
      expect(verdict).toMatchObject({ kind: "red", reds: [{ file: "test/gone.test.ts" }] })
      expect(runs).toEqual([])
    }),
  )

  // The waits on the real clock with the poll and the wait cut to milliseconds; LIMITS holds the 15 s and 30 min.
  const waiting = it.scopedLive.layer(Layer.merge(fakeLayer, BunServices.layer))
  const SHORT: Limits = { ...LIMITS, everyMs: 5, waitMs: 60 }

  test("the limits: load 24, a 15 s poll and a 30 min wait, a 40 min bound, a 6 GiB floor, width 4", () =>
    Effect.sync(() => expect(LIMITS).toEqual({ maxLoad: 24, waitMs: 30 * 60_000, everyMs: 15_000, timeBoundMs: 40 * 60_000, diskFloor: 6 * 2 ** 30, threads: 4 })),
  )

  waiting("could not run: the load stays over 24 for the wait, and nothing runs", () =>
    Effect.gen(function* () {
      const { input } = yield* fakeFork(["test/a.test.ts"])
      const { verdict, runs, reads } = yield* checkWith({ ...input, limits: SHORT }, { loads: [30] })
      expect(verdict).toMatchObject({ kind: "could-not-run", reason: expect.stringContaining("load stayed over 24 for 0.001 min") })
      expect(runs).toEqual([])
      expect(reads).toBeGreaterThan(2)
    }),
  )

  waiting("waits while the load is over 24, then runs", () =>
    Effect.gen(function* () {
      const { input } = yield* fakeFork(["test/a.test.ts"])
      const { verdict, runs, reads } = yield* checkWith({ ...input, limits: SHORT }, { loads: [30, 25, 12] })
      expect(verdict).toEqual({ kind: "green", notes: [] })
      expect(runs.length).toBe(1)
      expect(reads).toBe(3)
    }),
  )

  test("could not run: under 6 GiB free where the floor applies (the Mac), and not elsewhere", () =>
    Effect.gen(function* () {
      const { input } = yield* fakeFork(["test/a.test.ts"])
      expect((yield* checkWith(input, { freeBytes: 5 * 2 ** 30 })).verdict).toMatchObject({ kind: "could-not-run", reason: expect.stringContaining("5.0 GiB free") })
      expect((yield* checkWith(input, { freeBytes: 5 * 2 ** 30, floored: false })).verdict).toEqual({ kind: "green", notes: [] })
    }),
  )

  waiting("could not run: another run holds the lock past the wait", () =>
    Effect.gen(function* () {
      const { input } = yield* fakeFork(["test/a.test.ts"])
      const { verdict, runs } = yield* checkWith({ ...input, limits: SHORT }, { free: false })
      expect(verdict).toMatchObject({ kind: "could-not-run", reason: expect.stringContaining("held the host's lock") })
      expect(runs).toEqual([])
    }),
  )

  test("could not run: the run passes the time bound, or writes no report", () =>
    Effect.gen(function* () {
      const { input } = yield* fakeFork(["test/a.test.ts"])
      const timedOut = yield* checkWith(input, { answers: [() => ({ kind: "timed-out", log: "still going" })] })
      expect(timedOut.verdict).toMatchObject({ kind: "could-not-run", reason: expect.stringContaining("ran past the time bound") })
      expect(Arr.map(timedOut.runs, (run) => run.timeoutMs)).toEqual([LIMITS.timeBoundMs])
      const silent = yield* checkWith(input, { answers: [() => ({ kind: "exited", code: 1, log: "error: no node_modules", junit: Option.none() })] })
      expect(silent.verdict).toMatchObject({ kind: "could-not-run", reason: expect.stringContaining("wrote no report") })
    }),
  )
})

describe("a feature's since: required only in a checkout that contains the commit", () => {
  const test = it.scoped.layer(Layer.merge(fakeLayer, BunServices.layer))

  /** A git fork: packages/x's test at its first commit, packages/y's new test at its second; the list's y feature since the second. */
  const sinceFork = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "fork-checks-since-" })
    yield* Effect.sync(() => gitInit(dir, ["--quiet", "-b", "prime-look"], GIT_ENV))
    yield* commit(dir, "packages/x/test/a.test.ts", "before")
    const before = yield* git(dir, "rev-parse", "HEAD")
    yield* commit(dir, "packages/y/test/new.test.ts", "the feature")
    const since = yield* git(dir, "rev-parse", "HEAD")
    const listed: List = {
      about: "",
      packages: { "packages/x": ["bun", "test"], "packages/y": ["bun", "test"] },
      features: [
        { id: "x", feature: "x", package: "packages/x", files: ["test/a.test.ts"], proved: "here" },
        { id: "y", feature: "y", package: "packages/y", files: ["test/new.test.ts"], proved: "here", since },
      ],
      expectations: [],
    }
    return { dir, before, since, input: { list: listed, fork: dir, limits: LIMITS, lock: `${dir}/lock` } satisfies Input }
  })

  test("a checkout without the commit: the feature is skipped and reported, never silently", () =>
    Effect.gen(function* () {
      const f = yield* sinceFork
      yield* git(f.dir, "checkout", "--quiet", "--detach", f.before)
      const { verdict, runs } = yield* checkWith(f.input, {})
      expect(verdict).toEqual({ kind: "green", notes: [`not yet in this checkout (since ${f.since}): y: packages/y/test/new.test.ts`] })
      expect(runs.map((run) => run.files)).toEqual([["test/a.test.ts"]])
      const text = reportLines(f.input.list, verdict, Option.none()).join("\n")
      expect(text).toContain(`not yet in this checkout (since ${f.since})`)
      expect(text).toContain("fork-checks: green, 1 features (1 not yet in this checkout)")
    }),
  )

  test("a checkout with the commit and the file: the file is required and runs", () =>
    Effect.gen(function* () {
      const f = yield* sinceFork
      const { verdict, runs } = yield* checkWith(f.input, {})
      expect(verdict).toEqual({ kind: "green", notes: [] })
      expect(runs.map((run) => [run.cwd, run.files])).toEqual([
        [`${f.dir}/packages/x`, ["test/a.test.ts"]],
        [`${f.dir}/packages/y`, ["test/new.test.ts"]],
      ])
    }),
  )

  test("a checkout with the commit but not the file (a merge lost it) is red", () =>
    Effect.gen(function* () {
      const f = yield* sinceFork
      yield* git(f.dir, "rm", "--quiet", "packages/y/test/new.test.ts")
      yield* git(f.dir, "commit", "--quiet", "-m", "a merge that lost it")
      const { verdict, runs } = yield* checkWith(f.input, {})
      expect(verdict).toEqual({ kind: "red", reds: [{ package: "packages/y", file: "test/new.test.ts", test: "", why: "the listed file is not in the fork" }], notes: [] })
      expect(runs).toEqual([])
    }),
  )

  test("a commit the checkout does not have at all is skipped, saying so", () =>
    Effect.gen(function* () {
      const f = yield* sinceFork
      const unknown = "0123456789abcdef0123456789abcdef01234567"
      const list: List = { ...f.input.list, features: [f.input.list.features[0], { id: "y", feature: "y", package: "packages/y", files: ["test/new.test.ts"], proved: "here", since: unknown }] }
      const { verdict } = yield* checkWith({ ...f.input, list }, {})
      expect(verdict.notes).toEqual([`not yet in this checkout (since ${unknown}; the checkout does not have that commit, git merge-base exited 128): y: packages/y/test/new.test.ts`])
    }),
  )
})

describe("the host", () => {
  it.live.layer(live)("the lock: a second holder gets none while the first runs, and the lock frees after", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const lock = yield* RunLock
      const file = `${yield* fs.makeTempDirectoryScoped({ prefix: "fork-checks-flock-" })}/fork-checks.flock`
      const green: Verdict = { kind: "green", notes: [] }
      const inner = yield* Ref.make<ReadonlyArray<Option.Option<Verdict>>>([])
      const outer = yield* lock.holding(file, Effect.map(Effect.flatMap(lock.holding(file, Effect.succeed(green)), (got) => Ref.update(inner, (all) => [...all, got])), () => green))
      expect(outer).toEqual(Option.some(green))
      expect(yield* Ref.get(inner)).toEqual([Option.none()])
      expect(yield* lock.holding(file, Effect.succeed(green))).toEqual(Option.some(green))
    }).pipe(Effect.scoped),
  )

  it.live.layer(Layer.provideMerge(hostGauge, BunServices.layer))("the gauge reads a load, the free space and bash's version", () =>
    Effect.gen(function* () {
      const gauge = yield* HostGauge
      expect(Number.isFinite(yield* gauge.load)).toBe(true)
      expect(yield* gauge.freeBytes(ROOT)).toBeGreaterThan(0)
      expect(Option.isSome(yield* gauge.bash)).toBe(true)
    }),
  )
})

const IDENTITY = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "fork checks test",
  GIT_AUTHOR_EMAIL: "fork-checks@test.invalid",
  GIT_COMMITTER_NAME: "fork checks test",
  GIT_COMMITTER_EMAIL: "fork-checks@test.invalid",
}
const GIT_ENV = withProcessEnv(IDENTITY)

/** Git in `repo`: its output, trimmed. */
const git = (repo: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const said = yield* spawner.string(ChildProcess.make("git", ["-C", repo, ...args], { env: IDENTITY, extendEnv: true, stdin: "ignore", forceKillAfter: "1 second" }))
    return said.trim()
  })

const commit = (repo: string, file: string, message: string) => writeAll(repo, [[file, `${message}\n`]]).pipe(Effect.andThen(git(repo, "add", "-A")), Effect.andThen(git(repo, "commit", "--quiet", "-m", message)))

describe("the merge range a report names", () => {
  it.live.layer(BunServices.layer)("upstream a..b when the head merges upstream/dev, merge parents a..b for another merge, none for a plain commit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "fork-checks-range-" })
      yield* Effect.sync(() => gitInit(dir, ["--quiet", "-b", "main"], GIT_ENV))
      yield* commit(dir, "a.txt", "root")
      expect(yield* rangeOf(dir)).toEqual(Option.none())
      yield* git(dir, "checkout", "--quiet", "-b", "side")
      yield* commit(dir, "b.txt", "side")
      const side = yield* git(dir, "rev-parse", "HEAD")
      yield* git(dir, "checkout", "--quiet", "main")
      yield* commit(dir, "c.txt", "main")
      const main = yield* git(dir, "rev-parse", "HEAD")
      yield* git(dir, "merge", "--quiet", "--no-edit", "side")
      const span = `${main.slice(0, 10)}..${side.slice(0, 10)}`
      expect(yield* rangeOf(dir)).toEqual(Option.some(`merge parents ${span}`))
      yield* git(dir, "update-ref", "refs/remotes/upstream/dev", side)
      expect(yield* rangeOf(dir)).toEqual(Option.some(`upstream ${span}`))
    }).pipe(Effect.scoped),
  )
})

describe("the daily's merge check step (mergeChecks) with the real feature step", () => {
  const FEATURES = "fork feature checks (scripts/fork-checks.ts)"

  /** A fake fork (origin and upstream bare, the fork cloned with prime-look), a package of real tests, upstream one commit ahead. */
  const fixture = (command: readonly [string, ...Array<string>], files: readonly [string, ...Array<string>]) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "fork-checks-merge-" }))
      const upstream = path.join(root, "upstream.git")
      const origin = path.join(root, "origin.git")
      const seed = path.join(root, "seed")
      yield* Effect.sync(() => {
        gitInit(upstream, ["--quiet", "--bare"], GIT_ENV)
        gitInit(origin, ["--quiet", "--bare"], GIT_ENV)
        gitInit(seed, ["--quiet", "-b", "dev"], GIT_ENV)
      })
      yield* writeAll(seed, [
        ["packages/x/test/green.test.ts", 'import { expect, test } from "bun:test"\ntest("passes", () => expect(1).toBe(1))\n'],
        ["packages/x/test/red.test.ts", 'import { expect, test } from "bun:test"\ntest("the fork feature", () => expect("<background-result>").toContain("<shell"))\n'],
      ])
      yield* git(seed, "add", "-A")
      yield* git(seed, "commit", "--quiet", "-m", "root")
      yield* git(seed, "push", "--quiet", upstream, "dev")
      // A fork commit on origin, so the merge is a real merge (two parents), as the daily's is.
      yield* git(seed, "checkout", "--quiet", "-b", "ours")
      yield* commit(seed, "ours.txt", "fork change")
      yield* git(seed, "push", "--quiet", origin, "ours:prime-look")
      yield* git(seed, "checkout", "--quiet", "dev")
      yield* commit(seed, "upstream.txt", "upstream change")
      yield* git(seed, "push", "--quiet", upstream, "dev")
      const fork = path.join(root, "fork")
      yield* Effect.sync(() => gitClone(origin, fork, ["--quiet", "--branch", "prime-look"], GIT_ENV))
      yield* git(fork, "remote", "add", "upstream", upstream)
      const listFile = path.join(root, "list.json")
      const listed: List = { about: "test", packages: { "packages/x": command }, features: [{ id: "x", feature: "the fork feature", package: "packages/x", files, proved: "here" }], expectations: [] }
      yield* fs.writeFileString(listFile, encodeListText(listed))
      const passed = (): Effect.Effect<StepRun> => Effect.succeed({ code: 0, log: "" })
      // The daily's own check step: fakes for the install, `bun run check` and the acceptance links (each needs a real
      // fork), the real feature step, the CLI over the merge, with a test list and lock.
      const checks = mergeChecks({
        install: passed,
        check: passed,
        features: featureStep(ROOT, ["--list", listFile, "--max-load", "1000", "--lock", path.join(root, "fork-checks.flock")]),
        accept: () => Effect.succeed({ ok: true }),
      })
      const report = path.join(root, "state/upstream-conflict.md")
      const merge = Effect.promise(() =>
        mergeUpstream({ fork, host: "Cristians-MacBook-Pro.local", skip: false, dryRun: false, checks, landing: unlocked, worktree: path.join(root, "state/upstream-merge"), report, log: () => {}, env: GIT_ENV }),
      )
      const head = (repo: string) => git(repo, "rev-parse", "prime-look")
      return { fork, origin, report, merge, before: yield* head(origin), head }
    })

  const test = it.live.layer(BunServices.layer)

  test("green checks: the merge goes to origin (control)", () =>
    Effect.gen(function* () {
      const f = yield* fixture(["bun", "test"], ["test/green.test.ts"])
      expect(yield* f.merge).toMatchObject({ kind: "merged" })
      expect(yield* f.head(f.origin)).not.toBe(f.before)
    }).pipe(Effect.scoped),
  )

  test(
    "a red test holds the push, and the report names the test and the upstream range",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const f = yield* fixture(["bun", "test"], ["test/green.test.ts", "test/red.test.ts"])
        expect(yield* f.merge).toMatchObject({ kind: "red", check: FEATURES })
        expect(yield* f.head(f.origin)).toBe(f.before)
        expect(yield* f.head(f.fork)).toBe(f.before)
        const text = yield* fs.readFileString(f.report)
        expect(text).toContain("# Upstream merge is red: fork feature checks")
        expect(text).toMatch(/fork-checks: RED over upstream [0-9a-f]{10}\.\.[0-9a-f]{10}, 1 tests/)
        expect(text).toContain("packages/x/test/red.test.ts > the fork feature [x]")
        expect(text).toMatch(/Upstream commits it brings: `git log [0-9a-f]{10}\.\.[0-9a-f]{10}` \(1 commit\)/)
      }).pipe(Effect.scoped),
    30_000,
  )

  test("a listed file the merge lacks holds the push", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const f = yield* fixture(["bun", "test"], ["test/green.test.ts", "test/gone.test.ts"])
      expect(yield* f.merge).toMatchObject({ kind: "red", check: FEATURES })
      expect(yield* f.head(f.origin)).toBe(f.before)
      expect(yield* fs.readFileString(f.report)).toContain("packages/x/test/gone.test.ts [x]: the listed file is not in the fork")
    }).pipe(Effect.scoped),
  )

  test("a run that could not finish holds the push", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      // A package command that writes no report: the run could not be judged.
      const f = yield* fixture(["false"], ["test/green.test.ts"])
      expect(yield* f.merge).toMatchObject({ kind: "red", check: FEATURES })
      expect(yield* f.head(f.origin)).toBe(f.before)
      expect(yield* fs.readFileString(f.report)).toContain("fork-checks: COULD NOT RUN")
      expect(yield* fs.exists(path.join(f.fork, "upstream.txt"))).toBe(false)
    }).pipe(Effect.scoped),
  )
})
