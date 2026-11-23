// The fork's feature checks (scripts/fork-checks.ts): the declared list parses and resolves at the fork, a red
// test, a lost file and a run that could not finish each hold the merge, and an expectation holds only on the
// host it declares. The upstream merge cases call the daily's own check step (scripts/upstream.ts `mergeChecks`)
// with fakes for the install, `bun run check` and the acceptance links, and the real feature step (the CLI) over
// a fake fork whose origin and upstream are local bare repositories: nothing is pushed anywhere else.
import * as BunServices from "@effect/platform-bun/BunServices"
import { Array as Arr, Clock, Config, Console, Context, Duration, Effect, FileSystem, Layer, Option, Path, Ref, Result, Stream } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { gitClone, gitInit, withProcessEnv } from "../tests/git-repo.ts"
import { scratchInput } from "../tests/read-path.ts"
import {
  type Case,
  casesOf,
  checkFork,
  declaredList,
  encodeListText,
  activeList,
  exitAccounted,
  ExitExplanation,
  exitOf,
  FLAKY,
  FLAKY_EXIT,
  RERUN,
  SkipNote,
  HostGauge,
  hostGauge,
  type HostUnread,
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
  type Skip,
  type Status,
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
      const bad: List = { ...list(), skips: [], features: [feature, { ...feature, package: "packages/core" }], expectations: [{ package: "packages/core", file: "test/b.test.ts", test: "t", host: { bash: "3.2.57" }, reason: "r" }] }
      expect(listProblems(bad)).toEqual(["x: package packages/none has no command", "x: the id is listed twice", 'expectation "t": packages/core/test/b.test.ts is in no feature'])
      const short: List = { ...list(), skips: [], features: [{ ...feature, package: "packages/core", since: "5d44dfd789" }], expectations: [] }
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

/** A case in a report the tests build. */
const caseOf = (file: string, test: string, status: Status = "passed"): Case => ({ file, test, status })

/** What bun writes inside a testcase for each status (failed for `true`, passed for `false`). */
const INSIDE: Readonly<Record<Status, string>> = {
  passed: "",
  failed: '<failure type="AssertionError" message="no"/>',
  skipped: "<skipped />",
  todo: '<skipped message="TODO" />',
}
const statusOf = (given: boolean | Status): Status => {
  if (given === true) return "failed"
  if (given === false) return "passed"
  return given
}

/** A JUnit report as bun writes it: a file's suite, a describe block in it, and its tests. */
const junit = (file: string, tests: ReadonlyArray<readonly [describe: string, name: string, status: boolean | Status]>) =>
  [
    `<testsuites><testsuite name="${file}" file="${file}">`,
    ...tests.map(([block, name, status]) => {
      const escaped = name.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("'", "&apos;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      const body = `<testcase name="${escaped}" file="${file}">${INSIDE[statusOf(status)]}</testcase>`
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
        { file: "test/a.test.ts", test: COMPOUND, status: "failed" },
        { file: "test/a.test.ts", test: "top", status: "passed" },
      ])
    }),
  )
})

describe("an expectation", () => {
  const compound = Arr.head(list().expectations)
  const empty: Plan = { package: "", command: ["bun", "test"], files: [], expected: [], skips: [] }
  // The declared skips judged elsewhere ("skipped and todo cases"); here only the expectation.
  const plan = (bash: string): Plan => Option.getOrElse(Arr.findFirst(plansOf({ ...list(), skips: [] }, Option.some(bash)), (each) => each.package === "packages/core"), () => empty)
  const file = "test/shell-scan/compound-parity.test.ts"
  const others = (each: Plan) => each.files.filter((name) => name !== file).map((name) => (caseOf(name, "passes")))
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
      expect(judge(plan("3.2.57"), 0, [...others(plan("3.2.57")), caseOf(file, "another")]).reds).toEqual([
        { package: "packages/core", file, test: COMPOUND, why: "declared red on bash 3.2.57 but it did not run: the expectation names a test that is gone" },
      ])
    }),
  )
})

describe("judging a run", () => {
  const plan: Plan = { package: "packages/x", command: ["bun", "test"], files: ["test/a.test.ts", "test/b.test.ts"], expected: [], skips: [] }
  it.effect("a listed file absent from the report ran no test, and is red", () =>
    Effect.sync(() => {
      expect(judge(plan, 0, [caseOf("test/a.test.ts", "t")]).reds).toEqual([{ package: "packages/x", file: "test/b.test.ts", test: "", why: "the file ran no test (the runner did not run it: it did not load, holds none, or was filtered out)" }])
    }),
  )
  it.effect("a red exit with every test green is red", () =>
    Effect.sync(() => {
      const cases = plan.files.map((file) => caseOf(file, "t"))
      expect(judge(plan, 0, cases).reds).toEqual([])
      expect(judge(plan, 1, cases).reds).toEqual([{ package: "packages/x", file: "(the run)", test: "", why: "bun test exited 1, and no failed test in its report accounts for it (a failed test exits 1; a skip accounts for no exit)" }])
    }),
  )
})

describe("skipped and todo cases", () => {
  const plan: Plan = { package: "packages/x", command: ["bun", "test"], files: ["test/a.test.ts"], expected: [], skips: [] }
  const declared: Skip = { package: "packages/x", file: "test/a.test.ts", test: "needs a tty", reason: "no terminal in CI" }
  const red = (test: string, why: string) => ({ package: "packages/x", file: "test/a.test.ts", test, why })

  it.effect("bun's own report: skip, todo, skipIf, if(false) and describe.skip are not executed; test.failing is", () =>
    Effect.sync(() => {
      // bun 1.4.4's JUnit for a file of each kind (probe/kinds.test.ts in the unit's run dir).
      const real = [
        '<testsuites><testsuite name="a.test.ts" file="a.test.ts" tests="7">',
        '<testcase name="runs" classname="" time="0.000019" file="a.test.ts" line="3" assertions="1" />',
        '<testcase name="skipped one" file="a.test.ts" assertions="0">\n<skipped />\n</testcase>',
        '<testcase name="todo one" file="a.test.ts" assertions="0">\n<skipped message="TODO" />\n</testcase>',
        '<testcase name="skipIf true" file="a.test.ts" assertions="0">\n<skipped />\n</testcase>',
        '<testsuite name="skipped block" file="a.test.ts" line="8"><testcase name="inside" classname="skipped block" file="a.test.ts" assertions="0">\n<skipped />\n</testcase></testsuite>',
        '<testcase name="failing one" file="a.test.ts" line="11" assertions="1" />',
        "</testsuite></testsuites>",
      ].join("\n")
      expect(casesOf(real).map((found) => [found.test, found.status])).toEqual([
        ["runs", "passed"],
        ["skipped one", "skipped"],
        ["todo one", "todo"],
        ["skipIf true", "skipped"],
        ["skipped block > inside", "skipped"],
        ["failing one", "passed"],
      ])
    }),
  )

  it.effect("a listed file whose every case is skipped or todo ran no test, and is red", () =>
    Effect.sync(() => {
      const cases = [caseOf("test/a.test.ts", "one", "skipped"), caseOf("test/a.test.ts", "two", "todo")]
      expect(judge({ ...plan, skips: [{ ...declared, test: "one" }, { ...declared, test: "two" }] }, 0, cases).reds).toEqual([
        red("", "the file ran no test: its 2 cases were all skipped or todo"),
      ])
    }),
  )

  it.effect("an undeclared skip or todo beside a running test is red", () =>
    Effect.sync(() => {
      const cases = [caseOf("test/a.test.ts", "runs"), caseOf("test/a.test.ts", "needs a tty", "skipped"), caseOf("test/a.test.ts", "later", "todo")]
      expect(judge(plan, 0, cases).reds).toEqual([
        red("needs a tty", "skipped, and fork-checks.json declares no skip for it: declare it with its reason, or let it run"),
        red("later", "todo, and fork-checks.json declares no skip for it: declare it with its reason, or let it run"),
      ])
    }),
  )

  it.effect("a declared skip that skipped is a note; one that ran, or is gone, is red", () =>
    Effect.sync(() => {
      const skipping = judge({ ...plan, skips: [declared] }, 0, [caseOf("test/a.test.ts", "runs"), caseOf("test/a.test.ts", "needs a tty", "skipped")])
      expect(skipping).toMatchObject({ reds: [], explanations: [], skipped: [new SkipNote({ skip: declared })], notes: ["skipped as declared: packages/x/test/a.test.ts > needs a tty; why: no terminal in CI"] })
      expect(judge({ ...plan, skips: [declared] }, 0, [caseOf("test/a.test.ts", "runs"), caseOf("test/a.test.ts", "needs a tty")]).reds).toEqual([
        red("needs a tty", "declared skipped but it ran: remove the skip"),
      ])
      expect(judge({ ...plan, skips: [declared] }, 0, [caseOf("test/a.test.ts", "runs")]).reds).toEqual([
        red("needs a tty", "declared skipped but it is gone: the skip names a test the file does not hold"),
      ])
    }),
  )

  it.effect("a host-dependent skip holds only on its bash; elsewhere the same skip is undeclared and red", () =>
    Effect.sync(() => {
      const onBash: List = {
        about: "",
        packages: { "packages/x": ["bun", "test"] },
        features: [{ id: "x", feature: "x", package: "packages/x", files: ["test/a.test.ts"], proved: "here" }],
        expectations: [],
        skips: [{ ...declared, host: { bash: "3.2.57" } }],
      }
      const cases = [caseOf("test/a.test.ts", "runs"), caseOf("test/a.test.ts", "needs a tty", "skipped")]
      const at = (bash: string) => judge(Option.getOrElse(Arr.head(plansOf(onBash, Option.some(bash))), () => plan), 0, cases)
      expect(at("3.2.57")).toMatchObject({ reds: [], explanations: [], notes: ["skipped as declared on bash 3.2.57: packages/x/test/a.test.ts > needs a tty; why: no terminal in CI"] })
      expect(at("5.2.37").reds).toEqual([red("needs a tty", "skipped, and fork-checks.json declares no skip for it: declare it with its reason, or let it run")])
    }),
  )

  it.effect("an expected-red test that skipped did not run, and is red", () =>
    Effect.sync(() => {
      const expectation = { package: "packages/x", file: "test/a.test.ts", test: "bash 3", host: { bash: "3.2.57" }, reason: "r" }
      const judged = judge({ ...plan, expected: [expectation], skips: [{ ...declared, test: "bash 3" }] }, 0, [caseOf("test/a.test.ts", "runs"), caseOf("test/a.test.ts", "bash 3", "skipped")])
      expect(judged.reds).toEqual([red("bash 3", "declared red on bash 3.2.57 but it was skipped: it did not run")])
    }),
  )

  it.effect("the list names a skip on an unlisted file, or one with no reason", () =>
    Effect.sync(() => {
      const bad: List = { ...list(), skips: [{ ...declared, file: "test/nowhere.test.ts" }, { ...declared, package: "packages/core", file: "test/tool-shell.test.ts", reason: " " }] }
      expect(listProblems(bad)).toEqual(['skip "needs a tty": packages/x/test/nowhere.test.ts is in no feature', 'skip "needs a tty": no reason'])
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
  /** The commands on PATH. */
  readonly present?: ReadonlyArray<string>
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
  present: Option.getOrElse(Option.fromUndefinedOr(scene.fakes.present), (): ReadonlyArray<string> => []),
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
          has: (command) => Effect.map(scene, (now) => fakesOf(now).present.includes(command)),
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
      expect(verdict).toMatchObject({ kind: "could-not-run", reason: "the calm-host wait (0.001 min, every wait together) was spent before packages/x ran: the 1-minute load stayed over 24" })
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
      expect(timedOut.verdict).toMatchObject({ kind: "could-not-run", reason: expect.stringContaining("ran past the package runs' budget (40 min)") })
      expect(Arr.map(timedOut.runs, (run) => run.timeoutMs)).toEqual([LIMITS.timeBoundMs])
      const silent = yield* checkWith(input, { answers: [() => ({ kind: "exited", code: 1, log: "error: no node_modules", junit: Option.none() })] })
      expect(silent.verdict).toMatchObject({ kind: "could-not-run", reason: expect.stringContaining("wrote no report") })
    }),
  )

  test("red: the runner exits 0 and writes no report, so no listed file is proven to have run", () =>
    Effect.gen(function* () {
      const { input } = yield* fakeFork(["test/a.test.ts"])
      const none = yield* checkWith(input, { answers: [() => ({ kind: "exited", code: 0, log: "", junit: Option.none() })] })
      expect(none.verdict).toMatchObject({ kind: "red", reds: [{ package: "packages/x", file: "test/a.test.ts", why: "the runner exited 0 and wrote no report: the file is not proven to have run" }] })
    }),
  )

  test("a skip declared for a host without a command holds only where none of those commands is on PATH", () =>
    Effect.gen(function* () {
      const { input } = yield* fakeFork(["test/a.test.ts"])
      const list: List = { ...input.list, skips: [{ package: "packages/x", file: "test/a.test.ts", test: "pwsh case", host: { missing: ["pwsh", "powershell"] }, reason: "no PowerShell" }] }
      const answer = (): Ran => ({ kind: "exited", code: 0, log: "", junit: Option.some(junit("test/a.test.ts", [["", "runs", "passed"], ["", "pwsh case", "skipped"]])) })
      const without = yield* checkWith({ ...input, list }, { answers: [answer] })
      expect(without.verdict).toEqual({ kind: "green", notes: ["skipped as declared without pwsh or powershell on PATH: packages/x/test/a.test.ts > pwsh case; why: no PowerShell"] })
      const withIt = yield* checkWith({ ...input, list }, { answers: [answer], present: ["powershell"] })
      expect(withIt.verdict).toMatchObject({ kind: "red", reds: [{ test: "pwsh case", why: expect.stringContaining("skipped, and fork-checks.json declares no skip for it") }] })
    }),
  )
})

// What may explain a nonzero exit: every composition of the runner's exit, a skip, an expected failure and its
// report, through checkFork (what the CLI runs) here and through the daily's merge at the bare-ref boundary below.
const EXITS = [0, 1, 7] as const
const SKIP_CELLS = ["none", "declared", "undeclared", "stale"] as const
const EXPECT_CELLS = ["none", "observed", "passing"] as const
const REPORT_CELLS = ["present", "absent", "truncated"] as const
interface Cell {
  /** The runner's exit: 0, bun's exit for a failed test, or a package command's own failure after its tests. */
  readonly exit: (typeof EXITS)[number]
  /** The flagged test: none; skipped and declared; skipped and undeclared; declared but it ran (stale). */
  readonly skip: (typeof SKIP_CELLS)[number]
  /** The expected test: none; declared red and failing; declared red but passing. */
  readonly expectation: (typeof EXPECT_CELLS)[number]
  /** bun's JUnit report: whole, none, or cut short. */
  readonly report: (typeof REPORT_CELLS)[number]
}
const CELLS: ReadonlyArray<Cell> = EXITS.flatMap((exit) =>
  SKIP_CELLS.flatMap((skip) => EXPECT_CELLS.flatMap((expectation) => REPORT_CELLS.map((report) => ({ exit, skip, expectation, report })))),
)
const nameOf = (cell: Cell) => `exit ${cell.exit}, skip ${cell.skip}, expected failure ${cell.expectation}, report ${cell.report}`

/**
 * The outcome each cell must have. Without a whole report nothing is proven: red on exit 0, could not run on any
 * other. With one, green only where the exit is 0, or 1 with the expected failure observed, and every skip is
 * declared and real; a skip explains no exit.
 */
const outcomeOf = (cell: Cell): Verdict["kind"] => {
  if (cell.report !== "present") {
    if (cell.exit === 0) return "red"
    return "could-not-run"
  }
  const skips = cell.skip === "none" || cell.skip === "declared"
  const exit = cell.exit === 0 || (cell.exit === 1 && cell.expectation === "observed")
  if (skips && cell.expectation !== "passing" && exit) return "green"
  return "red"
}
/** Whether the cell's nonzero exit stands unexplained in a whole report (a red that names the command and its exit). */
const unexplainedExit = (cell: Cell) => cell.report === "present" && cell.exit !== 0 && !(cell.exit === 1 && cell.expectation === "observed")

const CELL_FILE = "test/green.test.ts"
type Row = readonly [describe: string, name: string, status: boolean | Status]
const FLAGGED: Readonly<Record<Cell["skip"], ReadonlyArray<Row>>> = { none: [], declared: [["", "flagged", "skipped"]], undeclared: [["", "flagged", "skipped"]], stale: [["", "flagged", "passed"]] }
const EXPECTED: Readonly<Record<Cell["expectation"], ReadonlyArray<Row>>> = { none: [], observed: [["", "expected", "failed"]], passing: [["", "expected", "passed"]] }
/** The cell's report as bun writes it (`present`), none, or cut short before its closing tags. */
const cellReport = (cell: Cell): Option.Option<string> => {
  const text = junit(CELL_FILE, [["", "runs", "passed"], ...FLAGGED[cell.skip], ...EXPECTED[cell.expectation]])
  const cut = text.slice(0, text.lastIndexOf("</testsuite>"))
  const reports: Readonly<Record<Cell["report"], Option.Option<string>>> = { present: Option.some(text), absent: Option.none(), truncated: Option.some(cut) }
  return reports[cell.report]
}
/** The cell's declarations: the flagged test's skip when declared (or stale), the expected test's expectation on `bash`. */
const cellDeclarations = (cell: Cell, bash: string) => ({
  skips: Arr.filter([{ package: "packages/x", file: CELL_FILE, test: "flagged", reason: "fixture: deliberate skip" }], () => cell.skip === "declared" || cell.skip === "stale"),
  expectations: Arr.filter([{ package: "packages/x", file: CELL_FILE, test: "expected", host: { bash }, reason: "fixture: red on this bash" }], () => cell.expectation !== "none"),
})

describe("what may explain a nonzero exit, every composition through checkFork", () => {
  const test = it.scoped.layer(Layer.merge(fakeLayer, BunServices.layer))

  test("the table: green only where the exit is 0 or fully explained and every skip is declared and real", () =>
    Effect.gen(function* () {
      const { input } = yield* fakeFork([CELL_FILE])
      const outcomes = yield* Effect.forEach(CELLS, (cell) =>
        Effect.gen(function* () {
          const list: List = { ...input.list, ...cellDeclarations(cell, "5.2.37") }
          const ran: Ran = { kind: "exited", code: cell.exit, log: `the package's log\nfixture: post-test step exited ${cell.exit}`, junit: cellReport(cell) }
          const { verdict } = yield* checkWith({ ...input, list }, { answers: [() => ran] })
          const lines = reportLines(list, verdict, Option.none()).join("\n")
          return { cell, kind: verdict.kind, code: exitOf(verdict), lines }
        }),
      )
      expect(outcomes.map((each) => `${nameOf(each.cell)}: ${each.kind}`)).toEqual(CELLS.map((cell) => `${nameOf(cell)}: ${outcomeOf(cell)}`))
      expect(outcomes.map((each) => each.code)).toEqual(CELLS.map((cell) => ({ green: 0, red: 1, "could-not-run": 2 })[outcomeOf(cell)]))
      // An unexplained exit names the command and its exit, and the log's tail; a report-less run names the exit and the tail.
      for (const each of outcomes.filter((one) => unexplainedExit(one.cell)))
        expect(each.lines).toContain(`RED packages/x/(the run) [x]: bun test exited ${each.cell.exit}, and no failed test in its report accounts for it`)
      for (const each of outcomes.filter((one) => one.kind !== "green")) expect(each.lines).toContain(`fixture: post-test step exited ${each.cell.exit}`)
      for (const each of outcomes.filter((one) => one.kind === "could-not-run")) expect(each.lines).toContain(`bun test in packages/x exited ${each.cell.exit} and wrote`)
      expect(outcomes.filter((each) => each.kind === "green").map((each) => nameOf(each.cell))).toEqual([
        "exit 0, skip none, expected failure none, report present",
        "exit 0, skip none, expected failure observed, report present",
        "exit 0, skip declared, expected failure none, report present",
        "exit 0, skip declared, expected failure observed, report present",
        "exit 1, skip none, expected failure observed, report present",
        "exit 1, skip declared, expected failure observed, report present",
      ])
    }),
  )

  test("a skip note and an exit explanation are apart: a declared skip beside exit 7 is red, an expected failure explains only exit 1", () =>
    Effect.sync(() => {
      const plan: Plan = { package: "packages/x", command: ["bun", "runner.ts"], files: [CELL_FILE], expected: [], skips: [] }
      const declared = cellDeclarations({ exit: 7, skip: "declared", expectation: "observed", report: "present" }, "5.2.37")
      const cases = [caseOf(CELL_FILE, "runs"), caseOf(CELL_FILE, "flagged", "skipped"), caseOf(CELL_FILE, "expected", "failed")]
      const skipOnly = judge({ ...plan, skips: declared.skips }, 7, cases.slice(0, 2))
      expect(skipOnly.skipped).toHaveLength(1)
      expect(skipOnly.explanations).toEqual([])
      expect(exitAccounted(7, skipOnly.explanations)).toBe(false)
      expect(skipOnly.reds).toEqual([
        { package: "packages/x", file: "(the run)", test: "", why: "bun runner.ts exited 7, and no failed test in its report accounts for it (a failed test exits 1; a skip accounts for no exit)" },
      ])
      const both = { ...plan, skips: declared.skips, expected: declared.expectations }
      expect(judge(both, 1, cases).reds).toEqual([])
      expect(judge(both, 7, cases).reds.map((each) => each.file)).toEqual(["(the run)"])
      expect(judge(both, 1, cases).explanations).toMatchObject([{ exit: 1, failed: { test: "expected" } }])
      expect(judge(both, 1, cases).explanations.every((each) => each instanceof ExitExplanation)).toBe(true)
    }),
  )
})

// What a rerun leaves in the report: each file's facts from its last run, merged per file. File A holds a declared
// skip, an expected failure or plain passes; file B fails once, fails twice or passes; A's run is observed once, or
// rerun whole (its first exit, 7, is unaccounted for); A and B share a package or sit in two.
const A_CELLS = ["declared skip", "expected failure", "plain pass"] as const
const B_CELLS = ["fails once", "fails twice", "passes"] as const
const A_RERUN_CELLS = ["A observed once", "A rerun"] as const
const PLACES = ["same package", "different packages"] as const
interface RerunCell {
  readonly a: (typeof A_CELLS)[number]
  readonly b: (typeof B_CELLS)[number]
  readonly rerun: (typeof A_RERUN_CELLS)[number]
  readonly place: (typeof PLACES)[number]
}
const RERUN_CELLS: ReadonlyArray<RerunCell> = A_CELLS.flatMap((a) => B_CELLS.flatMap((b) => A_RERUN_CELLS.flatMap((rerun) => PLACES.map((place) => ({ a, b, rerun, place })))))
const rerunName = (cell: RerunCell) => `A ${cell.a}, B ${cell.b}, ${cell.rerun}, ${cell.place}`

const FILE_A = "test/a.test.ts"
const FILE_B = "test/b.test.ts"
const packagesOf = (cell: RerunCell) => ({ a: "packages/x", b: Option.getOrElse(Option.liftPredicate("packages/x", () => cell.place === "same package"), () => "packages/y") })
const SKIP_NOTE = (pkg: string) => `skipped as declared: ${pkg}/${FILE_A} > optional check; why: declared for this fixture`
const EXPECTED_NOTE = (pkg: string) => `expected red on bash 5.2.37: ${pkg}/${FILE_A} > expected (red on this bash)`

/** The cell's list: A's and B's features, A's skip or expectation declared. */
const rerunList = (cell: RerunCell): List => {
  const at = packagesOf(cell)
  return {
    about: "",
    packages: { [at.a]: ["bun", "test"], [at.b]: ["bun", "test"] },
    features: [
      { id: "a", feature: "a", package: at.a, files: [FILE_A], proved: "here" },
      { id: "b", feature: "b", package: at.b, files: [FILE_B], proved: "here" },
    ],
    skips: Arr.filter([{ package: at.a, file: FILE_A, test: "optional check", reason: "declared for this fixture" }], () => cell.a === "declared skip"),
    expectations: Arr.filter([{ package: at.a, file: FILE_A, test: "expected", host: { bash: "5.2.37" }, reason: "red on this bash" }], () => cell.a === "expected failure"),
  }
}

/** The runner's answer to the cell's run: each file's tests as the cell plays them on that attempt (1 or 2 of its package). */
const rerunAnswer = (cell: RerunCell, run: Run, attempt: number): Ran => {
  const aRows: Readonly<Record<RerunCell["a"], ReadonlyArray<Row>>> = {
    "declared skip": [["", "runs", "passed"], ["", "optional check", "skipped"]],
    "expected failure": [["", "runs", "passed"], ["", "expected", "failed"]],
    "plain pass": [["", "runs", "passed"]],
  }
  const bFails = cell.b === "fails twice" || (cell.b === "fails once" && attempt === 1)
  const rows = (file: string): ReadonlyArray<Row> => Option.getOrElse(Option.liftPredicate(aRows[cell.a], () => file === FILE_A), (): ReadonlyArray<Row> => [["", "t", bFails]])
  const failed = run.files.some((file) => (file === FILE_A && cell.a === "expected failure") || (file === FILE_B && bFails))
  const unaccounted = run.files.includes(FILE_A) && cell.rerun === "A rerun" && attempt === 1
  const code = Option.getOrElse(Option.liftPredicate(7, () => unaccounted), () => Number(failed))
  return { kind: "exited", code, log: `log of attempt ${attempt}`, junit: Option.some(run.files.map((file) => junit(file, rows(file))).join("\n")) }
}

/** The runner's answers in the order the cell's runs come: each package's first run, then its rerun when it has one. */
const rerunAnswers = (cell: RerunCell): ReadonlyArray<(run: Run) => Ran> => {
  const aReruns = cell.rerun === "A rerun"
  const bReruns = cell.b !== "passes"
  const attempts = Option.match(Option.liftPredicate(cell, () => cell.place === "same package"), {
    onSome: () => [1, ...Arr.filter([2], () => aReruns || bReruns)],
    onNone: () => [1, ...Arr.filter([2], () => aReruns), 1, ...Arr.filter([2], () => bReruns)],
  })
  return attempts.map((attempt) => (run: Run) => rerunAnswer(cell, run, attempt))
}

/**
 * The notes each cell's report must carry, in order, each once. Per package: A's expected failure or skip from its
 * last run; the flakes (B, when its red test passed on the rerun; never A, whose own tests never failed); the files
 * rerun only with their package (A when its package's exit 7 reran it, B when it passed and shared that rerun); the
 * exit 7 gone on the rerun; then the last run's log on a red. Red only where B fails twice.
 */
const rerunNotes = (cell: RerunCell): ReadonlyArray<string> => {
  const at = packagesOf(cell)
  const aFacts = [...Arr.filter([EXPECTED_NOTE(at.a)], () => cell.a === "expected failure"), ...Arr.filter([SKIP_NOTE(at.a)], () => cell.a === "declared skip")]
  const aRerun = cell.rerun === "A rerun"
  const same = cell.place === "same package"
  const line = (label: string, files: ReadonlyArray<string>) => Arr.filter([`${label}: ${files.join(", ")}`], () => files.length > 0)
  const flakes = line(FLAKY, Arr.filter([`${at.b}/${FILE_B}`], () => cell.b === "fails once"))
  const withPackage = (files: ReadonlyArray<string>) => line(RERUN, files)
  const exitGone = Arr.filter([`${FLAKY_EXIT}: ${at.a}: bun test exited 7, and no failed test in its report accounts for it (a failed test exits 1; a skip accounts for no exit)`], () => aRerun)
  const log = Arr.filter([`${at.b} log (bun test, exit 1):\nlog of attempt 2`], () => cell.b === "fails twice")
  if (same) {
    const rerunWith = [...Arr.filter([`${at.a}/${FILE_A}`], () => aRerun), ...Arr.filter([`${at.b}/${FILE_B}`], () => aRerun && cell.b === "passes")]
    return [...aFacts, ...flakes, ...withPackage(rerunWith), ...exitGone, ...log]
  }
  return [...aFacts, ...withPackage(Arr.filter([`${at.a}/${FILE_A}`], () => aRerun)), ...exitGone, ...flakes, ...log]
}

/** A scratch fork holding the cell's two files. */
const rerunFork = (cell: RerunCell) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "fork-checks-rerun-" })
    const at = packagesOf(cell)
    yield* writeAll(dir, [
      [`${at.a}/${FILE_A}`, ""],
      [`${at.b}/${FILE_B}`, ""],
    ])
    return { list: rerunList(cell), fork: dir, limits: LIMITS, lock: path.join(dir, "lock") } satisfies Input
  })

describe("a rerun: each file's facts from its last run, merged per file", () => {
  const test = it.scoped.layer(Layer.merge(fakeLayer, BunServices.layer))

  test("every combination: the skips, the expected failures, the flakes and the outcome, each named once", () =>
    Effect.gen(function* () {
      const outcomes = yield* Effect.forEach(RERUN_CELLS, (cell) =>
        Effect.gen(function* () {
          const input = yield* rerunFork(cell)
          const { verdict, runs } = yield* checkWith(input, { answers: rerunAnswers(cell) })
          return { cell, verdict, runs, lines: reportLines(input.list, verdict, Option.none()) }
        }),
      )
      expect(outcomes.map((each) => `${rerunName(each.cell)}: ${each.verdict.kind}`)).toEqual(RERUN_CELLS.map((cell) => `${rerunName(cell)}: ${Option.getOrElse(Option.liftPredicate("red", () => cell.b === "fails twice"), () => "green")}`))
      expect(outcomes.map((each) => `${rerunName(each.cell)}: ${each.verdict.notes.join(" | ")}`)).toEqual(RERUN_CELLS.map((cell) => `${rerunName(cell)}: ${rerunNotes(cell).join(" | ")}`))
      // Every run the cell plays was asked for: none left over, none missing.
      expect(outcomes.map((each) => each.runs.length)).toEqual(RERUN_CELLS.map((cell) => rerunAnswers(cell).length))
      for (const each of outcomes) {
        const summary = each.lines.at(-1)
        const at = packagesOf(each.cell)
        if (each.verdict.kind === "green")
          expect([rerunName(each.cell), summary]).toEqual([
            rerunName(each.cell),
            `fork-checks: green, 2 features${Arr.filter([`; 1 skipped as declared: ${at.a}/${FILE_A} > optional check`], () => each.cell.a === "declared skip").join("")}`,
          ])
        if (each.verdict.kind === "red") expect([rerunName(each.cell), summary]).toEqual([rerunName(each.cell), `fork-checks: RED, 1 tests: ${at.b}/${FILE_B} > t [b]`])
        // No superseded first-run log: an attempt-1 log is never in a report.
        expect([rerunName(each.cell), each.lines.join("\n")]).not.toEqual([rerunName(each.cell), expect.stringContaining("log of attempt 1")])
      }
    }),
  )

  test("the verifier's probe: a declared skip in a file passed once, a flake beside it, both named", () =>
    Effect.gen(function* () {
      const cell: RerunCell = { a: "declared skip", b: "fails once", rerun: "A observed once", place: "same package" }
      const input = yield* rerunFork(cell)
      const { verdict, runs } = yield* checkWith(input, { answers: rerunAnswers(cell) })
      expect(runs.map((run) => run.files)).toEqual([[FILE_A, FILE_B], [FILE_B]])
      expect(exitOf(verdict)).toBe(0)
      expect(reportLines(input.list, verdict, Option.none())).toEqual([
        SKIP_NOTE("packages/x"),
        `${FLAKY}: packages/x/${FILE_B}`,
        `fork-checks: green, 2 features; 1 skipped as declared: packages/x/${FILE_A} > optional check`,
      ])
    }),
  )

  test("a file whose facts differ on its rerun: the report holds the rerun's only, and says the file was rerun", () =>
    Effect.gen(function* () {
      const input = yield* rerunFork({ a: "declared skip", b: "passes", rerun: "A rerun", place: "same package" })
      const list: List = { ...input.list, features: [{ id: "a", feature: "a", package: "packages/x", files: [FILE_A], proved: "here" }] }
      const at = "packages/x"
      const exitGone = `${FLAKY_EXIT}: ${at}: bun test exited 7, and no failed test in its report accounts for it (a failed test exits 1; a skip accounts for no exit)`
      // The first run exits 7, so the package reruns whole, whatever its tests showed.
      const play = (first: ReadonlyArray<Row>, second: ReadonlyArray<Row>) =>
        checkWith(
          { ...input, list },
          {
            answers: [
              () => ({ kind: "exited", code: 7, log: "log of attempt 1", junit: Option.some(junit(FILE_A, first)) }),
              () => ({ kind: "exited", code: 0, log: "log of attempt 2", junit: Option.some(junit(FILE_A, second)) }),
            ],
          },
        )
      const skippedThenRan = yield* play(
        [["", "runs", "passed"], ["", "optional check", "skipped"]],
        [["", "runs", "passed"], ["", "optional check", "passed"]],
      )
      expect(skippedThenRan.verdict).toEqual({
        kind: "red",
        reds: [{ package: at, file: FILE_A, test: "optional check", why: "declared skipped but it ran: remove the skip" }],
        notes: [`${RERUN}: ${at}/${FILE_A}`, exitGone, `${at} log (bun test, exit 0):\nlog of attempt 2`],
      })
      const ranThenSkipped = yield* play(
        [["", "runs", "passed"], ["", "optional check", "passed"]],
        [["", "runs", "passed"], ["", "optional check", "skipped"]],
      )
      expect(ranThenSkipped.verdict).toEqual({ kind: "green", notes: [SKIP_NOTE(at), `${FLAKY}: ${at}/${FILE_A}`, exitGone] })
      const renamed = yield* play(
        [["", "runs", "passed"], ["", "optional check", "skipped"]],
        [["", "runs", "passed"], ["", "optional check, renamed", "skipped"]],
      )
      expect(renamed.verdict).toMatchObject({
        kind: "red",
        reds: [
          { file: FILE_A, test: "optional check, renamed", why: expect.stringContaining("skipped, and fork-checks.json declares no skip for it") },
          { file: FILE_A, test: "optional check", why: "declared skipped but it is gone: the skip names a test the file does not hold" },
        ],
        notes: [`${RERUN}: ${at}/${FILE_A}`, exitGone, `${at} log (bun test, exit 0):\nlog of attempt 2`],
      })
      expect([skippedThenRan, ranThenSkipped, renamed].map((each) => each.runs.map((run) => run.files))).toEqual([
        [[FILE_A], [FILE_A]],
        [[FILE_A], [FILE_A]],
        [[FILE_A], [FILE_A]],
      ])
    }),
  )
})

// The three budgets, on a virtual clock the fakes move: the lock frees, the load drops and a package's run ends at
// set times, and a sleep moves the clock at once, so hours of waiting take no time. What the check must show: no wait
// is charged to the package runs, and each budget, spent, names itself.
const MIN = 60_000

/** When each thing happens: the lock frees at `lockFreeAt`; the load stays high for `before` after the lock is taken and for `between` after each run; each run takes its `runs` entry. */
interface Plot {
  readonly lockFreeAt: number
  readonly before: number
  readonly between: number
  readonly runs: ReadonlyArray<number>
  /** Whether a run reports its files failing (in turn; the last repeated). */
  readonly failing?: ReadonlyArray<boolean>
}

/** The virtual clock and the fakes over it; `play` sets a plot and the clock to 0, `runs` answers what the runner was asked. */
/** The virtual clock's time, when the load drops, the plot playing and the runs asked for. */
interface Scenery {
  now: number
  highUntil: number
  plot: Plot
  runs: Array<Run>
}

class Timeline extends Context.Service<Timeline, { readonly play: (plot: Plot) => Effect.Effect<void>; readonly runs: Effect.Effect<ReadonlyArray<Run>> }>()("fork-checks.test/Timeline") {}

const timelineLayer = Layer.unwrap(
  Effect.sync(() => {
    const state: Scenery = { now: 0, highUntil: 0, plot: { lockFreeAt: 0, before: 0, between: 0, runs: [] }, runs: [] }
    const clock: Clock.Clock = {
      currentTimeMillisUnsafe: () => state.now,
      currentTimeMillis: Effect.sync(() => state.now),
      currentTimeNanosUnsafe: () => BigInt(state.now) * 1_000_000n,
      currentTimeNanos: Effect.sync(() => BigInt(state.now) * 1_000_000n),
      monotonicTimeNanosUnsafe: () => BigInt(state.now) * 1_000_000n,
      monotonicTimeNanos: Effect.sync(() => BigInt(state.now) * 1_000_000n),
      sleep: (duration) => Effect.sync(() => (state.now += Duration.toMillis(duration))),
    }
    const run = (each: Run) =>
      Effect.sync((): Ran => {
        const at = state.runs.length
        state.runs.push(each)
        const takes = nth(state.plot.runs, at, 0)
        if (takes > each.timeoutMs) {
          state.now += each.timeoutMs
          return { kind: "timed-out", log: "still running" }
        }
        state.now += takes
        state.highUntil = state.now + state.plot.between
        return report(each, Arr.filter(each.files, () => nth(Option.getOrElse(Option.fromUndefinedOr(state.plot.failing), (): ReadonlyArray<boolean> => [false]), at, false)))
      })
    const holding = <R>(_file: string, inner: Effect.Effect<Verdict, HostUnread, R>) =>
      Effect.suspend(() => {
        if (state.now < state.plot.lockFreeAt) return Effect.succeed(Option.none<Verdict>())
        state.highUntil = state.now + state.plot.before
        return Effect.map(inner, Option.some)
      })
    const timeline = Timeline.of({
      play: (plot) =>
        Effect.sync(() => {
          state.now = 0
          state.highUntil = 0
          state.plot = plot
          state.runs = []
        }),
      runs: Effect.sync(() => [...state.runs]),
    })
    return Layer.mergeAll(
      Layer.succeed(Timeline, timeline),
      Layer.succeed(Clock.Clock, clock),
      Layer.succeed(TestRunner, TestRunner.of({ run })),
      Layer.succeed(RunLock, RunLock.of({ holding })),
      Layer.succeed(
        HostGauge,
        HostGauge.of({
          bash: Effect.succeed(Option.some("5.2.37")),
          floored: Effect.succeed(false),
          load: Effect.sync(() => 1 + 29 * Number(state.now < state.highUntil)),
          freeBytes: () => Effect.succeed(100 * 2 ** 30),
          has: () => Effect.succeed(false),
        }),
      ),
    )
  }),
)

/** A two-package fork (x, then y) in a scratch folder, and the input over it with the real limits. */
const twoPackages = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "fork-checks-budget-" })
  yield* writeAll(dir, [
    ["packages/x/test/a.test.ts", ""],
    ["packages/y/test/b.test.ts", ""],
  ])
  const listed: List = {
    about: "",
    packages: { "packages/x": ["bun", "test"], "packages/y": ["bun", "test"] },
    features: [
      { id: "x", feature: "x", package: "packages/x", files: ["test/a.test.ts"], proved: "here" },
      { id: "y", feature: "y", package: "packages/y", files: ["test/b.test.ts"], proved: "here" },
    ],
    expectations: [],
  }
  return { list: listed, fork: dir, limits: LIMITS, lock: path.join(dir, "lock") } satisfies Input
})

const WAITS = { none: 0, short: 5 * MIN, "just under": 30 * MIN - LIMITS.everyMs, over: 31 * MIN } as const
type Wait = keyof typeof WAITS
const WAIT_CELLS: ReadonlyArray<Wait> = ["none", "short", "just under", "over"]
/** The two packages' run times: under the 40 min budget, exactly at it, and past it. */
const RUN_TIMES = { under: [10 * MIN, 10 * MIN], at: [20 * MIN, 20 * MIN], over: [20 * MIN, 25 * MIN] } as const
type RunTime = keyof typeof RUN_TIMES
const RUN_CELLS: ReadonlyArray<RunTime> = ["under", "at", "over"]
interface BudgetCell {
  readonly lock: Wait
  readonly before: Wait
  readonly between: Wait
  readonly run: RunTime
}
const BUDGET_CELLS: ReadonlyArray<BudgetCell> = WAIT_CELLS.flatMap((lock) =>
  WAIT_CELLS.flatMap((before) => WAIT_CELLS.flatMap((between) => RUN_CELLS.map((run) => ({ lock, before, between, run })))),
)
const budgetName = (cell: BudgetCell) => `lock ${cell.lock}, load before x ${cell.before}, load between x and y ${cell.between}, runs ${cell.run}`

/**
 * What each cell must end with. The lock wait over its 30 min: could not run, nothing ran. The calm-host waits
 * together over their 30 min: could not run before x (the first wait alone over) or before y. The runs past 40 min:
 * could not run, y past the run budget. Else green, whatever the waits took.
 */
const budgetOutcome = (cell: BudgetCell): string => {
  if (cell.lock === "over") return "could-not-run: lock wait"
  if (cell.before === "over") return "could-not-run: calm-host wait before packages/x"
  if (WAITS[cell.before] + WAITS[cell.between] > 30 * MIN) return "could-not-run: calm-host wait before packages/y"
  if (cell.run === "over") return "could-not-run: package runs, packages/y"
  return "green"
}
/** Which budget a could-not-run reason names. */
const budgetNamed = (verdict: Verdict): string => {
  if (verdict.kind !== "could-not-run") return verdict.kind
  if (verdict.reason.startsWith("the lock wait (30 min) was spent")) return "could-not-run: lock wait"
  if (verdict.reason.startsWith("the calm-host wait (30 min, every wait together) was spent before packages/x")) return "could-not-run: calm-host wait before packages/x"
  if (verdict.reason.startsWith("the calm-host wait (30 min, every wait together) was spent before packages/y")) return "could-not-run: calm-host wait before packages/y"
  if (verdict.reason.startsWith("packages/y ran past the package runs' budget (40 min)")) return "could-not-run: package runs, packages/y"
  return `could-not-run: ${verdict.reason}`
}

describe("three budgets apart: the lock wait, the calm-host waits and the package runs", () => {
  const test = it.scoped.layer(Layer.merge(timelineLayer, BunServices.layer))

  test("every combination: only the runs are charged to the run budget, and a spent budget names itself", () =>
    Effect.gen(function* () {
      const timeline = yield* Timeline
      const input = yield* twoPackages
      const outcomes = yield* Effect.forEach(BUDGET_CELLS, (cell) =>
        Effect.gen(function* () {
          yield* timeline.play({ lockFreeAt: WAITS[cell.lock], before: WAITS[cell.before], between: WAITS[cell.between], runs: RUN_TIMES[cell.run] })
          const verdict = yield* checkFork(input)
          return { cell, verdict, runs: yield* timeline.runs }
        }),
      )
      expect(outcomes.map((each) => `${budgetName(each.cell)}: ${budgetNamed(each.verdict)}`)).toEqual(BUDGET_CELLS.map((cell) => `${budgetName(cell)}: ${budgetOutcome(cell)}`))
      // The run budget each run is offered: 40 min less the runs before it, never less any wait.
      for (const each of outcomes)
        expect(each.runs.map((run) => run.timeoutMs)).toEqual(each.runs.map((_, at) => 40 * MIN - RUN_TIMES[each.cell.run].slice(0, at).reduce((sum, ms) => sum + ms, 0)))
      for (const each of outcomes.filter((one) => one.verdict.kind === "could-not-run"))
        expect(each.verdict.notes.join("\n")).toMatch(/^budgets: lock wait \d+\.\d s of 30 min; calm-host wait \d+\.\d s of 30 min; package runs \d+\.\d s of 40 min$/m)
      // The verifier's own case: both waits just under their allowance, then 40 minutes of runs, is green.
      expect(outcomes.filter((each) => each.cell.lock === "just under" && each.cell.before === "just under" && each.cell.between === "none" && each.cell.run === "at").map((each) => each.verdict.kind)).toEqual(["green"])
    }),
  )

  test("a rerun is charged to the run budget: a red file rerun, then a package past what is left", () =>
    Effect.gen(function* () {
      const timeline = yield* Timeline
      const input = yield* twoPackages
      yield* timeline.play({ lockFreeAt: 0, before: 0, between: 0, runs: [15 * MIN, 15 * MIN, 15 * MIN], failing: [true, false, false] })
      const verdict = yield* checkFork(input)
      expect(budgetNamed(verdict)).toBe("could-not-run: package runs, packages/y")
      expect((yield* timeline.runs).map((run) => run.timeoutMs)).toEqual([40 * MIN, 25 * MIN, 10 * MIN])
      expect(verdict.notes).toContain("budgets: lock wait 0.0 s of 30 min; calm-host wait 0.0 s of 30 min; package runs 2400.0 s of 40 min")
    }),
  )

  test("the verifier's probes: the lock, then the load, free after two 75 ms waits, with a 60 ms run budget, are green and run once", () =>
    Effect.gen(function* () {
      const timeline = yield* Timeline
      const input = yield* twoPackages
      const one: Input = { ...input, list: { ...input.list, features: [input.list.features[0]] }, limits: { ...LIMITS, timeBoundMs: 60, everyMs: 75, waitMs: 1000 } }
      yield* timeline.play({ lockFreeAt: 150, before: 0, between: 0, runs: [0] })
      expect(yield* checkFork(one)).toEqual({ kind: "green", notes: [] })
      expect((yield* timeline.runs).length).toBe(1)
      yield* timeline.play({ lockFreeAt: 0, before: 150, between: 0, runs: [0] })
      expect(yield* checkFork(one)).toEqual({ kind: "green", notes: [] })
      expect((yield* timeline.runs).length).toBe(1)
    }),
  )
})

describe("a feature's since: required only in a checkout that contains the commit", () => {
  // Each case makes and reads a real git fork: 30 s each, for a loaded host.
  const scoped = it.scoped.layer(Layer.merge(fakeLayer, BunServices.layer))
  const test = (name: string, self: Parameters<typeof scoped>[1]) => scoped(name, self, 30_000)

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
    const said = yield* spawner.string(ChildProcess.make("git", ["-C", scratchInput(repo), ...args], { env: IDENTITY, extendEnv: true, stdin: "ignore", forceKillAfter: "1 second" }))
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

/** What a merge fixture adds: files the upstream commit writes, and the list's declared skips. */
interface Fixture {
  readonly incoming?: ReadonlyArray<readonly [string, string]>
  readonly skips?: ReadonlyArray<Skip>
  readonly expectations?: List["expectations"]
}

describe("the daily's merge check step (mergeChecks) with the real feature step", () => {
  const FEATURES = "fork feature checks (scripts/fork-checks.ts)"

  /** A fake fork (origin and upstream bare, the fork cloned with prime-look), a package of real tests, upstream one commit ahead. */
  const fixture = (command: readonly [string, ...Array<string>], files: readonly [string, ...Array<string>], more: Fixture = {}) =>
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
      // The upstream commit the merge brings, with any test file it changes (a listed test it turns skipped).
      yield* writeAll(seed, Option.getOrElse(Option.fromUndefinedOr(more.incoming), () => []))
      yield* commit(seed, "upstream.txt", "upstream change")
      yield* git(seed, "push", "--quiet", upstream, "dev")
      const fork = path.join(root, "fork")
      yield* Effect.sync(() => gitClone(origin, fork, ["--quiet", "--branch", "prime-look"], GIT_ENV))
      yield* git(fork, "remote", "add", "upstream", upstream)
      const listFile = path.join(root, "list.json")
      const listed: List = {
        about: "test",
        packages: { "packages/x": command },
        features: [{ id: "x", feature: "the fork feature", package: "packages/x", files, proved: "here" }],
        expectations: Option.getOrElse(Option.fromUndefinedOr(more.expectations), () => []),
        skips: Option.getOrElse(Option.fromUndefinedOr(more.skips), () => []),
      }
      yield* fs.writeFileString(listFile, encodeListText(listed))
      const passed = (): Effect.Effect<StepRun> => Effect.succeed({ code: 0, log: "" })
      const said = yield* Ref.make("")
      const real = featureStep(ROOT, ["--list", listFile, "--max-load", "1000", "--lock", path.join(root, "fork-checks.flock")])
      // The daily's own check step: fakes for the install, `bun run check` and the acceptance links (each needs a real
      // fork), the real feature step, the CLI over the merge, with a test list and lock.
      const checks = mergeChecks({
        install: passed,
        check: passed,
        // The real step, its output kept so a test reads the summary of a green run (which writes no report).
        features: (dir) => Effect.tap(real(dir), (ran) => Ref.set(said, ran.log)),
        accept: () => Effect.succeed({ ok: true }),
      })
      const report = path.join(root, "state/upstream-conflict.md")
      const merge = Effect.promise(() =>
        mergeUpstream({ fork, host: "Cristians-MacBook-Pro.local", skip: false, dryRun: false, checks, landing: unlocked, worktree: path.join(root, "state/upstream-merge"), report, log: () => {}, env: GIT_ENV }),
      )
      const head = (repo: string) => git(repo, "rev-parse", "prime-look")
      return { fork, origin, report, merge, before: yield* head(origin), head, said: Ref.get(said) }
    })

  /** Whether the merge held: red, origin's ref where it was, and the report written; the report's text. */
  const held = (f: Effect.Success<ReturnType<typeof fixture>>) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      expect(yield* f.merge).toMatchObject({ kind: "red", check: FEATURES })
      expect(yield* f.head(f.origin)).toBe(f.before)
      return yield* fs.readFileString(scratchInput(f.report))
    })

  const SKIPPED_ONLY = 'import { expect, test } from "bun:test"\ntest.skip("the fork feature", () => expect(1).toBe(1))\n'
  const PARTIAL = 'import { expect, test } from "bun:test"\ntest("passes", () => expect(1).toBe(1))\ntest.skip("the fork feature", () => expect(1).toBe(1))\n'
  const BOTH_RUN = 'import { expect, test } from "bun:test"\ntest("passes", () => expect(1).toBe(1))\ntest("the fork feature", () => expect(1).toBe(1))\n'
  const DECLARED: ReadonlyArray<Skip> = [{ package: "packages/x", file: "test/green.test.ts", test: "the fork feature", reason: "the probe needs a real terminal" }]

  // Each case is a real merge and a CLI run: about a second on a quiet host, several under load, so 30 s each.
  const live = it.live.layer(BunServices.layer)
  const test = <A, E>(name: string, self: () => Effect.Effect<A, E, BunServices.BunServices>, timeout = 30_000) => live(name, self, timeout)

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
        const text = yield* fs.readFileString(scratchInput(f.report))
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
      expect(yield* fs.readFileString(scratchInput(f.report))).toContain("packages/x/test/gone.test.ts [x]: the listed file is not in the fork")
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
      expect(yield* fs.readFileString(scratchInput(f.report))).toContain("fork-checks: COULD NOT RUN")
      expect(yield* fs.exists(path.join(f.fork, "upstream.txt"))).toBe(false)
    }).pipe(Effect.scoped),
  )

  // Skips, through bun's own JUnit reporter: the merge brings an upstream commit that changes the listed test.
  test("a listed file the merge turns skipped-only holds the push and writes the report: it ran no test", () =>
    Effect.gen(function* () {
      const f = yield* fixture(["bun", "test"], ["test/green.test.ts"], { incoming: [["packages/x/test/green.test.ts", SKIPPED_ONLY]] })
      const text = yield* held(f)
      expect(text).toContain("packages/x/test/green.test.ts [x]: the file ran no test: its 1 cases were all skipped or todo")
      expect(text).toContain("fork-checks: ran packages/x/test/green.test.ts: 0 executed (0 failed), 1 skipped, 0 todo")
    }).pipe(Effect.scoped),
  )

  test("an undeclared skip beside a running test holds the push", () =>
    Effect.gen(function* () {
      const f = yield* fixture(["bun", "test"], ["test/green.test.ts"], { incoming: [["packages/x/test/green.test.ts", PARTIAL]] })
      expect(yield* held(f)).toContain("packages/x/test/green.test.ts > the fork feature [x]: skipped, and fork-checks.json declares no skip for it")
    }).pipe(Effect.scoped),
  )

  test("a declared skip goes to origin, named in the summary", () =>
    Effect.gen(function* () {
      const f = yield* fixture(["bun", "test"], ["test/green.test.ts"], { incoming: [["packages/x/test/green.test.ts", PARTIAL]], skips: DECLARED })
      expect(yield* f.merge).toMatchObject({ kind: "merged" })
      expect(yield* f.head(f.origin)).not.toBe(f.before)
      const said = yield* f.said
      expect(said).toContain("skipped as declared: packages/x/test/green.test.ts > the fork feature; why: the probe needs a real terminal")
      expect(said).toContain("fork-checks: green over upstream")
      expect(said).toMatch(/1 features; 1 skipped as declared: packages\/x\/test\/green\.test\.ts > the fork feature$/m)
    }).pipe(Effect.scoped),
  )

  test("a declared skip that ran (a stale declaration) holds the push", () =>
    Effect.gen(function* () {
      const f = yield* fixture(["bun", "test"], ["test/green.test.ts"], { incoming: [["packages/x/test/green.test.ts", BOTH_RUN]], skips: DECLARED })
      expect(yield* held(f)).toContain("packages/x/test/green.test.ts > the fork feature [x]: declared skipped but it ran: remove the skip")
    }).pipe(Effect.scoped),
  )

  test("a runner that exits 0 and writes no JUnit report holds the push", () =>
    Effect.gen(function* () {
      const f = yield* fixture(["true"], ["test/green.test.ts"])
      expect(yield* held(f)).toContain("packages/x/test/green.test.ts [x]: the runner exited 0 and wrote no report: the file is not proven to have run")
    }).pipe(Effect.scoped),
  )

  // Batch 23b's counterexample, its files verbatim: one test passes, one is skipped as declared, then the package's
  // post-test step fails (exit 7). The skip explains nothing about that exit.
  const VERIFIER_RUNNER = [
    "// Package runner: its post-test step fails, rather than a test case failing.",
    'const tests = Bun.spawnSync(["bun", "test", ...process.argv.slice(2)], {',
    '  stdout: "inherit",',
    '  stderr: "inherit",',
    "});",
    "if (tests.exitCode !== 0) process.exit(tests.exitCode);",
    'console.error("fixture: post-test report check failed");',
    "process.exit(7);",
    "",
  ].join("\n")
  const VERIFIER_PASSING = ['import { test, expect } from "bun:test";', "", 'test("feature executes", () => expect(1).toBe(1));', 'test.skip("intentionally skipped");', ""].join("\n")

  test("a declared skip beside a package command that exits 7 (batch 23b's fixture, verbatim) holds the push and reports the command, its exit and its tail", () =>
    Effect.gen(function* () {
      const skips: ReadonlyArray<Skip> = [{ package: "packages/x", file: "test/green.test.ts", test: "intentionally skipped", reason: "fixture: deliberate skip" }]
      const incoming: ReadonlyArray<readonly [string, string]> = [
        ["packages/x/runner.ts", VERIFIER_RUNNER],
        ["packages/x/test/green.test.ts", VERIFIER_PASSING],
      ]
      const f = yield* fixture(["bun", "runner.ts"], ["test/green.test.ts"], { incoming, skips })
      const text = yield* held(f)
      expect(text).toContain("fork-checks: ran packages/x/test/green.test.ts: 1 executed (0 failed), 1 skipped, 0 todo")
      expect(text).toContain("RED packages/x/(the run) [x]: bun runner.ts exited 7, and no failed test in its report accounts for it (a failed test exits 1; a skip accounts for no exit)")
      expect(text).toContain("fixture: post-test report check failed")
      expect(text).toMatch(/fork-checks: RED over upstream [0-9a-f]{10}\.\.[0-9a-f]{10}, 1 tests: packages\/x\/\(the run\) \[x\]/)
    }).pipe(Effect.scoped),
    30_000,
  )

  /** A package command that copies its cell's report (if the merge holds one) to bun's report file and exits its cell's code. */
  const CELL_RUNNER = [
    'const out = process.argv.find((arg) => arg.startsWith("--reporter-outfile="))',
    'const report = Bun.file(import.meta.dir + "/report.xml")',
    'if (out !== undefined && (await report.exists())) await Bun.write(out.slice("--reporter-outfile=".length), report)',
    'console.log("fixture: post-test step exited " + process.argv[2])',
    "process.exit(Number(process.argv[2]))",
    "",
  ].join("\n")

  /** One cell through the daily's merge: what the merge answered, whether origin moved, and the report it left. */
  const throughMerge = (cell: Cell, bash: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const incoming = [["packages/x/runner.ts", CELL_RUNNER] as const, ...Option.toArray(Option.map(cellReport(cell), (text) => ["packages/x/report.xml", text] as const))]
      const f = yield* fixture(["bun", "runner.ts", String(cell.exit)], [CELL_FILE], { incoming, ...cellDeclarations(cell, bash) })
      const merged = yield* f.merge
      const moved = (yield* f.head(f.origin)) !== f.before
      const report = yield* fs.readFileString(scratchInput(f.report)).pipe(Effect.orElseSucceed(() => ""))
      return { cell, merged: merged.kind, moved, report }
    }).pipe(Effect.scoped)

  /**
   * The cells each round runs at this boundary (a real merge and CLI each, about a CPU-second): every green cell,
   * each exit beside a declared skip and beside an observed expected failure, each other skip and the passing
   * expectation, and each report kind. `FORK_CHECKS_EVERY_CELL=1` runs all of `CELLS` here instead, four at a time (run it alone).
   */
  const atBoundary = (cell: Cell) => {
    if (cell.report !== "present") return cell.skip === "declared" && cell.expectation === "observed"
    if (cell.skip === "none" || cell.skip === "declared") return cell.expectation !== "passing" || (cell.skip === "declared" && cell.exit !== 7)
    return cell.expectation === "none" && cell.exit !== 1
  }

  it.live.layer(Layer.provideMerge(hostGauge, BunServices.layer))(
    "the compositions at the bare-ref boundary: only the table's green cells reach origin; every other is held with its report",
    () =>
      Effect.gen(function* () {
        // The expectation holds on this host's bash, as the CLI reads it.
        const bash = Option.getOrElse(yield* (yield* HostGauge).bash, () => "none")
        const every = yield* Config.Boolean("FORK_CHECKS_EVERY_CELL").pipe(Config.withDefault(false))
        const cells = CELLS.filter((cell) => every || atBoundary(cell))
        expect(cells.length).toBe(Number(every) * CELLS.length + Number(!every) * 24)
        // Two at a time in a round, beside the other test files; four for the whole table, run alone.
        const outcomes = yield* Effect.forEach(cells, (cell) => throughMerge(cell, bash), { concurrency: 2 + 2 * Number(every) })
        const seen = outcomes.map((each) => {
          const kind = Arr.filter(["could-not-run"], () => each.report.includes("fork-checks: COULD NOT RUN")).concat(Arr.filter(["red"], () => each.report.includes("fork-checks: RED")))
          return `${nameOf(each.cell)}: ${Option.getOrElse(Arr.head(kind), () => "green")}, ${each.merged}, origin ${Option.getOrElse(Arr.head(Arr.filter(["moved"], () => each.moved)), () => "kept")}`
        })
        expect(seen).toEqual(
          cells.map((cell) => {
            const outcome = outcomeOf(cell)
            if (outcome === "green") return `${nameOf(cell)}: green, merged, origin moved`
            return `${nameOf(cell)}: ${outcome}, red, origin kept`
          }),
        )
        for (const each of outcomes.filter((one) => unexplainedExit(one.cell)))
          expect(each.report).toContain(`RED packages/x/(the run) [x]: bun runner.ts ${each.cell.exit} exited ${each.cell.exit}, and no failed test in its report accounts for it`)
        for (const each of outcomes.filter((one) => outcomeOf(one.cell) !== "green")) expect(each.report).toContain(`fixture: post-test step exited ${each.cell.exit}`)
      }),
    300_000,
  )
})

describe("a run stopped before it finishes could not run, with a partial report", () => {
  /** A one-package fork whose command sleeps past any bound, its list, and the CLI's argv over it. */
  const sleeper = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "fork-checks-stop-" }))
    yield* writeAll(dir, [
      ["fork/packages/x/test/green.test.ts", 'import { expect, test } from "bun:test"\ntest("passes", () => expect(1).toBe(1))\n'],
      ["fork/packages/x/sleep.ts", "await Bun.sleep(120_000)\n"],
    ])
    const listed: List = {
      about: "test",
      packages: { "packages/x": ["bun", "sleep.ts"] },
      features: [{ id: "x", feature: "the fork feature", package: "packages/x", files: ["test/green.test.ts"], proved: "here" }],
      expectations: [],
    }
    yield* fs.writeFileString(path.join(dir, "list.json"), encodeListText(listed))
    const argv = [path.join(ROOT, "scripts/fork-checks.ts"), "--fork", path.join(dir, "fork"), "--list", path.join(dir, "list.json"), "--max-load", "1000", "--lock", path.join(dir, "lock")]
    return { dir, argv }
  })

  const test = it.live.layer(BunServices.layer)

  test("a SIGTERM mid-run (the caller's own bound) prints what was running and for how long, and exits 2", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const { argv } = yield* sleeper
      const handle = yield* spawner.spawn(ChildProcess.make("bun", argv, { stdin: "ignore", forceKillAfter: "3 seconds" }))
      const said = yield* Ref.make("")
      const sent = yield* Ref.make(false)
      // Reads the output as it comes; sends the signal once, when the package's run has started.
      const signal = Effect.andThen(Ref.set(sent, true), handle.kill({ killSignal: "SIGTERM" }))
      const reading = handle.all.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            const all = yield* Ref.updateAndGet(said, (text) => text + chunk)
            const started = all.includes("fork-checks: packages/x: 1 files") && !(yield* Ref.get(sent))
            yield* Effect.when(signal, Effect.succeed(started))
          }),
        ),
      )
      const [, code] = yield* Effect.all([reading, handle.exitCode], { concurrency: 2 })
      const text = yield* Ref.get(said)
      expect(Number(code)).toBe(2)
      expect(text).toMatch(/fork-checks: COULD NOT RUN: stopped by a signal \(the caller's own bound, or a kill\) before it finished, after \d+\.\d s; progress: packages\/x \[x\]: running for \d+\.\d s$/m)
      expect(text).toMatch(/^budgets: lock wait \d+\.\d s of 30 min; calm-host wait \d+\.\d s of 30 min; package runs \d+\.\d s of 40 min$/m)
    }).pipe(Effect.scoped),
    30_000,
  )

  test("the run's own time bound: could not run, the package's progress named", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const { argv } = yield* sleeper
      const handle = yield* spawner.spawn(ChildProcess.make("bun", [...argv, "--time-bound-ms", "1500"], { stdin: "ignore", forceKillAfter: "3 seconds" }))
      const [text, code] = yield* Effect.all([handle.all.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode], { concurrency: 2 })
      expect(Number(code)).toBe(2)
      expect(text).toMatch(/^progress: packages\/x \[x\]: could-not-run in \d+\.\d s$/m)
      expect(text).toContain("fork-checks: COULD NOT RUN: packages/x ran past the package runs' budget (0.025 min), its process group ended")
      expect(text).toMatch(/^budgets: lock wait \d+\.\d s of 30 min; calm-host wait \d+\.\d s of 30 min; package runs \d+\.\d s of 0\.025 min$/m)
    }).pipe(Effect.scoped),
    30_000,
  )
})
