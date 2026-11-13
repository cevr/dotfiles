// `bun run accept`: the acceptance tests (tests/*.test.ts), most of which run
// real OpenCode from OPENCODE_DEV on a scripted model, without ANTHROPIC_BASE_URL.
// Each file is its own `bun test` in a process group of its own, so each has
// its own outcome, time and stop. Three runs over one ledger of passes
// (scripts/accept-ledger.ts), keyed on what each file reaches (scripts/reach.ts
// `acceptKey`), kept per host in ACCEPT_LEDGER (default ~/.cache/opencode-accept/passed.json):
//
// - `bun run accept:land [base]` (`accept:affected` is the same): the due land
//   files (a file is due when the ledger holds no pass with its current key
//   younger than 24 h; it is land unless it says `// accept: deep (` or
//   `// accept: one at a time`), those near the change since `base` first
//   (default: where HEAD left origin/main; `A..B` replays a range), each group
//   cheapest first. It ends within 60 s (ACCEPT_BUDGET_MS) of its start, the
//   lock wait aside: no file starts after 3/4 of it, the files still running at
//   5/6 are stopped with every process they started, and every due file not run
//   is owed, by name. A land file at or over its 20 s share on a quiet host fails the run.
// - `bun run accept:owed`: every due file, deep ones too, with no deadline.
// - `bun run accept`: every file, the ledger ignored; passes still recorded.
//
// The owed and full runs go in two phases (scripts/accept-plan.ts): a pool as
// wide as the cores the 1-minute load leaves free, then the files marked
// `// accept: one at a time`, one by one. A pass needs exit 0, no failed or
// skipped test (without OPENCODE_DEV the real-OpenCode tests skip: no pass), no
// leaked server and no bun test flags. The closing line accounts for every
// acceptance file: passed, failed, owed, or skipped as passed before.
//
// Usage: bun scripts/accept.ts [--land [base] | --owed] [--list] [--parallel=N] [tests/<name>.test.ts ...] [-- <bun test flags>]
// --list prints the run's due files and its closing line, without the lock;
// named acceptance files narrow the run to them (the others are owed).
//
// One run at a time per machine: a second one waits for the lock (ACCEPT_LOCK,
// default $TMPDIR/opencode-accept.lock), and the ledger is written only under it.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { $, type Subprocess } from "bun"
import { Console, Deferred, Effect, Option } from "effect"
import { listing, type Proc, servers, stop, survivors, table, watch, type Watch } from "./leaks.ts"
import { checkFork } from "./fork.ts"
import { heading, plan, poolWidth, requestedWidth, scenariosOf } from "./accept-plan.ts"
import * as Accept from "./accept-ledger.ts"
import { acceptanceTests, acceptKey, acceptReach, acceptSharedKey, load, packageOf, ROOT } from "./reach.ts"

const ENV = { ...process.env }
const ARGS = process.argv.slice(2)
const dash = ARGS.indexOf("--")
/** Flags after `--` go to every `bun test`; a run with any records no pass. */
const rest = ARGS.slice(dash + 1).filter(() => dash >= 0)
const own = (dash < 0 && ARGS) || ARGS.slice(0, dash)
const mode: Accept.Mode = ((own.includes("--land") || own.includes("--affected")) && "land") || (own.includes("--owed") && "owed") || "all"
const listOnly = own.includes("--list")
const window = (mode === "land" && Accept.windowOf(Number(ENV.ACCEPT_BUDGET_MS ?? Accept.BUDGET_MS))) || Accept.OPEN
const LEDGER = ENV.ACCEPT_LEDGER ?? path.join(os.homedir(), ".cache/opencode-accept/passed.json")
const LOCK = ENV.ACCEPT_LOCK ?? path.join(os.tmpdir(), "opencode-accept.lock")
/** Where each file's junit report goes. */
const REPORTS = path.join(os.tmpdir(), `opencode-accept-${process.pid}`)
const cores = os.availableParallelism()
const load1 = () => Option.getOrElse(Option.fromUndefinedOr(os.loadavg()[0]), () => 0)

/** How long this run waited for the lock: off its clock. */
let waited = 0
/** The run's clock: ms since the process started, less the lock wait. */
const elapsed = () => performance.now() - waited
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`

const say = (...lines: ReadonlyArray<string>) => Effect.when(Console.log(lines.join("\n")), Effect.sync(() => lines.length > 0))

const disk: Accept.Disk = {
  read: (file) => Option.map(Option.liftPredicate(file, existsSync), (found) => readFileSync(found, "utf8")),
  write: (file, text) => {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, text)
  },
  rename: renameSync,
}

/** What the whole run shares once its files are chosen. */
interface Run {
  readonly files: ReadonlyArray<string>
  readonly text: (file: string) => string
  readonly reached: ReadonlyMap<string, ReadonlySet<string>>
  readonly keys: ReadonlyMap<string, string>
  readonly tiers: ReadonlyMap<string, Accept.Tier>
  readonly selection: Accept.Selection
  /** The ledger as this run has written it. */
  ledger: Accept.Ledger
  readonly timed: Array<Accept.Timed>
  readonly loads: Array<number>
  /** Done when a signal asks the run to stop. */
  readonly signalled: Deferred.Deferred<boolean>
}

/** A file's `bun test` while it runs. */
interface Running {
  readonly file: string
  readonly child: Subprocess<"ignore", "pipe", "pipe">
  readonly watching: Watch
}

/** The acceptance files: tests/*.test.ts, or ACCEPT_FILES (a glob, for the runner's own test's stand-ins). */
const filesOf = (all: ReadonlyArray<string>) =>
  Option.match(Option.fromUndefinedOr(ENV.ACCEPT_FILES), {
    onNone: () => all,
    onSome: (glob) => {
      const { dir, rest: pattern } = Accept.globRoot(path.resolve(ROOT, glob))
      return [...new Bun.Glob(pattern).scanSync({ cwd: dir })].map((file) => path.join(dir, file)).sort()
    },
  })

const prepare = Effect.fn("Accept.prepare")(function* () {
  const workspace = yield* Effect.promise(load)
  const files = filesOf(acceptanceTests(workspace))
  const text = (file: string) => readFileSync(path.resolve(ROOT, file), "utf8")
  const signalled = yield* Deferred.make<boolean>()
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => Effect.runFork(Deferred.succeed(signalled, true)))
  if (!listOnly && !(yield* takeLock(signalled))) return Option.none<Run>()
  const read = Accept.readLedger(disk, LEDGER)
  if (Option.isSome(read.problem)) yield* Console.error(`accept: ${read.problem.value}`)
  const shared = yield* Effect.promise(() => acceptSharedKey([`accept-ledger:${Accept.KEY_VERSION}`, "bun test --timeout 300000"]))
  const memo = new Map<string, ReadonlyArray<string>>()
  const reached = new Map(files.map((file) => [file, acceptReach(workspace, file, memo)]))
  const keys = new Map(files.map((file) => [file, acceptKey(shared, reached.get(file) ?? [file])]))
  const tiers = new Map(files.map((file) => [file, Accept.tierOf(text(file))]))
  const candidates = files.map((file) => ({ file, tier: tiers.get(file) ?? "land", key: keys.get(file) ?? "" }))
  const named = own.filter((arg) => files.includes(arg))
  const selection = Accept.select(mode, candidates, read.ledger, Date.now(), named)
  const run: Run = { files, text, reached, keys, tiers, selection, ledger: read.ledger, timed: [], loads: [load1()], signalled }
  return Option.some(run)
})

/** A land run: the due land files, near the change first, under the window. */
const land = Effect.fn("Accept.land")(function* (run: Run) {
  const changed = yield* changedSince()
  const near = new Set(
    run.selection.run.filter((file) => {
      const text = run.text(file)
      const driven = scenariosOf(text).filter((scenario) => existsSync(path.join(ROOT, scenario))).map(run.text)
      return Accept.isNear([text, ...driven], run.reached.get(file) ?? new Set(), changed, (each) => Option.fromUndefinedOr(packageOf(each)))
    }),
  )
  const estimate = (file: string) => Accept.estimate(run.ledger, file)
  const order = Accept.landOrder(run.selection.run, near, estimate)
  const width = Accept.landWidth(cores, run.loads[0] ?? 0, requested())
  yield* say(
    `accept: land: ${order.length} due land files (${near.size} near the ${changed.length} files changed), ${width} at a time (${cores} cores, 1-minute load ${(run.loads[0] ?? 0).toFixed(1)}); no start after ${seconds(window.startBy)}, stop at ${seconds(window.stopAt)}`,
  )
  if (!listOnly) return yield* pool(run, order, width)
  const played = Accept.simulate(order, estimate, width, window, elapsed())
  yield* say(...played.ran.map((slot) => `  due: ${slot.file} (would ${(slot.stopped && "be stopped") || "run"}, est ${seconds(estimate(slot.file))})`))
  yield* say(...played.unstarted.map((file) => `  due: ${file} (past the budget, est ${seconds(estimate(file))})`))
  return order.map(listed)
})

const listed = (file: string): Accept.Outcome => ({ file, status: "owed", why: "listed", detail: "" })

/** An owed or full run: the pool, then the one-at-a-time files. */
const phases = Effect.fn("Accept.phases")(function* (run: Run) {
  const outcomes: Array<Accept.Outcome> = []
  for (const step of plan(run.selection.run, run.text, poolWidth(cores, run.loads[0] ?? 0, requested()))) {
    yield* say(heading(step, cores, run.loads[0] ?? 0))
    if (listOnly) {
      yield* say(...step.files.map((file) => `  due: ${file}`))
      outcomes.push(...step.files.map(listed))
    } else outcomes.push(...(yield* pool(run, step.files, step.width)))
  }
  return outcomes
})

const requested = () => {
  const width = requestedWidth(own)
  return (width.ok && width.width) || Option.none()
}

/** The base a land run orders by: the argument after --land/--affected, else where HEAD left origin/main. */
const baseOf = () => {
  const flag = own.findIndex((arg) => arg === "--land" || arg === "--affected")
  const given = Option.liftPredicate(own[flag + 1] ?? "--", (arg) => !arg.startsWith("--") && !arg.endsWith(".test.ts"))
  return Option.match(given, {
    onSome: Effect.succeed,
    onNone: () => Effect.map(git(["merge-base", "HEAD", "origin/main"]), (base) => base.trim() || "HEAD"),
  })
}

/** A git command's output in ROOT; empty when it fails. */
const git = (args: ReadonlyArray<string>) => Effect.promise(() => $`git ${args}`.cwd(ROOT).quiet().nothrow().text())

/** The files changed since the base (committed or not, untracked too), or in the range `A..B`. */
const changedSince = Effect.fn("Accept.changedSince")(function* () {
  const base = yield* baseOf()
  const diff = yield* git(["diff", "--name-only", "--relative", base])
  const untracked = (!base.includes("..") && (yield* git(["ls-files", "--others", "--exclude-standard"]))) || ""
  return [...new Set([...diff.split("\n"), ...untracked.split("\n")].filter(Boolean))]
})

/** Runs `order` `width` at a time under the window: a file starts only before its start bound, and is stopped at the stop bound or a signal. */
const pool = (run: Run, order: ReadonlyArray<string>, width: number) =>
  Effect.forEach(
    order,
    (file) =>
      Effect.suspend(() => {
        if (Deferred.isDoneUnsafe(run.signalled)) return Effect.succeed(Accept.owe(file, "signal", "not started"))
        if (!Accept.canStart(window, elapsed())) return Effect.succeed(Accept.owe(file, "budget", "not started"))
        return runFile(run, file)
      }),
    { concurrency: width },
  )

const stopped = (why: Accept.Why): Ended => ({ why: Option.some(why), code: 1, output: "" })

/** How a file's `bun test` ended: run to its exit (with its code and output), or stopped, and why. */
interface Ended {
  readonly why: Option.Option<Accept.Why>
  readonly code: number
  readonly output: string
}

/** What stops a running file: a signal, or the window's stop bound. */
const stopper = (run: Run) =>
  Effect.raceFirst(
    Effect.as(Deferred.await(run.signalled), stopped("signal")),
    Effect.as(Effect.suspend(() => (Number.isFinite(window.stopAt) && Effect.sleep(Math.max(0, window.stopAt - elapsed()))) || Effect.never), stopped("budget")),
  )

/** Waits for a file's `bun test` to exit, with its output. */
const exited = (running: Running) =>
  Effect.map(
    Effect.all([Effect.promise(() => new Response(running.child.stdout).text()), Effect.promise(() => new Response(running.child.stderr).text()), Effect.promise(() => running.child.exited)], {
      concurrency: 3,
    }),
    ([out, err, code]): Ended => ({ why: Option.none(), code, output: `${out}${err}`.trimEnd() }),
  )

/** One file's `bun test`, its leak check and its outcome; a stopped one is owed. */
const runFile = Effect.fn("Accept.runFile")(function* (run: Run, file: string) {
  const began = elapsed()
  const report = path.join(REPORTS, `${Bun.hash(file).toString(36)}.xml`)
  const running = start(file, report)
  const ended = yield* Effect.raceFirst(exited(running), stopper(run))
  const ms = elapsed() - began
  run.timed.push({ file, tier: run.tiers.get(file) ?? "land", ms })
  if (Option.isSome(ended.why)) {
    yield* stopRun(running)
    yield* say(`accept: stopped ${file} after ${seconds(ms)}`)
    return Accept.owe(file, ended.why.value, `stopped after ${seconds(ms)}`)
  }
  const leakedAny = yield* leaked(running.watching.stop(), Accept.leakGrace(window, elapsed()))
  const outcome = Accept.verdict({ file, code: ended.code, report: Accept.parseReport(Option.getOrElse(disk.read(report), () => "")), leaked: leakedAny, ms, recordable: rest.length === 0 })
  if (outcome.status === "failed") yield* say(ended.output, `accept: failed ${file} in ${seconds(ms)}: ${outcome.reason}`)
  else yield* say(`accept: ${outcome.status} ${file} in ${seconds(ms)}`)
  settle(run, outcome)
  return outcome
})

/** Starts a file's `bun test` in a process group of its own and watches what it starts. */
const start = (file: string, report: string): Running => {
  mkdirSync(REPORTS, { recursive: true })
  const env = Object.fromEntries(Object.entries(ENV).filter(([name]) => name !== "ANTHROPIC_BASE_URL" && !name.startsWith("ACCEPT_")))
  const target = (path.isAbsolute(file) && file) || `./${file}`
  const child = Bun.spawn([process.execPath, "test", "--timeout", "300000", "--reporter=junit", `--reporter-outfile=${report}`, ...rest, target], {
    cwd: ROOT,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  })
  return { file, child, watching: watch(child.pid, 1000, sampled) }
}

/** Records an outcome and writes the ledger whole when it changed it. */
const settle = (run: Run, outcome: Accept.Outcome) => {
  const next = Accept.record(run.ledger, outcome, run.keys.get(outcome.file) ?? "", Date.now())
  if (next === run.ledger) return
  run.ledger = next
  Accept.writeLedger(disk, LEDGER, process.pid, next)
}

/** One process table read shared by every watch within half a second. */
const sampled = (() => {
  let rows: ReadonlyArray<Proc> = []
  let at = Number.NEGATIVE_INFINITY
  return () => {
    if (elapsed() - at > 500) {
      rows = table()
      at = elapsed()
    }
    return rows
  }
})()

/** Stops a running file: its group while its `bun test` lives, then every process it started that still runs, by the pid its watch saw. */
const stopRun = (running: Running) =>
  Effect.gen(function* () {
    signalRun(running, "SIGTERM")
    // A test's own process groups (its servers, its drive runs) are outside the run's.
    yield* Effect.promise(() => stop(survivors(running.watching.stop(), table())))
    signalRun(running, "SIGKILL")
  })

/** Signals a file's process group, only while its leader, the `bun test` this run started, has not exited. */
const signalRun = (running: Running, name: NodeJS.Signals) => {
  if (Number.isInteger(running.child.exitCode) || Boolean(running.child.signalCode)) return
  try {
    process.kill(-running.child.pid, name)
  } catch {
    // The group ended in between.
  }
}

/** Whether a finished file left a server or drive run behind; stops those and names every survivor. */
const leaked = Effect.fn("Accept.leaked")(function* (seen: ReadonlyArray<Proc>, graceMs: number) {
  // A test's teardown may still be ending what it started.
  const deadline = elapsed() + graceMs
  let left = survivors(seen, table())
  while (left.length > 0 && elapsed() < deadline) {
    yield* Effect.sleep(250)
    left = survivors(seen, table())
  }
  const strays = servers(left)
  const others = left.filter((proc) => !strays.includes(proc))
  if (others.length > 0) yield* Console.warn(`accept: ${others.length} test processes outlived the run:\n${listing(others)}`)
  if (strays.length === 0) return false
  yield* Console.error(`accept: the run leaked ${strays.length} OpenCode servers or drive runs; stopping them:\n${listing(strays)}`)
  yield* Effect.promise(() => stop(strays))
  return true
})

/** Prints the shares and the closing line; the run's exit code. */
const finish = Effect.fn("Accept.finish")(function* (run: Run, outcomes: ReadonlyArray<Accept.Outcome>) {
  run.loads.push(load1())
  const quiet = Accept.isQuiet(cores, run.loads)
  const judged = Accept.shares(mode, run.timed, quiet)
  yield* say(...judged.reported)
  if (judged.broken.length > 0) yield* Console.error(judged.broken.join("\n"))
  if (!quiet && mode === "land" && !listOnly)
    yield* say(`accept: the host is loaded (1-minute load ${run.loads.map((each) => each.toFixed(1)).join(" at the start, ")} at the end, ${cores} cores): land shares reported, not judged`)
  yield* say(...Accept.closing(mode, [...run.selection.settled, ...outcomes], elapsed() / 1000))
  rmSync(REPORTS, { recursive: true, force: true })
  if (Deferred.isDoneUnsafe(run.signalled)) return 130
  return Accept.exitOf(outcomes, judged.broken)
})

/** Waits for the machine's accept lock; the wait is printed and kept off the run's clock. */
const takeLock = Effect.fn("Accept.takeLock")(function* (signalled: Deferred.Deferred<boolean>) {
  const from = performance.now()
  let told = false
  while (!claim()) {
    if (Deferred.isDoneUnsafe(signalled)) {
      yield* Console.error("accept: stopped by a signal while it waited for the lock; it ran nothing, so every due file is still owed")
      return false
    }
    const owner = holder()
    if (Option.isSome(owner) && !alive(owner.value.pid)) {
      rmSync(LOCK, { recursive: true, force: true })
      continue
    }
    if (!told) yield* say(`accept: waiting for the run in ${Option.getOrElse(Option.map(owner, (each) => each.root), () => "another checkout")} (one at a time per machine)`)
    told = true
    yield* Effect.sleep(2000)
  }
  waited = performance.now() - from
  yield* say(`accept: waited ${seconds(waited)} for the lock (off the run's clock)`)
  process.on("exit", release)
  return true
})

/** Takes the lock when it is free. */
const claim = () =>
  Effect.runSync(
    Effect.match(
      Effect.try(() => {
        mkdirSync(LOCK)
        writeFileSync(path.join(LOCK, "owner.json"), Accept.encodeOwner({ pid: process.pid, root: ROOT }))
      }),
      { onFailure: () => false, onSuccess: () => true },
    ),
  )

const holder = () => Option.flatMap(disk.read(path.join(LOCK, "owner.json")), Accept.decodeOwner)

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const release = () => {
  if (Option.exists(holder(), (owner) => owner.pid === process.pid)) rmSync(LOCK, { recursive: true, force: true })
}

const main = Effect.fn("Accept.main")(function* () {
  const requestedOk = requestedWidth(own)
  if (!requestedOk.ok) return yield* refuse(requestedOk.problem)
  if (!ENV.OPENCODE_DEV) yield* say("accept: OPENCODE_DEV is not set, so the real-OpenCode tests skip and record no pass. Point it at the fork.")
  else {
    // A fork that is not installed here would fail every real-OpenCode test for a reason none of them names.
    const checked = checkFork(ENV.OPENCODE_DEV)
    if ("problem" in checked) return yield* refuse(checked.problem)
  }
  const prepared = yield* prepare()
  if (Option.isNone(prepared)) return 130
  const run = prepared.value
  const outcomes = yield* Effect.suspend(() => (mode === "land" && land(run)) || phases(run))
  return yield* finish(run, outcomes)
})

/** Ends the run before it starts, naming why. */
const refuse = (problem: string) => Effect.as(Console.error(`accept: ${problem}`), 1)

const code = await Effect.runPromise(main())
process.exit(code)
