// `bun scripts/fork-checks.ts --fork <checkout>`: the fork's feature checks, the tests that hold each fork
// feature the owner keeps, declared once in scripts/fork-checks.json (package, test files, the request that
// last proved it). `bun run daily`'s upstream merge runs it on the merged tree before it pushes
// (scripts/upstream.ts `forkChecks`), and a fork lane's round gate runs it on the lane; nothing else on the
// fork's own branch runs the fork's package tests (its CI runs on dev, beta and PRs only).
//
// One `bun test` per package, one at a time, niced, `--parallel=4`, in the package's own command (core's
// `script/test.ts`), its JUnit report read per test. A listed file that is not there, a failed test, a file
// that ran no test (an import that no longer resolves) and a run that exits red with no failed test are red;
// a red file is run once more, and a file green on that rerun is a named flake. An expectation declares one
// test red on a host by a condition read at run time (the version of the first bash on PATH) with its reason:
// the test still runs, its failure there is a note, and its passing there (or its absence) is red, so a stale
// expectation cannot stay. It waits while the 1-minute load is over 24 and for the host's fork-checks lock (at
// most 30 minutes each), refuses to start under 6 GiB free on the Mac, and stops at its time bound: each is
// "could not run", which holds a merge as a red does.
//
// Exit: 0 green, 1 red, 2 could not run or a list that does not parse. The last line is the summary.
//
// Usage: bun scripts/fork-checks.ts [--fork <checkout>] [--list <file>] [--time-bound-ms N] [--max-load N] [--lock <file>]
//        (--fork defaults to OPENCODE_DEV; --list, --max-load and --lock are for tests)
import { existsSync, mkdtempSync, readFileSync, rmSync, statfsSync } from "node:fs"
import { loadavg, tmpdir } from "node:os"
import { join } from "node:path"
import { Array as Arr, Duration, Effect, Match, Option, Result, Schema } from "effect"
import { holdingIfFree } from "../mods/work/process/flock.ts"
import declared from "./fork-checks.json" with { type: "json" }

const Feature = Schema.Struct({
  id: Schema.String,
  feature: Schema.String,
  package: Schema.String,
  files: Schema.NonEmptyArray(Schema.String),
  proved: Schema.String,
})
const Expectation = Schema.Struct({
  package: Schema.String,
  file: Schema.String,
  test: Schema.String,
  host: Schema.Struct({ bash: Schema.String }),
  reason: Schema.String,
})
const List = Schema.Struct({
  about: Schema.String,
  packages: Schema.Record(Schema.String, Schema.NonEmptyArray(Schema.String)),
  features: Schema.NonEmptyArray(Feature),
  expectations: Schema.Array(Expectation),
})
export type List = typeof List.Type
export type Expectation = typeof Expectation.Type

/** Decodes a list already read as data. */
export const decodeList = Schema.decodeUnknownResult(List)
/** Decodes a list file's text. */
export const decodeListText = Schema.decodeUnknownResult(Schema.fromJsonString(List))
/** scripts/fork-checks.json, decoded. */
export const declaredList = decodeList(declared)

/** What the schema cannot say: each feature's package has a command, ids are unique, each expectation names a listed file. */
export const listProblems = (list: List): ReadonlyArray<string> => {
  const listed = new Set(list.features.flatMap((feature) => feature.files.map((file) => `${feature.package}/${file}`)))
  const ids = list.features.map((feature) => feature.id)
  return [
    ...list.features.filter((feature) => !Object.hasOwn(list.packages, feature.package)).map((feature) => `${feature.id}: package ${feature.package} has no command`),
    ...ids.filter((id, at) => ids.indexOf(id) !== at).map((id) => `${id}: the id is listed twice`),
    ...list.expectations.filter((each) => !listed.has(`${each.package}/${each.file}`)).map((each) => `expectation "${each.test}": ${each.package}/${each.file} is in no feature`),
  ]
}

/** One test that holds a merge: where it is, its full name (describe blocks joined by " > ") and why. */
export interface Red {
  readonly package: string
  readonly file: string
  readonly test: string
  readonly why: string
}

export type Verdict =
  | { readonly kind: "green"; readonly notes: ReadonlyArray<string> }
  | { readonly kind: "red"; readonly reds: ReadonlyArray<Red>; readonly notes: ReadonlyArray<string> }
  | { readonly kind: "could-not-run"; readonly reason: string; readonly notes: ReadonlyArray<string> }

/** Each listed file that is not in the checkout `fork`, as a red. */
export const missingFiles = (list: List, fork: string): ReadonlyArray<Red> =>
  Arr.dedupeWith(
    list.features.flatMap((feature) =>
      feature.files.filter((file) => !existsSync(join(fork, feature.package, file))).map((file) => ({ package: feature.package, file, test: "", why: "the listed file is not in the fork" })),
    ),
    (one, two) => one.package === two.package && one.file === two.file,
  )

/** One test in a JUnit report: its file (relative to the package), its full name, and whether it failed. */
export interface Case {
  readonly file: string
  readonly test: string
  readonly failed: boolean
}

const ENTITIES = new Map([
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
  ["&apos;", "'"],
  ["&amp;", "&"],
])
const unescape = (text: string) => text.replace(/&(?:lt|gt|quot|apos|amp);|&#(\d+);/g, (entity, code: string) => Option.getOrElse(Option.fromNullishOr(ENTITIES.get(entity)), () => String.fromCharCode(Number(code))))
const attribute = (tag: string, name: string): string => Option.getOrElse(Option.map(Option.fromNullishOr(new RegExp(`\\b${name}="([^"]*)"`).exec(tag)), (match) => unescape(String(match[1]))), () => "")
const relative = (file: string) => file.replace(/^\.\//, "")

/** The tests in bun's JUnit report, each with the names of the describe blocks around it (the file's own suite left out). */
export const casesOf = (junit: string): ReadonlyArray<Case> => {
  const cases: Array<Case> = []
  const suites: Array<string> = []
  let open = Option.none<{ readonly file: string; readonly test: string; failed: boolean }>()
  for (const match of junit.matchAll(/<testsuite\b[^>]*?(\/?)>|<\/testsuite>|<testcase\b[^>]*?(\/?)>|<\/testcase>|<failure\b|<error\b/g)) {
    const tag = match[0]
    if (tag.startsWith("<testsuite") && match[1] !== "/") suites.push(attribute(tag, "name"))
    if (tag === "</testsuite>") suites.pop()
    if (tag.startsWith("<testcase")) {
      const found = { file: relative(attribute(tag, "file")), test: [...suites.slice(1), attribute(tag, "name")].join(" > "), failed: false }
      if (match[2] === "/") cases.push(found)
      else open = Option.some(found)
    }
    if (tag === "<failure" || tag === "<error") Option.map(open, (current) => (current.failed = true))
    if (tag === "</testcase>") {
      Option.map(open, (current) => cases.push({ ...current }))
      open = Option.none()
    }
  }
  return cases
}

/** One package's run: its package, the files it runs, and its expectations that hold on this host. */
export interface Plan {
  readonly package: string
  readonly files: ReadonlyArray<string>
  readonly expected: ReadonlyArray<Expectation>
}

/** The expectations whose host condition holds here: the first bash on PATH is the declared version. */
export const activeExpectations = (list: List, bash: Option.Option<string>): ReadonlyArray<Expectation> =>
  list.expectations.filter((each) => Option.exists(bash, (version) => version === each.host.bash))

/** Judges one run of `plan` by its exit and its report's tests: the reds, and a note per expectation that held. */
export interface Judged {
  readonly reds: ReadonlyArray<Red>
  readonly notes: ReadonlyArray<string>
}

export const judge = (plan: Plan, code: number, cases: ReadonlyArray<Case>): Judged => {
  const expected = plan.expected.filter((each) => each.package === plan.package && plan.files.includes(each.file))
  const isExpected = (found: Case) => expected.some((each) => each.file === found.file && each.test === found.test)
  const seen = new Set(cases.map((found) => found.file))
  const red = (file: string, test: string, why: string): Red => ({ package: plan.package, file, test, why })
  const silent = plan.files.flatMap((file) => Arr.filter([red(file, "", "the file ran no test (it did not load, or holds none)")], () => !seen.has(file)))
  const failed = cases.flatMap((found) => Arr.filter([red(found.file, found.test, "failed")], () => found.failed && !isExpected(found)))
  const stale = expected.flatMap((each) => {
    const ran = cases.filter((found) => found.file === each.file && found.test === each.test)
    if (ran.length === 0) return [red(each.file, each.test, `declared red on bash ${each.host.bash} but it did not run: the expectation names a test that is gone`)]
    if (ran.some((found) => !found.failed)) return [red(each.file, each.test, `declared red on bash ${each.host.bash} but it passed: remove the expectation`)]
    return []
  })
  const notes = expected.flatMap((each) =>
    Arr.filter([`expected red on bash ${each.host.bash}: ${plan.package}/${each.file} > ${each.test} (${each.reason})`], () =>
      cases.some((found) => found.failed && found.file === each.file && found.test === each.test),
    ),
  )
  const reds = [...silent, ...failed, ...stale]
  const unexplained = code !== 0 && reds.length === 0 && notes.length === 0
  return { reds: [...reds, ...Arr.filter([red("(the run)", "", `bun test exited ${code} with no failed test`)], () => unexplained)], notes }
}

/** One run's request to a runner: the package's command, the files, the width and the time it has. */
export interface Run {
  readonly cwd: string
  readonly command: ReadonlyArray<string>
  readonly files: ReadonlyArray<string>
  readonly threads: number
  readonly timeoutMs: number
}
export type Ran = { readonly kind: "exited"; readonly code: number; readonly log: string; readonly junit: Option.Option<string> } | { readonly kind: "timed-out"; readonly log: string }
export type Runner = (run: Run) => Effect.Effect<Ran>

/** What the checks read of the host. */
export interface Host {
  /** The version of the first bash on PATH (`$BASH_VERSION` up to its "("), none without one. */
  readonly bash: Option.Option<string>
  /** Whether the disk floor applies (the Mac). */
  readonly floored: boolean
  readonly load: () => number
  readonly freeBytes: (dir: string) => number
  readonly now: () => number
  readonly sleep: (ms: number) => Effect.Effect<void>
}

export interface Limits {
  readonly maxLoad: number
  /** How long it waits for a calm host, and for the lock, before it could not run. */
  readonly waitMs: number
  readonly everyMs: number
  readonly timeBoundMs: number
  readonly diskFloor: number
  readonly threads: number
}

export const LIMITS: Limits = { maxLoad: 24, waitMs: 30 * 60_000, everyMs: 15_000, timeBoundMs: 40 * 60_000, diskFloor: 6 * 2 ** 30, threads: 4 }

export interface Input {
  readonly list: List
  readonly fork: string
  readonly host: Host
  readonly runner: Runner
  /** Runs the effect holding the host's fork-checks lock, or answers none at once while another run holds it. */
  readonly lock: (run: Effect.Effect<Verdict>) => Effect.Effect<Option.Option<Verdict>>
  readonly limits: Limits
  readonly say: (line: string) => void
}

/** The runs: one per package, its files in list order, each once. */
export const plansOf = (list: List, bash: Option.Option<string>): ReadonlyArray<Plan> =>
  Arr.dedupe(list.features.map((feature) => feature.package)).map((pkg) => ({
    package: pkg,
    files: Arr.dedupe(list.features.filter((feature) => feature.package === pkg).flatMap((feature) => feature.files)),
    expected: activeExpectations(list, bash).filter((each) => each.package === pkg),
  }))

const couldNot = (reason: string, notes: ReadonlyArray<string> = []): Verdict => ({ kind: "could-not-run", reason, notes })
const tail = (text: string, lines = 30) => text.trimEnd().split("\n").slice(-lines).join("\n")

/** Polls `ready` until it answers some, at most `limits.waitMs`. */
const patiently = Effect.fn("ForkChecks.patiently")(function* (input: Input, ready: Effect.Effect<Option.Option<Verdict>>) {
  const start = input.host.now()
  for (;;) {
    const got = yield* ready
    if (Option.isSome(got) || input.host.now() - start >= input.limits.waitMs) return got
    yield* input.host.sleep(input.limits.everyMs)
  }
})

/** Waits for the load to drop to `limits.maxLoad`; answers whether it did. */
const calm = Effect.fn("ForkChecks.calm")(function* (input: Input) {
  const ready = Effect.sync(() => Option.map(Option.liftPredicate(input.host.load(), (load) => load <= input.limits.maxLoad), (): Verdict => ({ kind: "green", notes: [] })))
  return Option.isSome(yield* patiently(input, ready))
})

/** One run of `plan`, judged; could not run when the host stays loaded, the time bound passes or bun writes no report. */
const runOnce = Effect.fn("ForkChecks.runOnce")(function* (input: Input, plan: Plan, deadline: number) {
  if (!(yield* calm(input))) return couldNot(`the 1-minute load stayed over ${input.limits.maxLoad} for ${Math.round(input.limits.waitMs / 60_000)} min before ${plan.package} ran`)
  const left = deadline - input.host.now()
  if (left <= 0) return couldNot(`the time bound (${Math.round(input.limits.timeBoundMs / 60_000)} min) passed before ${plan.package} ran`)
  input.say(`fork-checks: ${plan.package}: ${plan.files.length} files`)
  const command = Option.getOrElse(Option.fromNullishOr(input.list.packages[plan.package]), () => ["bun", "test"])
  const ran = yield* input.runner({ cwd: join(input.fork, plan.package), command, files: plan.files, threads: input.limits.threads, timeoutMs: left })
  return Match.value(ran).pipe(
    Match.when({ kind: "timed-out" }, (out): Verdict => couldNot(`${plan.package} ran past the time bound (${Math.round(input.limits.timeBoundMs / 60_000)} min), its process group killed:\n${tail(out.log)}`)),
    Match.when({ kind: "exited" }, (out): Verdict =>
      Option.match(out.junit, {
        onNone: () => couldNot(`bun test in ${plan.package} exited ${out.code} and wrote no report:\n${tail(out.log)}`),
        onSome: (junit) => {
          const judged = judge(plan, out.code, casesOf(junit))
          if (judged.reds.length === 0) return { kind: "green", notes: judged.notes }
          return { kind: "red", reds: judged.reds, notes: [...judged.notes, `${plan.package} log:\n${tail(out.log)}`] }
        },
      }),
    ),
    Match.exhaustive,
  )
})

/** `plan`'s run, and once more for its red files: a file green on the rerun is a named flake, a file red twice stays red. */
const runPlan = Effect.fn("ForkChecks.runPlan")(function* (input: Input, plan: Plan, deadline: number) {
  const first = yield* runOnce(input, plan, deadline)
  if (first.kind !== "red") return first
  const whole = first.reds.some((red) => red.file === "(the run)")
  const files = Arr.filter(plan.files, (file) => whole || first.reds.some((red) => red.file === file))
  input.say(`fork-checks: ${plan.package}: ${files.length} red files; running them once more`)
  const second = yield* runOnce(input, { ...plan, files }, deadline)
  if (second.kind !== "green") return second
  return { kind: "green", notes: [...second.notes, `flaky, green on the rerun: ${files.map((file) => `${plan.package}/${file}`).join(", ")}`] } satisfies Verdict
})

/** Every plan in turn under the lock: stops at the first that could not run, else gathers the reds and notes. */
const runAll = Effect.fn("ForkChecks.runAll")(function* (input: Input, deadline: number) {
  const reds: Array<Red> = []
  const notes: Array<string> = []
  for (const plan of plansOf(input.list, input.host.bash)) {
    const verdict = yield* runPlan(input, plan, deadline)
    notes.push(...verdict.notes)
    if (verdict.kind === "could-not-run") return couldNot(verdict.reason, notes)
    if (verdict.kind === "red") reds.push(...verdict.reds)
  }
  if (reds.length > 0) return { kind: "red", reds, notes } satisfies Verdict
  return { kind: "green", notes } satisfies Verdict
})

/** The checks over the checkout `fork`: missing files first, then the disk floor, the lock, and each package's run. */
export const checkFork = Effect.fn("ForkChecks.check")(function* (input: Input) {
  const missing = missingFiles(input.list, input.fork)
  if (missing.length > 0) return { kind: "red", reds: missing, notes: [] } satisfies Verdict
  const free = input.host.freeBytes(input.fork)
  if (input.host.floored && free < input.limits.diskFloor)
    return couldNot(`${(free / 2 ** 30).toFixed(1)} GiB free on ${input.fork}'s disk, under the ${(input.limits.diskFloor / 2 ** 30).toFixed(0)} GiB floor`)
  const deadline = input.host.now() + input.limits.timeBoundMs
  const verdict = yield* patiently(input, input.lock(runAll(input, deadline)))
  return Option.getOrElse(verdict, () => couldNot(`another fork-checks run held the host's lock for ${Math.round(input.limits.waitMs / 60_000)} min`))
})

/** The features that list `red`'s file. */
const featuresOf = (list: List, red: Red) => list.features.filter((feature) => feature.package === red.package && feature.files.includes(red.file)).map((feature) => feature.id)

/** The report's lines; the last is the summary, naming each red test, its features and the upstream range when the head is a merge. */
export const reportLines = (list: List, verdict: Verdict, range: Option.Option<string>): ReadonlyArray<string> => {
  const over = Option.getOrElse(Option.map(range, (each) => ` over merge ${each}`), () => "")
  const name = (red: Red) => [`${red.package}/${red.file}`, ...Arr.filter([red.test], (test) => test !== "")].join(" > ")
  return Match.value(verdict).pipe(
    Match.when({ kind: "green" }, (green) => [...green.notes, `fork-checks: green${over}, ${list.features.length} features`]),
    Match.when({ kind: "red" }, (red) => [
      ...red.notes,
      ...red.reds.map((each) => `RED ${name(each)} [${featuresOf(list, each).join(", ")}]: ${each.why}`),
      `fork-checks: RED${over}, ${red.reds.length} tests: ${red.reds.map((each) => `${name(each)} [${featuresOf(list, each).join(", ")}]`).join("; ")}`,
    ]),
    Match.when({ kind: "could-not-run" }, (out) => [...out.notes, `fork-checks: COULD NOT RUN${over}: ${out.reason}`]),
    Match.exhaustive,
  )
}

/** The exit a verdict makes: 0 green, 1 red, 2 could not run. */
export const exitOf = (verdict: Verdict): number =>
  Match.value(verdict.kind).pipe(
    Match.when("green", () => 0),
    Match.when("red", () => 1),
    Match.orElse(() => 2),
  )

/** The command a caller runs the checks with: the dotfiles' `opencode` dir, the checkout, and any flags (a test's `--list`). */
export const featureCheckArgv = (opencode: string, fork: string, flags: ReadonlyArray<string> = []): ReadonlyArray<string> => ["bun", join(opencode, "scripts/fork-checks.ts"), "--fork", fork, ...flags]

/** `HEAD^1..HEAD^2` of a merge at the checkout's head, short; none when the head is not a merge. */
export const rangeOf = (fork: string): Option.Option<string> => {
  const ran = Bun.spawnSync(["git", "-C", fork, "rev-parse", "HEAD^1", "HEAD^2"], { stdout: "pipe", stderr: "pipe" })
  const shas = ran.stdout
    .toString()
    .trim()
    .split("\n")
    .map((sha) => sha.slice(0, 10))
  return Option.map(Option.liftPredicate(shas, (each) => ran.exitCode === 0 && each.length === 2), (each) => each.join(".."))
}

/** The version of the first bash on `path`, up to its "(": "3.2.57" for macOS's /bin/bash. */
export const bashVersion = (path: string): Option.Option<string> =>
  Option.flatMap(Option.fromNullishOr(Bun.which("bash", { PATH: path })), (bash) => {
    const ran = Bun.spawnSync([bash, "--noprofile", "--norc", "-c", 'printf %s "$BASH_VERSION"'], { stdout: "pipe", stderr: "pipe" })
    return Option.filter(Arr.head(ran.stdout.toString().split("(")), (version) => ran.exitCode === 0 && version !== "")
  })

export const realHost = (path: string): Host => ({
  bash: bashVersion(path),
  floored: process.platform === "darwin",
  load: () => Option.getOrElse(Arr.head(loadavg()), () => 0),
  freeBytes: (dir) => {
    const stat = statfsSync(dir)
    return stat.bavail * stat.bsize
  },
  now: () => Date.now(),
  sleep: (ms) => Effect.sleep(Duration.millis(ms)),
})

/** Signals the process group `pid` leads (the run's own, started detached); false once it is gone. */
const signalGroup = (pid: number, signal: NodeJS.Signals | 0) => Result.isSuccess(Result.try(() => process.kill(-pid, signal)))

/** Ends the run's process group: TERM, then KILL after 3 s for whatever is left. */
const endGroup = Effect.fn("ForkChecks.endGroup")(function* (pid: number) {
  if (!signalGroup(pid, "SIGTERM")) return
  yield* Effect.sleep(Duration.seconds(3))
  signalGroup(pid, "SIGKILL")
})

/** `bun test` niced in its own process group, its JUnit report in a scratch folder, the group ended when it exits or times out. */
export const bunRunner =
  (env: NodeJS.ProcessEnv): Runner =>
  (run) =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "fork-checks-"))
      const report = join(dir, "junit.xml")
      const argv = ["nice", "-n", "10", ...run.command, `--parallel=${run.threads}`, "--reporter=junit", `--reporter-outfile=${report}`, ...run.files]
      const child = Bun.spawn(argv, { cwd: run.cwd, env, stdout: "pipe", stderr: "pipe", detached: true })
      const stdout = new Response(child.stdout).text()
      const stderr = new Response(child.stderr).text()
      const exited = yield* Effect.timeoutOption(
        Effect.promise(() => child.exited),
        Duration.millis(run.timeoutMs),
      )
      yield* endGroup(child.pid)
      const log = `${yield* Effect.promise(() => stdout)}\n${yield* Effect.promise(() => stderr)}`
      const junit = Option.map(Option.liftPredicate(report, existsSync), (file) => readFileSync(file, "utf8"))
      rmSync(dir, { recursive: true, force: true })
      return Option.match(exited, {
        onNone: (): Ran => ({ kind: "timed-out", log }),
        onSome: (code): Ran => ({ kind: "exited", code, log, junit }),
      })
    })

/** The argument after `name`, when `name` is there. */
const flag = (argv: ReadonlyArray<string>, name: string): Option.Option<string> => Option.flatMap(Option.liftPredicate(argv.indexOf(name), (at) => at >= 0), (at) => Arr.get(argv, at + 1))

/** The list named by `--list`, else the declared one; the problems that stop a run, if any. */
const listOf = (argv: ReadonlyArray<string>): Result.Result<List, string> => {
  const decoded = Option.match(flag(argv, "--list"), { onNone: () => declaredList, onSome: (file) => decodeListText(readFileSync(file, "utf8")) })
  return Result.flatMap(Result.mapError(decoded, String), (list) => {
    const problems = listProblems(list)
    if (problems.length > 0) return Result.fail(problems.join("\n"))
    return Result.succeed(list)
  })
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const env = { ...process.env }
  delete env.ANTHROPIC_BASE_URL
  const fork = Option.getOrElse(Option.orElse(flag(argv, "--fork"), () => Option.fromNullishOr(process.env.OPENCODE_DEV)), () => "")
  const number = (name: string, fallback: number) => Option.getOrElse(Option.map(flag(argv, name), Number), () => fallback)
  const limits: Limits = { ...LIMITS, timeBoundMs: number("--time-bound-ms", LIMITS.timeBoundMs), maxLoad: number("--max-load", LIMITS.maxLoad) }
  const lockFile = Option.getOrElse(flag(argv, "--lock"), () => join(tmpdir(), "opencode-fork-checks.flock"))
  const listed = listOf(argv)
  if (fork === "" || !existsSync(fork)) {
    console.log(`fork-checks: COULD NOT RUN: no fork checkout at "${fork}" (--fork <checkout>, or OPENCODE_DEV)`)
    process.exit(2)
  }
  if (Result.isFailure(listed)) {
    console.log(`fork-checks: COULD NOT RUN: the list does not parse:\n${listed.failure}`)
    process.exit(2)
  }
  const list = listed.success
  const input: Input = {
    list,
    fork,
    host: realHost(Option.getOrElse(Option.fromNullishOr(env.PATH), () => "")),
    runner: bunRunner(env),
    lock: (run) => holdingIfFree(lockFile, run).pipe(Effect.orElseSucceed(() => Option.none<Verdict>())),
    limits,
    say: (line) => console.log(line),
  }
  Effect.runFork(
    checkFork(input).pipe(
      Effect.map((verdict) => {
        for (const line of reportLines(list, verdict, rangeOf(fork))) console.log(line)
        process.exit(exitOf(verdict))
      }),
    ),
  )
}
