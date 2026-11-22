// The fork's feature checks (scripts/fork-checks.ts): the declared list parses and resolves at the fork, a red
// test, a lost file and a run that could not finish each hold the merge, and an expectation holds only on the
// host it declares. The upstream merge cases run the real CLI, through the argv `forkChecks` runs, on a fake fork
// whose origin and upstream are local bare repositories: nothing is pushed anywhere else.
// @reads scripts/fork-checks.json
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, realpathSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { Array as Arr, Effect, Option, Result } from "effect"
import { DEFAULT_FORK } from "../testbeds/gamut/gamut.ts"
import { gitClone, gitInit } from "../tests/git-repo.ts"
import { scratch } from "../tests/scratch.ts"
import {
  casesOf,
  checkFork,
  declaredList,
  featureCheckArgv,
  type Host,
  type Input,
  judge,
  LIMITS,
  type List,
  listProblems,
  missingFiles,
  type Plan,
  plansOf,
  type Ran,
  type Run,
  type Verdict,
} from "./fork-checks.ts"
import { ROOT } from "./reach.ts"
import { type CheckResult, mergeUpstream, unlocked } from "./upstream.ts"

const list = (): List => Result.getOrThrow(declaredList)

const COMPOUND = "real-shell compound syntax > bash: printf '%s' \"$(probe() case value in value) scan_probe;; *) scan_other;; esac; probe)\""

describe("the declared list", () => {
  test("parses, has no problems, names the request that proved each feature, and every file is in the fork", () => {
    const declared = list()
    expect(listProblems(declared)).toEqual([])
    expect(declared.features.every((feature) => feature.proved.length > 0)).toBe(true)
    const fork = Option.getOrElse(Option.fromNullishOr(process.env.OPENCODE_DEV), () => DEFAULT_FORK)
    expect(missingFiles(declared, fork)).toEqual([])
    // The bash 3.2 expectation names a test the list runs.
    expect(declared.expectations.map((each) => each.test)).toContain(COMPOUND)
  })

  test("a file the fork lacks is named (red control)", () => {
    using dir = scratch("fork-checks-missing-")
    mkdirSync(join(dir.path, "packages/x/test"), { recursive: true })
    writeFileSync(join(dir.path, "packages/x/test/a.test.ts"), "")
    const one: List = { ...list(), features: [{ id: "x", feature: "x", package: "packages/x", files: ["test/a.test.ts", "test/gone.test.ts"], proved: "here" }], expectations: [] }
    expect(missingFiles(one, dir.path)).toEqual([{ package: "packages/x", file: "test/gone.test.ts", test: "", why: "the listed file is not in the fork" }])
  })

  test("names a package with no command, a twice-listed id and an expectation on an unlisted file", () => {
    const feature = { id: "x", feature: "x", package: "packages/none", files: ["test/a.test.ts"] as const, proved: "here" }
    const bad: List = { ...list(), features: [feature, { ...feature, package: "packages/core" }], expectations: [{ package: "packages/core", file: "test/b.test.ts", test: "t", host: { bash: "3.2.57" }, reason: "r" }] }
    expect(listProblems(bad)).toEqual(["x: package packages/none has no command", "x: the id is listed twice", 'expectation "t": packages/core/test/b.test.ts is in no feature'])
  })
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

describe("reading a report", () => {
  test("gives each test its describe blocks, its file and whether it failed", () => {
    expect(casesOf(junit("test/a.test.ts", [["real-shell compound syntax", "bash: printf '%s' \"$(probe() case value in value) scan_probe;; *) scan_other;; esac; probe)\"", true], ["", "top", false]]))).toEqual([
      { file: "test/a.test.ts", test: COMPOUND, failed: true },
      { file: "test/a.test.ts", test: "top", failed: false },
    ])
  })
})

describe("an expectation", () => {
  const compound = list().expectations[0]
  const plan = (bash: string): Plan => plansOf(list(), Option.some(bash)).find((each) => each.package === "packages/core") ?? { package: "", files: [], expected: [] }
  const file = "test/shell-scan/compound-parity.test.ts"
  const others = (each: Plan) => each.files.filter((name) => name !== file).map((name) => ({ file: name, test: "passes", failed: false }))
  const run = (each: Plan, failed: boolean) => [...others(each), ...casesOf(junit(file, [["real-shell compound syntax", COMPOUND.split(" > ")[1] ?? "", failed]]))]

  test("on the declared bash (3.2.57), its test failing is a note, not a red", () => {
    const judged = judge(plan("3.2.57"), 1, run(plan("3.2.57"), true))
    expect(judged.reds).toEqual([])
    expect(judged.notes).toEqual([`expected red on bash 3.2.57: packages/core/${file} > ${COMPOUND} (${compound?.reason})`])
  })

  test("on any other bash the same failure is red (red control)", () => {
    expect(plan("5.2.37").expected).toEqual([])
    expect(judge(plan("5.2.37"), 1, run(plan("5.2.37"), true)).reds).toEqual([{ package: "packages/core", file, test: COMPOUND, why: "failed" }])
    expect(plansOf(list(), Option.none()).every((each) => each.expected.length === 0)).toBe(true)
  })

  test("its test passing on the declared bash is red: a stale expectation cannot stay", () => {
    expect(judge(plan("3.2.57"), 0, run(plan("3.2.57"), false)).reds).toEqual([
      { package: "packages/core", file, test: COMPOUND, why: "declared red on bash 3.2.57 but it passed: remove the expectation" },
    ])
  })

  test("its test gone from the run on the declared bash is red", () => {
    expect(judge(plan("3.2.57"), 0, [...others(plan("3.2.57")), { file, test: "another", failed: false }]).reds).toEqual([
      { package: "packages/core", file, test: COMPOUND, why: "declared red on bash 3.2.57 but it did not run: the expectation names a test that is gone" },
    ])
  })
})

describe("judging a run", () => {
  const plan: Plan = { package: "packages/x", files: ["test/a.test.ts", "test/b.test.ts"], expected: [] }
  test("a listed file absent from the report ran no test, and is red", () => {
    expect(judge(plan, 1, [{ file: "test/a.test.ts", test: "t", failed: false }]).reds).toEqual([{ package: "packages/x", file: "test/b.test.ts", test: "", why: "the file ran no test (it did not load, or holds none)" }])
  })
  test("a red exit with every test green is red", () => {
    const cases = plan.files.map((file) => ({ file, test: "t", failed: false }))
    expect(judge(plan, 0, cases).reds).toEqual([])
    expect(judge(plan, 1, cases).reds).toEqual([{ package: "packages/x", file: "(the run)", test: "", why: "bun test exited 1 with no failed test" }])
  })
})

/** A fake host on a clock that sleeping advances. */
const fakeHost = (over: Partial<Host> = {}): Host => {
  let clock = 0
  return {
    bash: Option.some("5.2.37"),
    floored: true,
    load: () => 3,
    freeBytes: () => 100 * 2 ** 30,
    now: () => clock,
    sleep: (ms) =>
      Effect.sync(() => {
        clock += ms
      }),
    ...over,
  }
}

/** A one-package list over `files`, all in a scratch fork that has them. */
const fakeFork = (dir: string, files: ReadonlyArray<string>): List => {
  for (const file of files) {
    mkdirSync(join(dir, "packages/x", file, ".."), { recursive: true })
    writeFileSync(join(dir, "packages/x", file), "")
  }
  return { about: "", packages: { "packages/x": ["bun", "test"] }, features: [{ id: "x", feature: "x", package: "packages/x", files: [files[0] ?? "", ...files.slice(1)], proved: "here" }], expectations: [] }
}

/** A runner whose answers follow `answers`, one per run, recording each run. */
const fakeRunner = (answers: ReadonlyArray<(run: Run) => Ran>) => {
  const runs: Array<Run> = []
  return {
    runs,
    runner: (run: Run) =>
      Effect.sync(() => {
        runs.push(run)
        return (answers[runs.length - 1] ?? answers[answers.length - 1] ?? (() => ({ kind: "timed-out", log: "" })))(run)
      }),
  }
}

const report = (run: Run, failing: ReadonlyArray<string> = []): Ran => ({
  kind: "exited",
  code: Number(failing.length > 0),
  log: "log",
  junit: Option.some(run.files.map((file) => junit(file, [["", "t", failing.includes(file)]])).join("\n")),
})

const inputOf = (dir: string, files: ReadonlyArray<string>, over: Partial<Input>): Input => ({
  list: fakeFork(dir, files),
  fork: dir,
  host: fakeHost(),
  runner: fakeRunner([(run) => report(run)]).runner,
  lock: (run) => Effect.map(run, Option.some),
  limits: LIMITS,
  say: () => {},
  ...over,
})

const check = (input: Input): Promise<Verdict> => Effect.runPromise(checkFork(input))

describe("a run of the checks", () => {
  test("green: one run of the package, niced width 4, its files in list order", async () => {
    using dir = scratch("fork-checks-green-")
    const fake = fakeRunner([(run) => report(run)])
    expect(await check(inputOf(dir.path, ["test/a.test.ts", "test/b.test.ts"], { runner: fake.runner }))).toEqual({ kind: "green", notes: [] })
    expect(fake.runs.map((run) => [run.cwd, run.files, run.threads])).toEqual([[join(dir.path, "packages/x"), ["test/a.test.ts", "test/b.test.ts"], 4]])
  })

  test("a file red twice is red; a file green on its rerun is a named flake", async () => {
    using dir = scratch("fork-checks-rerun-")
    const twice = fakeRunner([(run) => report(run, ["test/b.test.ts"])])
    const red = await check(inputOf(dir.path, ["test/a.test.ts", "test/b.test.ts"], { runner: twice.runner }))
    expect(red).toMatchObject({ kind: "red", reds: [{ package: "packages/x", file: "test/b.test.ts", test: "t", why: "failed" }] })
    expect(twice.runs.map((run) => run.files)).toEqual([["test/a.test.ts", "test/b.test.ts"], ["test/b.test.ts"]])
    const once = fakeRunner([(run) => report(run, ["test/b.test.ts"]), (run) => report(run)])
    expect(await check(inputOf(dir.path, ["test/a.test.ts", "test/b.test.ts"], { runner: once.runner }))).toEqual({ kind: "green", notes: ["flaky, green on the rerun: packages/x/test/b.test.ts"] })
  })

  test("a missing file is red before anything runs", async () => {
    using dir = scratch("fork-checks-lost-")
    const fake = fakeRunner([(run) => report(run)])
    const input = inputOf(dir.path, ["test/a.test.ts"], { runner: fake.runner })
    const lost: List = { ...input.list, features: [{ ...input.list.features[0], id: "x", feature: "x", package: "packages/x", files: ["test/a.test.ts", "test/gone.test.ts"], proved: "here" }] }
    expect(await check({ ...input, list: lost })).toMatchObject({ kind: "red", reds: [{ file: "test/gone.test.ts" }] })
    expect(fake.runs).toEqual([])
  })

  test("could not run: the load stays over 24 for 30 min, and nothing runs", async () => {
    using dir = scratch("fork-checks-load-")
    const fake = fakeRunner([(run) => report(run)])
    const verdict = await check(inputOf(dir.path, ["test/a.test.ts"], { runner: fake.runner, host: fakeHost({ load: () => 30 }) }))
    expect(verdict).toMatchObject({ kind: "could-not-run", reason: expect.stringContaining("load stayed over 24 for 30 min") })
    expect(fake.runs).toEqual([])
  })

  test("waits while the load is over 24, then runs", async () => {
    using dir = scratch("fork-checks-wait-")
    const loads = [30, 25, 12]
    let read = 0
    const host = fakeHost({ load: () => loads[Math.min(read++, loads.length - 1)] ?? 0 })
    expect(await check(inputOf(dir.path, ["test/a.test.ts"], { host }))).toEqual({ kind: "green", notes: [] })
    expect(host.now()).toBe(2 * LIMITS.everyMs)
  })

  test("could not run: under 6 GiB free where the floor applies (the Mac), and not elsewhere", async () => {
    using dir = scratch("fork-checks-disk-")
    const low = { freeBytes: () => 5 * 2 ** 30 }
    expect(await check(inputOf(dir.path, ["test/a.test.ts"], { host: fakeHost(low) }))).toMatchObject({ kind: "could-not-run", reason: expect.stringContaining("5.0 GiB free") })
    expect(await check(inputOf(dir.path, ["test/a.test.ts"], { host: fakeHost({ ...low, floored: false }) }))).toEqual({ kind: "green", notes: [] })
  })

  test("could not run: another run holds the lock past the wait", async () => {
    using dir = scratch("fork-checks-lock-")
    const fake = fakeRunner([(run) => report(run)])
    const verdict = await check(inputOf(dir.path, ["test/a.test.ts"], { runner: fake.runner, lock: () => Effect.succeed(Option.none()) }))
    expect(verdict).toMatchObject({ kind: "could-not-run", reason: expect.stringContaining("held the host's lock") })
    expect(fake.runs).toEqual([])
  })

  test("could not run: the run passes the time bound, or writes no report", async () => {
    using dir = scratch("fork-checks-bound-")
    const timedOut = fakeRunner([() => ({ kind: "timed-out", log: "still going" })])
    expect(await check(inputOf(dir.path, ["test/a.test.ts"], { runner: timedOut.runner }))).toMatchObject({ kind: "could-not-run", reason: expect.stringContaining("ran past the time bound") })
    expect(timedOut.runs[0]?.timeoutMs).toBe(LIMITS.timeBoundMs)
    const silent = fakeRunner([() => ({ kind: "exited", code: 1, log: "error: no node_modules", junit: Option.none() })])
    expect(await check(inputOf(dir.path, ["test/a.test.ts"], { runner: silent.runner }))).toMatchObject({ kind: "could-not-run", reason: expect.stringContaining("wrote no report") })
  })
})

describe("the upstream merge with the fork's feature checks", () => {
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "fork checks test",
    GIT_AUTHOR_EMAIL: "fork-checks@test.invalid",
    GIT_COMMITTER_NAME: "fork checks test",
    GIT_COMMITTER_EMAIL: "fork-checks@test.invalid",
  }
  const git = (dir: string, ...args: ReadonlyArray<string>) => {
    const ran = Bun.spawnSync(["git", "-C", dir, ...args], { env, stdout: "pipe", stderr: "pipe" })
    if (ran.exitCode !== 0) expect(`git ${args.join(" ")}: ${ran.stderr.toString()}`).toBe("")
    return ran.stdout.toString().trim()
  }

  /** A fake fork (origin and upstream bare, the fork cloned with prime-look), a package of real tests, upstream one commit ahead. */
  const fixture = (dir: string, command: ReadonlyArray<string>, files: ReadonlyArray<string>) => {
    const root = realpathSync(dir)
    const upstream = join(root, "upstream.git")
    const origin = join(root, "origin.git")
    const seed = join(root, "seed")
    gitInit(upstream, ["--quiet", "--bare"], env)
    gitInit(origin, ["--quiet", "--bare"], env)
    gitInit(seed, ["--quiet", "-b", "dev"], env)
    mkdirSync(join(seed, "packages/x/test"), { recursive: true })
    writeFileSync(join(seed, "packages/x/test/green.test.ts"), 'import { expect, test } from "bun:test"\ntest("passes", () => expect(1).toBe(1))\n')
    writeFileSync(join(seed, "packages/x/test/red.test.ts"), 'import { expect, test } from "bun:test"\ntest("the fork feature", () => expect("<background-result>").toContain("<shell"))\n')
    git(seed, "add", "-A")
    git(seed, "commit", "--quiet", "-m", "root")
    git(seed, "push", "--quiet", upstream, "dev")
    // A fork commit on origin, so the merge is a real merge (two parents), as the daily's is.
    git(seed, "checkout", "--quiet", "-b", "ours")
    writeFileSync(join(seed, "ours.txt"), "ours\n")
    git(seed, "add", "-A")
    git(seed, "commit", "--quiet", "-m", "fork change")
    git(seed, "push", "--quiet", origin, "ours:prime-look")
    git(seed, "checkout", "--quiet", "dev")
    writeFileSync(join(seed, "upstream.txt"), "upstream\n")
    git(seed, "add", "-A")
    git(seed, "commit", "--quiet", "-m", "upstream change")
    git(seed, "push", "--quiet", upstream, "dev")
    const fork = join(root, "fork")
    gitClone(origin, fork, ["--quiet", "--branch", "prime-look"], env)
    git(fork, "remote", "add", "upstream", upstream)
    const listFile = join(root, "list.json")
    const listed: List = { about: "test", packages: { "packages/x": [command[0] ?? "bun", ...command.slice(1)] }, features: [{ id: "x", feature: "the fork feature", package: "packages/x", files: [files[0] ?? "", ...files.slice(1)], proved: "here" }], expectations: [] }
    writeFileSync(listFile, JSON.stringify(listed))
    const lock = join(root, "fork-checks.flock")
    /** forkChecks's step: the CLI by `featureCheckArgv`, red on a non-zero exit, its output the log. */
    const checks = (merged: string): Promise<CheckResult> =>
      Effect.runPromise(
        Effect.sync((): CheckResult => {
          const ran = Bun.spawnSync([...featureCheckArgv(ROOT, merged, ["--list", listFile, "--max-load", "1000", "--lock", lock])], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" })
          if (ran.exitCode === 0) return { ok: true }
          return { ok: false, check: "fork feature checks (scripts/fork-checks.ts)", log: `${ran.stdout.toString()}\n${ran.stderr.toString()}` }
        }),
      )
    const report = join(root, "state/upstream-conflict.md")
    const merge = () =>
      mergeUpstream({ fork, host: "Cristians-MacBook-Pro.local", skip: false, dryRun: false, checks, landing: unlocked, worktree: join(root, "state/upstream-merge"), report, log: () => {}, env })
    return { fork, origin, report, merge, before: git(fork, "rev-parse", "prime-look"), head: (repo: string) => git(repo, "rev-parse", "prime-look") }
  }

  test("green checks: the merge goes to origin (control)", async () => {
    using dir = scratch("fork-checks-merge-green-")
    const f = fixture(dir.path, ["bun", "test"], ["test/green.test.ts"])
    expect(await f.merge()).toMatchObject({ kind: "merged" })
    expect(f.head(f.origin)).not.toBe(f.before)
  })

  test("a red test holds the push, and the report names the test and the upstream range", async () => {
    using dir = scratch("fork-checks-merge-red-")
    const f = fixture(dir.path, ["bun", "test"], ["test/green.test.ts", "test/red.test.ts"])
    expect(await f.merge()).toMatchObject({ kind: "red", check: "fork feature checks (scripts/fork-checks.ts)" })
    expect(f.head(f.origin)).toBe(f.before)
    expect(f.head(f.fork)).toBe(f.before)
    const text = readFileSync(f.report, "utf8")
    expect(text).toContain("# Upstream merge is red: fork feature checks")
    expect(text).toContain("fork-checks: RED over merge ")
    expect(text).toContain("packages/x/test/red.test.ts > the fork feature [x]")
    expect(text).toMatch(/Upstream commits it brings: `git log [0-9a-f]{10}\.\.[0-9a-f]{10}` \(1 commit\)/)
  }, 30_000)

  test("a listed file the merge lacks holds the push", async () => {
    using dir = scratch("fork-checks-merge-lost-")
    const f = fixture(dir.path, ["bun", "test"], ["test/green.test.ts", "test/gone.test.ts"])
    expect(await f.merge()).toMatchObject({ kind: "red" })
    expect(f.head(f.origin)).toBe(f.before)
    expect(readFileSync(f.report, "utf8")).toContain("packages/x/test/gone.test.ts [x]: the listed file is not in the fork")
  })

  test("a run that could not finish holds the push", async () => {
    using dir = scratch("fork-checks-merge-cannot-")
    // A package command that writes no report: the run could not be judged.
    const f = fixture(dir.path, ["false"], ["test/green.test.ts"])
    expect(await f.merge()).toMatchObject({ kind: "red" })
    expect(f.head(f.origin)).toBe(f.before)
    expect(readFileSync(f.report, "utf8")).toContain("fork-checks: COULD NOT RUN")
    expect(existsSync(join(f.fork, "upstream.txt"))).toBe(false)
  })
})
