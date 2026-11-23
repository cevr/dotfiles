// `bun scripts/fork-checks.ts --fork <checkout>`: the fork's feature checks, the tests that hold each fork
// feature the owner keeps, declared once in scripts/fork-checks.json (package, test files, the request that
// last proved it). `bun run daily`'s upstream merge runs it on the merged tree before it pushes
// (scripts/upstream.ts `mergeChecks`), and a fork lane's round gate runs it on the lane; nothing else on the
// fork's own branch runs the fork's package tests (its CI runs on dev, beta and PRs only).
//
// One `bun test` per package, one at a time, niced, `--parallel=4`, in the package's own command (core's
// `script/test.ts`), its JUnit report read per test. A listed file that is not there, a failed test, a file
// that ran no test (an import that no longer resolves) and a nonzero exit no failed test accounts for are red
// (a declared skip explains no exit: a package command that fails after its tests is red beside any skip);
// a red file is run once more, and a file green on that rerun is a named flake. An expectation declares one
// test red on a host by a condition read at run time (the version of the first bash on PATH) with its reason:
// the test still runs, its failure there is a note, and its passing there (or its absence) is red, so a stale
// expectation cannot stay. It waits while the 1-minute load is over 24 and for the host's fork-checks lock (at
// most 30 minutes each), refuses to start under 6 GiB free on the Mac, and stops at its time bound: each is
// "could not run", which holds a merge as a red does. Each package prints its verdict and time as it ends; a run
// past its bound, or stopped by a SIGTERM or SIGINT (a caller's own bound), prints a partial report: each package
// finished, running or not started, with its time.
//
// Exit: 0 green, 1 red, 2 could not run, no fork named, or a list that does not parse. The last line is the summary.
//
// Usage: bun scripts/fork-checks.ts [--fork <checkout>] [--list <file>] [--time-bound-ms N] [--max-load N] [--lock <file>]
//        (--fork defaults to OPENCODE_DEV; --list, --max-load and --lock are for tests)
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Array as Arr, Cause, Clock, Config, Console, Context, Data, Duration, Effect, Exit, FileSystem, Layer, Match, Option, Path, Ref, Result, Schema, Stream } from "effect"
import { Command, Flag } from "effect/cli"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import declared from "./fork-checks.json" with { type: "json" }
import { forkNamed } from "./fork.ts"

const Feature = Schema.Struct({
  id: Schema.String,
  feature: Schema.String,
  package: Schema.String,
  files: Schema.NonEmptyArray(Schema.String),
  proved: Schema.String,
  /** The fork commit the feature arrived with: its files are required only in a checkout that contains it. */
  since: Schema.optionalKey(Schema.String),
})
const Expectation = Schema.Struct({
  package: Schema.String,
  file: Schema.String,
  test: Schema.String,
  host: Schema.Struct({ bash: Schema.String }),
  reason: Schema.String,
})
/**
 * One test a listed file skips (or marks todo) on purpose: its title, why, and the host condition when the skip
 * depends on the host (as an expectation's). Every other skip in a listed file is red, and a declared skip that ran is red.
 */
const Skip = Schema.Struct({
  package: Schema.String,
  file: Schema.String,
  test: Schema.String,
  /**
   * Where the skip holds, each part read at run time: `bash`, the version of the first bash on PATH; `missing`, the
   * commands none of which is on PATH (the test's own `Bun.which` check). Without `host` it holds everywhere.
   */
  host: Schema.optionalKey(Schema.Struct({ bash: Schema.optionalKey(Schema.String), missing: Schema.optionalKey(Schema.NonEmptyArray(Schema.String)) })),
  reason: Schema.String,
})
const List = Schema.Struct({
  about: Schema.String,
  packages: Schema.Record(Schema.String, Schema.NonEmptyArray(Schema.String)),
  features: Schema.NonEmptyArray(Feature),
  expectations: Schema.Array(Expectation),
  skips: Schema.optionalKey(Schema.Array(Skip)),
})
export type List = typeof List.Type
export type Expectation = typeof Expectation.Type
export type Skip = typeof Skip.Type
export type Feature = typeof Feature.Type

/** Decodes a list already read as data. */
export const decodeList = Schema.decodeUnknownResult(List)
/** Decodes a list file's text. */
export const decodeListText = Schema.decodeUnknownResult(Schema.fromJsonString(List))
/** A list as a file's text (a test's `--list`). */
export const encodeListText = Schema.encodeSync(Schema.fromJsonString(List))
/** scripts/fork-checks.json, decoded. */
export const declaredList = decodeList(declared)

/** What the schema cannot say: each feature's package has a command, ids are unique, a `since` is a full commit, each expectation names a listed file. */
export const listProblems = (list: List): ReadonlyArray<string> => {
  const listed = new Set(list.features.flatMap((feature) => feature.files.map((file) => `${feature.package}/${file}`)))
  const ids = list.features.map((feature) => feature.id)
  return [
    ...list.features.flatMap((feature) => Arr.filter([`${feature.id}: package ${feature.package} has no command`], () => !Object.hasOwn(list.packages, feature.package))),
    ...ids.flatMap((id, at) => Arr.filter([`${id}: the id is listed twice`], () => ids.indexOf(id) !== at)),
    ...list.features.flatMap((feature) =>
      Option.toArray(Option.map(Option.filter(Option.fromUndefinedOr(feature.since), (since) => !/^[0-9a-f]{40}$/.test(since)), (since) => `${feature.id}: since "${since}" is not a full commit sha`)),
    ),
    ...list.expectations.flatMap((each) => Arr.filter([`expectation "${each.test}": ${each.package}/${each.file} is in no feature`], () => !listed.has(`${each.package}/${each.file}`))),
    ...skipsOf(list).flatMap((each) => Arr.filter([`skip "${each.test}": ${each.package}/${each.file} is in no feature`], () => !listed.has(`${each.package}/${each.file}`))),
    ...skipsOf(list).flatMap((each) => Arr.filter([`skip "${each.test}": no reason`], () => each.reason.trim() === "")),
  ]
}

/** The list's declared skips (none when it declares none). */
export const skipsOf = (list: List): ReadonlyArray<Skip> => Option.getOrElse(Option.fromUndefinedOr(list.skips), () => [])

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

/** What a test in a report did: ran and passed, ran and failed, or did not run (skipped, or a todo). */
export type Status = "passed" | "failed" | "skipped" | "todo"

/** One test in a JUnit report: its file (relative to the package), its full name, and what it did. */
export interface Case {
  readonly file: string
  readonly test: string
  readonly status: Status
}

/** Whether a case's body ran. */
export const executed = (found: Case) => found.status === "passed" || found.status === "failed"

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

const PASSED: Status = "passed"

/** A case's status once its report shows `tag` inside it. */
const statusAfter = (tag: string, status: Status): Status => {
  if (tag === "<failure" || tag === "<error") return "failed"
  if (!tag.startsWith("<skipped")) return status
  if (attribute(tag, "message") === "TODO") return "todo"
  return "skipped"
}

/**
 * The tests in bun's JUnit report, each with the names of the describe blocks around it (the file's own suite left
 * out) and its status: `<failure>` or `<error>` failed, `<skipped message="TODO">` a todo, any other `<skipped>`
 * skipped (`test.skip`, `describe.skip`, a true `skipIf`, a false `if`), none passed.
 */
export const casesOf = (junit: string): ReadonlyArray<Case> => {
  const cases: Array<Case> = []
  const suites: Array<string> = []
  let open = Option.none<{ readonly file: string; readonly test: string; status: Status }>()
  for (const match of junit.matchAll(/<testsuite\b[^>]*?(\/?)>|<\/testsuite>|<testcase\b[^>]*?(\/?)>|<\/testcase>|<failure\b|<error\b|<skipped\b[^>]*>/g)) {
    const tag = match[0]
    if (tag.startsWith("<testsuite") && match[1] !== "/") suites.push(attribute(tag, "name"))
    if (tag === "</testsuite>") suites.pop()
    if (tag.startsWith("<testcase")) {
      const found = { file: relative(attribute(tag, "file")), test: [...suites.slice(1), attribute(tag, "name")].join(" > "), status: PASSED }
      if (match[2] === "/") cases.push(found)
      else open = Option.some(found)
    }
    Option.map(open, (current) => (current.status = statusAfter(tag, current.status)))
    if (tag === "</testcase>") {
      Option.map(open, (current) => cases.push({ ...current }))
      open = Option.none()
    }
  }
  return cases
}

/** One package's run: its package, its command, the files it runs, and its expectations that hold on this host. */
export interface Plan {
  readonly package: string
  /** The package's test command (fork-checks.json `packages`), named when its exit is red. */
  readonly command: ReadonlyArray<string>
  readonly files: ReadonlyArray<string>
  readonly expected: ReadonlyArray<Expectation>
  /** Its declared skips that hold on this host. */
  readonly skips: ReadonlyArray<Skip>
}

/** The expectations whose host condition holds here: the first bash on PATH is the declared version. */
export const activeExpectations = (list: List, bash: Option.Option<string>): ReadonlyArray<Expectation> =>
  list.expectations.filter((each) => Option.exists(bash, (version) => version === each.host.bash))

/** What a skip's host condition reads of this host: the first bash's version, and which of the named commands are on PATH. */
export interface HostFacts {
  readonly bash: Option.Option<string>
  readonly present: ReadonlySet<string>
}

/** The commands the list's skips name as missing, each once: the gauge reads only these. */
export const commandsOf = (list: List): ReadonlyArray<string> =>
  Arr.dedupe(skipsOf(list).flatMap((each) => Option.getOrElse(Option.flatMap(Option.fromUndefinedOr(each.host), (host) => Option.fromUndefinedOr(host.missing)), () => [])))

/** Whether a skip's host condition holds here: its bash version (if named) is this bash, and none of its missing commands (if named) is on PATH. */
const holdsHere = (skip: Skip, facts: HostFacts) =>
  Option.match(Option.fromUndefinedOr(skip.host), {
    onNone: () => true,
    onSome: (host) =>
      Option.match(Option.fromUndefinedOr(host.bash), { onNone: () => true, onSome: (wanted) => Option.contains(facts.bash, wanted) }) &&
      Option.match(Option.fromUndefinedOr(host.missing), { onNone: () => true, onSome: (commands) => !commands.some((command) => facts.present.has(command)) }),
  })

/** The declared skips that hold here. */
export const activeSkips = (list: List, facts: HostFacts): ReadonlyArray<Skip> => skipsOf(list).filter((each) => holdsHere(each, facts))

/** How a note names a test skipped as the list declares. */
const SKIPPED = "skipped as declared"
/** What parts a declared skip's note from its reason. */
const WHY = "; why: "
const hostOf = (skip: Skip) =>
  Option.getOrElse(
    Option.map(Option.fromUndefinedOr(skip.host), (host) =>
      [
        ...Option.toArray(Option.map(Option.fromUndefinedOr(host.bash), (version) => ` on bash ${version}`)),
        ...Option.toArray(Option.map(Option.fromUndefinedOr(host.missing), (commands) => ` without ${commands.join(" or ")} on PATH`)),
      ].join(""),
    ),
    () => "",
  )

/** The exit bun gives when a test failed: the one nonzero exit a failed test in the report accounts for. */
export const TESTS_FAILED = 1

/** How a red names the whole run of a package (its exit), not one file: it holds each of the package's features. */
const THE_RUN = "(the run)"

/** A declared skip the report shows skipped: a note, named in the summary. It accounts for no exit of the runner. */
export class SkipNote extends Data.TaggedClass("SkipNote")<{ readonly skip: Skip }> {}

/**
 * A failed test the report shows, and the exit its failure makes (bun's `TESTS_FAILED`): the only thing that accounts
 * for a nonzero exit. One an active expectation declares is a note; any other is red besides.
 */
export class ExitExplanation extends Data.TaggedClass("ExitExplanation")<{ readonly failed: Case; readonly exit: typeof TESTS_FAILED; readonly expected: Option.Option<Expectation> }> {}

/**
 * Whether the runner's `code` is accounted for: 0 needs nothing; any other code only a failed test whose failure makes
 * that very code. It takes explanations alone: a skip, declared or not, explains no exit, so a package command that
 * fails after its tests (exit 7) is red beside any number of declared skips.
 */
export const exitAccounted = (code: number, explanations: ReadonlyArray<ExitExplanation>): boolean => code === 0 || explanations.some((each) => each.exit === code)

export interface Judged {
  readonly reds: ReadonlyArray<Red>
  /** The failed tests, each accounting for exit 1. */
  readonly explanations: ReadonlyArray<ExitExplanation>
  /** The declared skips that skipped. */
  readonly skipped: ReadonlyArray<SkipNote>
  /** What a reader sees: each expected failure, then each declared skip. */
  readonly notes: ReadonlyArray<string>
}

/** The note a declared skip that skipped makes. */
const skipNoteText = (plan: Plan, note: SkipNote) => `${SKIPPED}${hostOf(note.skip)}: ${plan.package}/${note.skip.file} > ${note.skip.test}${WHY}${note.skip.reason}`
/** The note an expected failure makes. */
const expectedText = (plan: Plan, each: Expectation) => `expected red on bash ${each.host.bash}: ${plan.package}/${each.file} > ${each.test} (${each.reason})`

/**
 * Judges one run of `plan` by its exit and its report's tests: the reds, the failed tests that account for the exit,
 * and the declared skips that held. Only an executed case (passed or failed) proves its file ran: a listed file with
 * none is red, however many skipped or todo cases it reports. A skipped or todo case is red unless the list declares
 * it, and a declared skip that ran, or is gone, is red. A nonzero exit no failed test accounts for (`exitAccounted`)
 * is red, naming the command and its exit.
 */
export const judge = (plan: Plan, code: number, cases: ReadonlyArray<Case>): Judged => {
  const listed = cases.filter((found) => plan.files.includes(found.file))
  const expected = plan.expected.filter((each) => each.package === plan.package && plan.files.includes(each.file))
  const skips = plan.skips.filter((each) => each.package === plan.package && plan.files.includes(each.file))
  const same = (found: Case) => (each: { readonly file: string; readonly test: string }) => each.file === found.file && each.test === found.test
  const red = (file: string, test: string, why: string): Red => ({ package: plan.package, file, test, why })
  const silent = plan.files.flatMap((file) => {
    const mine = listed.filter((found) => found.file === file)
    if (mine.length === 0) return [red(file, "", "the file ran no test (the runner did not run it: it did not load, holds none, or was filtered out)")]
    if (!mine.some(executed)) return [red(file, "", `the file ran no test: its ${mine.length} cases were all skipped or todo`)]
    return []
  })
  const failed = listed.flatMap((found) => Arr.filter([red(found.file, found.test, "failed")], () => found.status === "failed" && !expected.some(same(found))))
  const undeclared = listed.flatMap((found) =>
    Arr.filter([red(found.file, found.test, `${found.status}, and fork-checks.json declares no skip for it: declare it with its reason, or let it run`)], () => !executed(found) && !skips.some(same(found))),
  )
  const stale = expected.flatMap((each) => {
    const ran = cases.filter((found) => found.file === each.file && found.test === each.test)
    if (ran.length === 0) return [red(each.file, each.test, `declared red on bash ${each.host.bash} but it did not run: the expectation names a test that is gone`)]
    if (!ran.some(executed)) return [red(each.file, each.test, `declared red on bash ${each.host.bash} but it was ${Arr.map(ran, (found) => found.status).join(", ")}: it did not run`)]
    if (ran.some((found) => found.status === "passed")) return [red(each.file, each.test, `declared red on bash ${each.host.bash} but it passed: remove the expectation`)]
    return []
  })
  const staleSkips = skips.flatMap((each) => {
    const ran = cases.filter((found) => found.file === each.file && found.test === each.test)
    if (ran.length === 0) return [red(each.file, each.test, `declared skipped${hostOf(each)} but it is gone: the skip names a test the file does not hold`)]
    if (ran.some(executed)) return [red(each.file, each.test, `declared skipped${hostOf(each)} but it ran: remove the skip`)]
    return []
  })
  const explanations = listed.flatMap((found) =>
    Arr.filter([new ExitExplanation({ failed: found, exit: TESTS_FAILED, expected: Arr.findFirst(expected, same(found)) })], () => found.status === "failed"),
  )
  const skipped = skips.flatMap((skip) => Arr.filter([new SkipNote({ skip })], () => listed.some((found) => !executed(found) && same(found)(skip))))
  const notes = [
    ...explanations.flatMap((each) => Option.toArray(Option.map(each.expected, (expectation) => expectedText(plan, expectation)))),
    ...skipped.map((note) => skipNoteText(plan, note)),
  ]
  const exit = Arr.filter(
    [red(THE_RUN, "", `${plan.command.join(" ")} exited ${code}, and no failed test in its report accounts for it (a failed test exits ${TESTS_FAILED}; a skip accounts for no exit)`)],
    () => !exitAccounted(code, explanations),
  )
  return { reds: [...silent, ...failed, ...undeclared, ...stale, ...staleSkips, ...exit], explanations, skipped, notes }
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

/** Why the host could not be read, or a command could not start. */
export class HostUnread extends Data.TaggedError("HostUnread")<{ readonly message: string }> {}

/** Runs one package's tests. */
export class TestRunner extends Context.Service<TestRunner, { readonly run: (run: Run) => Effect.Effect<Ran, HostUnread> }>()("dotfiles-opencode/fork-checks/TestRunner") {}

/** What the checks read of the host. */
export class HostGauge extends Context.Service<
  HostGauge,
  {
    /** The version of the first bash on PATH (`$BASH_VERSION` up to its "("), none without one. */
    readonly bash: Effect.Effect<Option.Option<string>>
    /** Whether the disk floor applies (the Mac). */
    readonly floored: Effect.Effect<boolean, HostUnread>
    /** The 1-minute load average. */
    readonly load: Effect.Effect<number, HostUnread>
    readonly freeBytes: (dir: string) => Effect.Effect<number, HostUnread>
    /** Whether `command` is on PATH (`command -v`), as a test's own `Bun.which` finds it. */
    readonly has: (command: string) => Effect.Effect<boolean>
  }
>()("dotfiles-opencode/fork-checks/HostGauge") {}

/** The host's fork-checks lock: runs the effect holding it, or answers none at once while another run holds it. */
export class RunLock extends Context.Service<RunLock, { readonly holding: <R>(file: string, run: Effect.Effect<Verdict, HostUnread, R>) => Effect.Effect<Option.Option<Verdict>, HostUnread, R> }>()(
  "dotfiles-opencode/fork-checks/RunLock",
) {}

export interface Limits {
  readonly maxLoad: number
  /** How long it waits for a calm host, and for the lock, before it could not run. */
  readonly waitMs: number
  readonly everyMs: number
  /**
   * How long the package runs may take once the lock is held, all of them together. The daily's merge step puts no
   * bound of its own around the CLI (`featureStep` waits for it), so this is the daily's bound: 40 minutes, against
   * the real list's 2.7 minutes on a quiet Mac and about 4 loaded (each run niced, at width 4). Only a hung run
   * reaches it, and an unattended daily that holds a merge for a slow host loses a day, so the bound is wide.
   */
  readonly timeBoundMs: number
  readonly diskFloor: number
  readonly threads: number
}

export const LIMITS: Limits = { maxLoad: 24, waitMs: 30 * 60_000, everyMs: 15_000, timeBoundMs: 40 * 60_000, diskFloor: 6 * 2 ** 30, threads: 4 }

export interface Input {
  readonly list: List
  readonly fork: string
  readonly limits: Limits
  /** The host lock's file. */
  readonly lock: string
}

/** The runs: one per package, its files in list order, each once. */
export const plansOf = (list: List, bash: Option.Option<string>, present: ReadonlySet<string> = new Set()): ReadonlyArray<Plan> =>
  Arr.dedupe(list.features.map((feature) => feature.package)).map((pkg) => ({
    package: pkg,
    command: Option.getOrElse(Option.fromNullishOr(list.packages[pkg]), (): ReadonlyArray<string> => ["bun", "test"]),
    files: Arr.dedupe(list.features.filter((feature) => feature.package === pkg).flatMap((feature) => feature.files)),
    expected: activeExpectations(list, bash).filter((each) => each.package === pkg),
    skips: activeSkips(list, { bash, present }).filter((each) => each.package === pkg),
  }))

const couldNot = (reason: string, notes: ReadonlyArray<string> = []): Verdict => ({ kind: "could-not-run", reason, notes })
const tail = (text: string, lines = 30) => text.trimEnd().split("\n").slice(-lines).join("\n")
const minutes = (ms: number) => `${Number((ms / 60_000).toFixed(3))} min`

/** Each listed file that is not in the checkout, as a red. */
export const missingFiles = Effect.fn("ForkChecks.missingFiles")(function* (list: { readonly features: ReadonlyArray<Feature> }, fork: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const listed = Arr.dedupeWith(
    list.features.flatMap((feature) => feature.files.map((file) => ({ package: feature.package, file }))),
    (one, two) => one.package === two.package && one.file === two.file,
  )
  const present = yield* Effect.forEach(listed, (each) => fs.exists(path.join(fork, each.package, each.file)).pipe(Effect.orElseSucceed(() => false)), { concurrency: 8 })
  return listed.flatMap((each, at) => Arr.filter([{ ...each, test: "", why: "the listed file is not in the fork" }], () => !present[at]))
})

/** Polls `ready` until it answers some, at most `limits.waitMs`. */
const patiently = Effect.fn("ForkChecks.patiently")(function* <R>(limits: Limits, ready: Effect.Effect<Option.Option<Verdict>, HostUnread, R>) {
  const deadline = (yield* Clock.currentTimeMillis) + limits.waitMs
  for (;;) {
    const got = yield* ready
    if (Option.isSome(got) || (yield* Clock.currentTimeMillis) >= deadline) return got
    yield* Effect.sleep(Duration.millis(limits.everyMs))
  }
})

/** Waits for the load to drop to `limits.maxLoad`; answers whether it did. */
const calm = Effect.fn("ForkChecks.calm")(function* (limits: Limits) {
  const gauge = yield* HostGauge
  const ready = Effect.map(gauge.load, (load) => Option.map(Option.liftPredicate(load, (each) => each <= limits.maxLoad), (): Verdict => ({ kind: "green", notes: [] })))
  return Option.isSome(yield* patiently(limits, ready))
})

/** One run of `plan`, judged; could not run when the host stays loaded, the time bound passes or bun writes no report. */
const runOnce = Effect.fn("ForkChecks.runOnce")(function* (input: Input, plan: Plan, deadline: number) {
  if (!(yield* calm(input.limits))) return couldNot(`the 1-minute load stayed over ${input.limits.maxLoad} for ${minutes(input.limits.waitMs)} before ${plan.package} ran`)
  const left = deadline - (yield* Clock.currentTimeMillis)
  if (left <= 0) return couldNot(`the time bound (${minutes(input.limits.timeBoundMs)}) passed before ${plan.package} ran`)
  yield* Console.log(`fork-checks: ${plan.package}: ${plan.files.length} files`)
  const path = yield* Path.Path
  const runner = yield* TestRunner
  const ran = yield* runner.run({ cwd: path.join(input.fork, plan.package), command: plan.command, files: plan.files, threads: input.limits.threads, timeoutMs: left })
  // Each file's line: what its whole report says ran, so a log shows every listed file was run.
  const report = Match.value(ran).pipe(
    Match.when({ kind: "exited" }, (out) => Option.map(Option.filter(out.junit, whole), casesOf)),
    Match.orElse(() => Option.none<ReadonlyArray<Case>>()),
  )
  yield* Effect.forEach(Option.toArray(report), (cases) =>
    Effect.forEach(plan.files, (file) => {
      const mine = cases.filter((found) => found.file === file)
      const count = (status: Status) => mine.filter((found) => found.status === status).length
      return Console.log(
        `fork-checks: ran ${plan.package}/${file}: ${mine.filter(executed).length} executed (${count("failed")} failed), ${count("skipped")} skipped, ${count("todo")} todo`,
      )
    }),
  )
  return Match.value(ran).pipe(
    Match.when({ kind: "timed-out" }, (out): Verdict => couldNot(`${plan.package} ran past the time bound (${minutes(input.limits.timeBoundMs)}), its process group ended:\n${tail(out.log)}`)),
    Match.when({ kind: "exited" }, (out) => exitedVerdict(plan, out)),
    Match.exhaustive,
  )
})

/** Whether bun finished writing its JUnit report: it ends with `</testsuites>`. A report cut short proves nothing. */
export const whole = (junit: string) => /<\/testsuites>\s*$/.test(junit)

/**
 * The verdict of a run that exited, by its report. With a whole report, `judge`'s. Without one (none, or one cut
 * short): a 0 exit proved nothing ran, so each listed file is red; any other exit could not run. Either way the
 * command, its exit and its log's tail are named.
 */
const exitedVerdict = (plan: Plan, out: Extract<Ran, { readonly kind: "exited" }>): Verdict => {
  const log = `${plan.package} log (${plan.command.join(" ")}, exit ${out.code}):\n${tail(out.log)}`
  return Option.match(Option.filter(out.junit, whole), {
    onNone: (): Verdict => {
      const what = Option.match(out.junit, { onNone: () => "wrote no report", onSome: () => "wrote a report cut short (no closing </testsuites>)" })
      if (out.code !== 0) return couldNot(`${plan.command.join(" ")} in ${plan.package} exited ${out.code} and ${what}:\n${tail(out.log)}`)
      const reds = plan.files.map((file) => ({ package: plan.package, file, test: "", why: `the runner exited 0 and ${what}: the file is not proven to have run` }))
      return { kind: "red", reds, notes: [log] }
    },
    onSome: (junit): Verdict => {
      const judged = judge(plan, out.code, casesOf(junit))
      if (judged.reds.length === 0) return { kind: "green", notes: judged.notes }
      return { kind: "red", reds: judged.reds, notes: [...judged.notes, log] }
    },
  })
}

/** `plan`'s run, and once more for its red files: a file green on the rerun is a named flake, a file red twice stays red. */
const runPlan = Effect.fn("ForkChecks.runPlan")(function* (input: Input, plan: Plan, deadline: number) {
  const first = yield* runOnce(input, plan, deadline)
  if (first.kind !== "red") return first
  const whole = first.reds.some((red) => red.file === THE_RUN)
  const files = Arr.filter(plan.files, (file) => whole || first.reds.some((red) => red.file === file))
  yield* Console.log(`fork-checks: ${plan.package}: ${files.length} red files; running them once more`)
  const second = yield* runOnce(input, { ...plan, files }, deadline)
  if (second.kind !== "green") return second
  return { kind: "green", notes: [...second.notes, `flaky, green on the rerun: ${files.map((file) => `${plan.package}/${file}`).join(", ")}`] } satisfies Verdict
})

/** Where one package's run stands: its features, when it started, and when it ended with what. */
export interface Stage {
  readonly package: string
  readonly features: ReadonlyArray<string>
  readonly started: Option.Option<number>
  readonly ended: Option.Option<{ readonly at: number; readonly kind: Verdict["kind"] }>
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`

/** Each package's stage at `now`: finished with its verdict and time, running and for how long, or not started. */
export const progressOf = (stages: ReadonlyArray<Stage>, now: number): string =>
  stages
    .map((stage) => {
      const name = `${stage.package} [${stage.features.join(", ")}]`
      return Option.match(stage.started, {
        onNone: () => `${name}: not started`,
        onSome: (start) =>
          Option.match(stage.ended, {
            onNone: () => `${name}: running for ${seconds(now - start)}`,
            onSome: (end) => `${name}: ${end.kind} in ${seconds(end.at - start)}`,
          }),
      })
    })
    .join("; ")

/** How a note names the packages' progress when a run could not finish. */
const PROGRESS = "progress"

/** Every plan in turn, each one's stage kept in `stages`: stops at the first that could not run, else gathers the reds and notes. */
const runAll = Effect.fn("ForkChecks.runAll")(function* (input: Input, deadline: number, stages: Ref.Ref<ReadonlyArray<Stage>>) {
  const gauge = yield* HostGauge
  const bash = yield* gauge.bash
  // Only the commands a declared skip names are looked up.
  const commands = commandsOf(input.list)
  const found = yield* Effect.forEach(commands, (command) => gauge.has(command))
  const present = new Set(commands.filter((_, at) => found[at]))
  const plans = plansOf(input.list, bash, present)
  const idsOf = (pkg: string) => input.list.features.filter((feature) => feature.package === pkg).map((feature) => feature.id)
  yield* Ref.set(stages, plans.map((plan) => ({ package: plan.package, features: idsOf(plan.package), started: Option.none(), ended: Option.none() })))
  const mark = (pkg: string, change: (stage: Stage) => Stage) => Ref.update(stages, (all) => all.map((stage) => Option.getOrElse(Option.map(Option.liftPredicate(stage, (each) => each.package === pkg), change), () => stage)))
  const reds: Array<Red> = []
  const notes: Array<string> = []
  for (const plan of plans) {
    const start = yield* Clock.currentTimeMillis
    yield* mark(plan.package, (stage) => ({ ...stage, started: Option.some(start) }))
    const verdict = yield* runPlan(input, plan, deadline)
    const end = yield* Clock.currentTimeMillis
    yield* mark(plan.package, (stage) => ({ ...stage, ended: Option.some({ at: end, kind: verdict.kind }) }))
    yield* Console.log(`fork-checks: ${plan.package}: ${verdict.kind} in ${seconds(end - start)}`)
    notes.push(...verdict.notes)
    if (verdict.kind === "could-not-run") return couldNot(verdict.reason, [...notes, `${PROGRESS}: ${progressOf(yield* Ref.get(stages), end)}`])
    if (verdict.kind === "red") reds.push(...verdict.reds)
  }
  if (reds.length > 0) return { kind: "red", reds, notes } satisfies Verdict
  return { kind: "green", notes } satisfies Verdict
})

/** Whether the checkout at `fork` contains `commit` (`git merge-base --is-ancestor`); why not, when it does not. */
const contains = Effect.fn("ForkChecks.contains")(function* (fork: string, commit: string) {
  const ran = yield* runCommand("git", ["-C", fork, "merge-base", "--is-ancestor", commit, "HEAD"], ".", 30_000).pipe(Effect.option)
  const code = Option.map(Option.flatten(ran), (each) => each.code)
  if (Option.contains(code, 0)) return Option.none<string>()
  if (Option.contains(code, 1)) return Option.some(`since ${commit}`)
  return Option.some(
    Option.match(code, {
      onNone: () => `since ${commit}; git could not run in the checkout to tell`,
      onSome: (exit) => `since ${commit}; the checkout does not have that commit, git merge-base exited ${exit}`,
    }),
  )
})

/** How a note names a feature this checkout is not required to hold yet. */
const NOT_YET = "not yet in this checkout"

/**
 * The list as this checkout must hold it: a feature with a `since` the checkout does not contain is left out, each
 * named in a note ("not yet in this checkout"), never silently. One it contains is required like any other, so a
 * merge that loses its file is red.
 */
export const activeList = Effect.fn("ForkChecks.activeList")(function* (list: List, fork: string) {
  const judged = yield* Effect.forEach(list.features, (feature) =>
    Option.match(Option.fromUndefinedOr(feature.since), {
      onNone: () => Effect.succeed({ feature, pending: Option.none<string>() }),
      onSome: (since) => Effect.map(contains(fork, since), (pending) => ({ feature, pending })),
    }),
  )
  const notes = judged.flatMap((each) =>
    Option.toArray(Option.map(each.pending, (why) => `${NOT_YET} (${why}): ${each.feature.id}: ${each.feature.files.map((file) => `${each.feature.package}/${file}`).join(", ")}`)),
  )
  const features = judged.filter((each) => Option.isNone(each.pending)).map((each) => each.feature)
  return { features, notes }
})

/** How the partial report a stopped run prints names why it stopped. */
export const STOPPED = "stopped by a signal (the caller's own bound, or a kill) before it finished"

/** The partial report of a run stopped from outside: each package finished, running or not started, with its time; the last line could not run. */
const stoppedReport = (notes: ReadonlyArray<string>, began: number, stages: Ref.Ref<ReadonlyArray<Stage>>) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const progress = Arr.match(yield* Ref.get(stages), {
      onEmpty: () => "no package had started (it was waiting for a calm host, the disk or the lock)",
      onNonEmpty: (all) => progressOf(all, now),
    })
    for (const note of notes) yield* Console.log(note)
    yield* Console.log(`fork-checks: COULD NOT RUN: ${STOPPED}, after ${seconds(now - began)}; ${PROGRESS}: ${progress}`)
  })

/**
 * The checks over the checkout: the features it holds (`activeList`), missing files first, then the disk floor, the
 * lock, and each package's run. Stopped from outside (a SIGTERM or SIGINT interrupts the CLI), it prints a partial
 * report first: what finished, what was running, each with its time; the CLI then exits 2, could not run.
 */
export const checkFork = Effect.fn("ForkChecks.check")(function* (input: Input) {
  const began = yield* Clock.currentTimeMillis
  const active = yield* activeList(input.list, input.fork)
  const stages = yield* Ref.make<ReadonlyArray<Stage>>([])
  const verdict = yield* Arr.match(active.features, {
    onEmpty: () => Effect.succeed<Verdict>({ kind: "green", notes: [] }),
    onNonEmpty: (features) => checkHeld({ ...input, list: { ...input.list, features } }, stages),
  }).pipe(Effect.onInterrupt(() => stoppedReport(active.notes, began, stages)))
  return { ...verdict, notes: [...active.notes, ...verdict.notes] } satisfies Verdict
})

/** The checks over features the checkout holds, each package's stage kept in `stages`. A host that cannot be read could not run. */
const checkHeld = Effect.fn("ForkChecks.checkHeld")(function* (input: Input, stages: Ref.Ref<ReadonlyArray<Stage>>) {
  const missing = yield* missingFiles(input.list, input.fork)
  if (missing.length > 0) return { kind: "red", reds: missing, notes: [] } satisfies Verdict
  const gauge = yield* HostGauge
  const lock = yield* RunLock
  const checked = Effect.gen(function* () {
    const free = yield* gauge.freeBytes(input.fork)
    if ((yield* gauge.floored) && free < input.limits.diskFloor)
      return couldNot(`${(free / 2 ** 30).toFixed(1)} GiB free on ${input.fork}'s disk, under the ${(input.limits.diskFloor / 2 ** 30).toFixed(0)} GiB floor`)
    const deadline = (yield* Clock.currentTimeMillis) + input.limits.timeBoundMs
    const verdict = yield* patiently(input.limits, lock.holding(input.lock, runAll(input, deadline, stages)))
    return Option.getOrElse(verdict, () => couldNot(`another fork-checks run held the host's lock for ${minutes(input.limits.waitMs)}`))
  })
  return yield* checked.pipe(Effect.catchTag("HostUnread", (error) => Effect.succeed(couldNot(`the host could not be read: ${error.message}`))))
})

/** The features that list `red`'s file; every feature of its package for a red of the whole run. */
const featuresOf = (list: List, red: Red) => list.features.filter((feature) => feature.package === red.package && (red.file === THE_RUN || feature.files.includes(red.file))).map((feature) => feature.id)

/** The report's lines; the last is the summary, naming each red test, its features and the merge's range (`over …`) when the head is a merge. */
export const reportLines = (list: List, verdict: Verdict, range: Option.Option<string>): ReadonlyArray<string> => {
  const over = Option.getOrElse(Option.map(range, (each) => ` over ${each}`), () => "")
  const name = (red: Red) => [`${red.package}/${red.file}`, ...Arr.filter([red.test], (test) => test !== "")].join(" > ")
  return Match.value(verdict).pipe(
    Match.when({ kind: "green" }, (green) => {
      const pending = green.notes.filter((note) => note.startsWith(NOT_YET)).length
      const held = Arr.filter([` (${pending} not yet in this checkout)`], () => pending > 0).join("")
      const skipped = green.notes.filter((note) => note.startsWith(SKIPPED)).map((note) => note.slice(note.indexOf(": ") + 2, note.lastIndexOf(WHY)))
      const named = Arr.filter([`; ${skipped.length} skipped as declared: ${skipped.join("; ")}`], () => skipped.length > 0).join("")
      return [...green.notes, `fork-checks: green${over}, ${list.features.length - pending} features${held}${named}`]
    }),
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

/** A command's exit and its output (stdout and stderr together), killed with its process group at `timeoutMs`. */
const runCommand = Effect.fn("ForkChecks.runCommand")(function* (command: string, args: ReadonlyArray<string>, cwd: string, timeoutMs: number) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(ChildProcess.make(command, [...args], { cwd, stdin: "ignore", forceKillAfter: "3 seconds" }))
      const ran = yield* Effect.all([handle.all.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode], { concurrency: 2 }).pipe(Effect.timeoutOption(Duration.millis(timeoutMs)))
      return Option.map(ran, ([log, code]) => ({ log, code: Number(code) }))
    }),
  ).pipe(Effect.mapError((error) => new HostUnread({ message: `${command}: ${error.message}` })))
})

/** A command's trimmed stdout when it exits 0, none otherwise (or when it cannot start). */
const outputOf = (command: string, args: ReadonlyArray<string>, cwd = ".") =>
  runCommand(command, args, cwd, 30_000).pipe(
    Effect.map((ran) => Option.map(Option.filter(ran, (each) => each.code === 0), (each) => each.log.trim())),
    Effect.orElseSucceed(() => Option.none<string>()),
  )

/** The merge at the checkout's head, labelled: `upstream a..b` when its second parent is upstream/dev (the daily's merge), else `merge parents a..b`; none when the head is not a merge. */
export const rangeOf = Effect.fn("ForkChecks.rangeOf")(function* (fork: string) {
  const parents = Option.filter(
    Option.map(yield* outputOf("git", ["-C", fork, "rev-parse", "HEAD^1", "HEAD^2"]), (text) => text.split("\n")),
    (shas) => shas.length === 2,
  )
  const upstream = yield* outputOf("git", ["-C", fork, "rev-parse", "--verify", "--quiet", "refs/remotes/upstream/dev"])
  return Option.map(parents, (shas) => {
    const span = shas.map((sha) => sha.slice(0, 10)).join("..")
    if (Option.exists(upstream, (sha) => sha === shas[1])) return `upstream ${span}`
    return `merge parents ${span}`
  })
})

/** `bun test` niced in its own process group, its JUnit report in a scratch folder, the group ended when it exits or times out. */
export const bunRunner = Layer.effect(
  TestRunner,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const run = (each: Run) =>
      Effect.scoped(
        Effect.gen(function* () {
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "fork-checks-" })
          const report = path.join(dir, "junit.xml")
          const args = ["-n", "10", ...each.command, `--parallel=${each.threads}`, "--reporter=junit", `--reporter-outfile=${report}`, ...each.files]
          const ran = yield* runCommand("nice", args, each.cwd, each.timeoutMs)
          if (Option.isNone(ran)) return { kind: "timed-out", log: "" } satisfies Ran
          const junit = yield* fs.readFileString(report).pipe(Effect.option)
          return { kind: "exited", code: ran.value.code, log: ran.value.log, junit } satisfies Ran
        }),
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError((error) => new HostUnread({ message: error.message })),
      )
    return TestRunner.of({ run })
  }),
)

/** The first number in `text`. */
const firstNumber = (text: string) => Number(Option.getOrElse(Option.map(Option.fromNullishOr(/\d+(?:\.\d+)?/.exec(text)), (match) => match[0]), () => "NaN"))

/** The host as commands and files read it: bash's version, `uname -s`, `/proc/loadavg` or `sysctl -n vm.loadavg`, `df -Pk`. */
export const hostGauge = Layer.effect(
  HostGauge,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const read = (command: string, args: ReadonlyArray<string>) => outputOf(command, args).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
    const must = (what: string, got: Option.Option<string>) => Effect.mapError(Effect.fromOption(got), () => new HostUnread({ message: `could not read ${what}` }))
    const number = (what: string, text: string) => Effect.filterOrFail(Effect.succeed(firstNumber(text)), Number.isFinite, () => new HostUnread({ message: `${what} read "${text}"` }))
    return HostGauge.of({
      bash: Effect.map(read("bash", ["--noprofile", "--norc", "-c", 'printf %s "$BASH_VERSION"']), (version) => Option.flatMap(version, (text) => Option.filter(Arr.head(text.split("(")), (each) => each !== ""))),
      floored: Effect.map(read("uname", ["-s"]), (system) => Option.exists(system, (name) => name === "Darwin")),
      has: (command: string) => Effect.map(read("bash", ["--noprofile", "--norc", "-c", 'command -v -- "$1"', "has", command]), Option.isSome),
      load: Effect.gen(function* () {
        const proc = yield* fs.readFileString("/proc/loadavg").pipe(Effect.option)
        const got = yield* Option.match(proc, { onSome: (text) => Effect.succeed(Option.some(text)), onNone: () => read("sysctl", ["-n", "vm.loadavg"]) })
        return yield* number("the load", yield* must("the load", got))
      }),
      freeBytes: (dir: string) =>
        Effect.gen(function* () {
          const text = yield* must(`free space on ${dir}`, yield* read("df", ["-Pk", dir]))
          const available = Option.getOrElse(Option.flatMap(Arr.get(text.split("\n"), 1), (line) => Arr.get(line.trim().split(/\s+/), 3)), () => "")
          return (yield* number(`df -Pk ${dir}`, available)) * 1024
        }),
    })
  }),
)

/** Holds `flock(2)` on the lock file in a child that keeps it until its scope ends (the kernel frees it with its holder). */
const HOLDER = 'use Fcntl ":flock"; open(my $f, ">>", $ARGV[0]) or exit 2; flock($f, LOCK_EX | LOCK_NB) or exit 1; $| = 1; print "held\\n"; sleep;'

/** The host's lock: a `perl` child holds an exclusive `flock` on the file for the run's length, on the Mac and Linux alike. */
export const flockLock = Layer.effect(
    RunLock,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const holding = <R>(file: string, run: Effect.Effect<Verdict, HostUnread, R>) =>
        Effect.scoped(
          Effect.gen(function* () {
            const holder = yield* spawner.spawn(ChildProcess.make("perl", ["-e", HOLDER, file], { stdin: "ignore", forceKillAfter: "1 second" }))
            const said = yield* holder.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead)
            if (!Option.exists(said, (line) => line === "held")) return Option.none<Verdict>()
            return Option.some(yield* run)
          }),
        ).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(new HostUnread({ message: `the lock ${file}: ${error.message}` }))))
      return RunLock.of({ holding })
    }),
  )

/** The exit code the program fails with; 0 is a success. */
class Exited extends Data.TaggedError("ForkChecksExit")<{ readonly code: number }> {}
const decodeExited = Schema.decodeUnknownOption(Schema.Struct({ _tag: Schema.Literal("ForkChecksExit"), code: Schema.Number }))

/** The list named by `--list`, else the declared one, with the problems that stop a run. */
const listOf = Effect.fn("ForkChecks.listOf")(function* (file: Option.Option<string>) {
  const fs = yield* FileSystem.FileSystem
  const decoded = yield* Option.match(file, { onNone: () => Effect.succeed(declaredList), onSome: (each) => Effect.map(fs.readFileString(each), decodeListText) })
  return Result.flatMap(Result.mapError(decoded, String), (list) => {
    const problems = listProblems(list)
    if (problems.length > 0) return Result.fail(problems.join("\n"))
    return Result.succeed(list)
  })
})

const command = Command.make(
  "fork-checks",
  {
    fork: Flag.String("fork").pipe(Flag.withDescription("The fork checkout (default OPENCODE_DEV)"), Flag.optional),
    list: Flag.String("list").pipe(Flag.withDescription("A list other than scripts/fork-checks.json (tests)"), Flag.optional),
    timeBoundMs: Flag.Int("time-bound-ms").pipe(Flag.withDescription("The whole run's time bound"), Flag.withDefault(LIMITS.timeBoundMs)),
    maxLoad: Flag.Int("max-load").pipe(Flag.withDescription("The 1-minute load it waits under (tests)"), Flag.withDefault(LIMITS.maxLoad)),
    lock: Flag.String("lock").pipe(Flag.withDescription("The host lock file (tests)"), Flag.optional),
  },
  Effect.fn("ForkChecks.main")(function* (flags) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dev = yield* Config.option(Config.String("OPENCODE_DEV"))
    const fork = forkNamed(flags.fork, dev)
    if (Result.isFailure(fork)) return yield* Console.log(`fork-checks: COULD NOT RUN: ${fork.failure}`).pipe(Effect.andThen(new Exited({ code: 2 })))
    if (!(yield* fs.exists(fork.success))) return yield* Console.log(`fork-checks: COULD NOT RUN: no fork checkout at ${fork.success}`).pipe(Effect.andThen(new Exited({ code: 2 })))
    const listed = yield* listOf(flags.list)
    if (Result.isFailure(listed)) return yield* Console.log(`fork-checks: COULD NOT RUN: the list does not parse:\n${listed.failure}`).pipe(Effect.andThen(new Exited({ code: 2 })))
    const tmp = yield* Config.String("TMPDIR").pipe(Config.withDefault("/tmp"))
    const lockFile = Option.getOrElse(flags.lock, () => path.join(tmp, "opencode-fork-checks.flock"))
    const limits: Limits = { ...LIMITS, timeBoundMs: flags.timeBoundMs, maxLoad: flags.maxLoad }
    const verdict = yield* checkFork({ list: listed.success, fork: fork.success, limits, lock: lockFile })
    for (const line of reportLines(listed.success, verdict, yield* rangeOf(fork.success))) yield* Console.log(line)
    const code = exitOf(verdict)
    if (code !== 0) return yield* new Exited({ code })
  }),
)

/** The checks' services on the host, over Bun's file system, path and process spawner. */
export const live = Layer.provideMerge(Layer.mergeAll(bunRunner, hostGauge, flockLock), BunServices.layer)

/** 0 for a success, the code an `Exited` failure carries, else 2 (a defect or an error the run printed). */
const exitCodeOf = <E, A>(exit: Exit.Exit<A, E>): number =>
  Exit.match(exit, {
    onSuccess: () => 0,
    onFailure: (cause) => Option.getOrElse(Option.map(Option.flatMap(Cause.findErrorOption(cause), decodeExited), (exited) => exited.code), () => 2),
  })

if (import.meta.main)
  BunRuntime.runMain(
    Command.run(command, { version: "1.0.0" }).pipe(
      Effect.tapError((error) => Option.match(decodeExited(error), { onNone: () => Console.error(`fork-checks: ${String(error)}`), onSome: () => Effect.void })),
      Effect.provide(live),
    ),
    { disableErrorReporting: true, teardown: (exit, onExit) => onExit(exitCodeOf(exit)) },
  )
