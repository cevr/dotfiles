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
//   cheapest first. It ends within 60 s (ACCEPT_BUDGET_MS) of its process's
//   start, the wait behind a yielding deep run included: no file starts after
//   3/4 of it, the files still running at 5/6 are stopped with every process
//   they started, and every due file not run is owed, by name. A land file at
//   or over its 20 s share on a quiet host fails the run.
// - `bun run accept:owed`: every due file, deep ones too, with no deadline. The
//   files that bound a time (`// accept: one at a time`) stay owed, `waits for a
//   settled host`, unless `--settled` is given. A file that fails (not by a
//   leak) runs once more, alone, at the end: a pass then is `passed on its
//   second run`, named.
// - `bun run accept`: every file, the ledger ignored; passes still recorded.
//
// The owed and full runs go in two phases (scripts/accept-plan.ts): a pool as
// wide as the cores the 1-minute load leaves free (or `--parallel=N`), then the
// files marked `// accept: one at a time`, one by one. A pass needs exit 0, no
// failed test, no skip but declared ones, no leaked server and no bun test
// flags. The closing line accounts for every acceptance file: passed, failed,
// owed, or skipped as passed before. Each run's output goes to a log per file
// (ACCEPT_LOGS, default ~/.cache/opencode-accept/logs/<head, 12 hex>/, the newest
// 5 heads kept); `--json <file>` writes the outcome for the post-land step.
//
// Usage: bun scripts/accept.ts [--land [base] | --owed [--settled]] [--list] [--parallel=N] [--json <file>] [tests/<name>.test.ts ...] [-- <bun test flags>]
// --list prints the run's due files and its closing line, without the lock;
// named acceptance files narrow the run to them (the others are owed).
//
// One run at a time per machine: an flock on ACCEPT_LOCK (default
// $TMPDIR/opencode-accept.flock, mods/rift/process/flock.ts), which ends with its
// holder; the holder's pid, checkout and mode are written beside it. A land run
// behind a deep run (`owed`, `all`) sets a wanted mark (`<lock>.wanted/<pid>`);
// the deep run, which looks every 250 ms, stops what it runs, writes the ledger,
// gives the lock up, and takes it again once it is free and no live mark is set
// (scripts/accept-yield.ts, notes/accept-lock.qnt). The ledger is written only
// under the lock. A run from a checkout older than this lock takes the old
// directory lock ($TMPDIR/opencode-accept.lock) and does not exclude this one.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { $, type Subprocess } from "bun"
import { Array as Arr, Console, Deferred, Effect, Fiber, Option } from "effect"
import { holdingIfFree } from "../mods/rift/process/flock.ts"
import { descendants, listing, type Proc, servers, stop, survivors, table, watch, type Watch } from "./leaks.ts"
import { checkFork } from "./fork.ts"
import { heading, isSerial, plan, poolWidth, requestedWidth, scenariosOf } from "./accept-plan.ts"
import * as Accept from "./accept-ledger.ts"
import * as Yield from "./accept-yield.ts"
import { acceptanceTests, acceptKey, acceptReach, acceptSharedKey, load, packageOf, ROOT } from "./reach.ts"

const ENV = { ...process.env }
const ARGS = process.argv.slice(2)
const dash = ARGS.indexOf("--")
/** Flags after `--` go to every `bun test`; a run with any records no pass. */
const rest = ARGS.slice(dash + 1).filter(() => dash >= 0)
const own = (dash < 0 && ARGS) || ARGS.slice(0, dash)
const mode: Accept.Mode = ((own.includes("--land") || own.includes("--affected")) && "land") || (own.includes("--owed") && "owed") || "all"
const listOnly = own.includes("--list")
const settledHost = own.includes("--settled")
const jsonOut = Option.filter(Option.fromUndefinedOr(own[own.indexOf("--json") + 1]), () => own.includes("--json"))
const window = (mode === "land" && Accept.windowOf(Number(ENV.ACCEPT_BUDGET_MS ?? Accept.BUDGET_MS))) || Accept.OPEN
const LEDGER = ENV.ACCEPT_LEDGER ?? path.join(os.homedir(), ".cache/opencode-accept/passed.json")
const LOCK = ENV.ACCEPT_LOCK ?? path.join(os.tmpdir(), "opencode-accept.flock")
const OWNER = `${LOCK}.owner.json`
const MARKS = `${LOCK}.wanted`
const MARK = path.join(MARKS, String(process.pid))
const LOGS = ENV.ACCEPT_LOGS ?? path.join(os.homedir(), ".cache/opencode-accept/logs")
/** How many heads' logs are kept. */
const LOG_HEADS = 5
/** Where each file's junit report goes. */
const REPORTS = path.join(os.tmpdir(), `opencode-accept-${process.pid}`)
const cores = os.availableParallelism()
const load1 = () => Option.getOrElse(Option.fromUndefinedOr(os.loadavg()[0]), () => 0)

/** The wait behind another land run: off this run's clock (that run ends inside its own 60 s). */
let offClock = 0
/** Milliseconds since this process started. */
const sinceStart = () => performance.now()
/** The run's clock: since the process started, less the wait behind another land run. */
const elapsed = () => sinceStart() - offClock
/** The wall clock, for the ledger's times. */
const wallNow = () => Date.now()
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
  readonly candidates: ReadonlyArray<Accept.Candidate>
  readonly named: ReadonlyArray<string>
  readonly selection: Accept.Selection
  /** The ledger as this run has written it. */
  ledger: Accept.Ledger
  readonly timed: Array<Accept.Timed>
  readonly loads: Array<number>
  /** Done when a signal asks the run to stop. */
  readonly signalled: Deferred.Deferred<boolean>
  /** Done when a live wanted mark asks this deep run to give the lock up; a new one per hold. */
  wanted: Deferred.Deferred<boolean>
  /** The checkout's head, and where this head's logs go. */
  readonly head: string
  readonly logs: string
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

const prepare = Effect.fn("Accept.prepare")(function* (signalled: Deferred.Deferred<boolean>) {
  const workspace = yield* Effect.promise(load)
  const files = filesOf(acceptanceTests(workspace))
  const text = (file: string) => readFileSync(path.resolve(ROOT, file), "utf8")
  const read = Accept.readLedger(disk, LEDGER)
  if (Option.isSome(read.problem)) yield* Console.error(`accept: ${read.problem.value}`)
  const shared = yield* Effect.promise(() => acceptSharedKey([`accept-ledger:${Accept.KEY_VERSION}`, "bun test --timeout 300000"]))
  const memo = new Map<string, ReadonlyArray<string>>()
  const reached = new Map(files.map((file) => [file, acceptReach(workspace, file, memo)]))
  const keys = new Map(files.map((file) => [file, acceptKey(shared, reached.get(file) ?? [file])]))
  const tiers = new Map(files.map((file) => [file, Accept.tierOf(text(file))]))
  const candidates = files.map((file) => ({ file, tier: tiers.get(file) ?? "land", key: keys.get(file) ?? "" }))
  const named = own.filter((arg) => files.includes(arg))
  const selection = selectFrom(candidates, read.ledger, named, text)
  const head = (yield* git(["rev-parse", "HEAD"])).trim()
  const logs = path.join(LOGS, head.slice(0, 12) || "no-head")
  const wanted = yield* Deferred.make<boolean>()
  const run: Run = { files, text, reached, keys, tiers, candidates, named, selection, ledger: read.ledger, timed: [], loads: [load1()], signalled, wanted, head, logs }
  return run
})

/** What a run of this mode does with each file under `ledger`; a deep run without `--settled` holds the files that bound a time. */
const selectFrom = (candidates: ReadonlyArray<Accept.Candidate>, ledger: Accept.Ledger, named: ReadonlyArray<string>, text: (file: string) => string) =>
  Accept.holdTiming(Accept.select(mode, candidates, ledger, wallNow(), named), (file) => isSerial(text(file)), mode !== "owed" || settledHost)

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

/** An owed or full run's files in phases: the pool, then the one-at-a-time files. */
const phases = Effect.fn("Accept.phases")(function* (run: Run, files: ReadonlyArray<string>) {
  const outcomes: Array<Accept.Outcome> = []
  for (const step of plan(files, run.text, poolWidth(cores, run.loads[0] ?? 0, requested()))) {
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

/** Runs `order` `width` at a time under the window: a file starts only before its start bound and while no land run wants the lock, and is stopped at the stop bound, a signal or a yield. */
const pool = (run: Run, order: ReadonlyArray<string>, width: number) =>
  Effect.forEach(
    order,
    (file) =>
      Effect.suspend(() => {
        if (Deferred.isDoneUnsafe(run.signalled)) return Effect.succeed(Accept.owe(file, "signal", "not started"))
        if (Deferred.isDoneUnsafe(run.wanted)) return Effect.succeed(Accept.owe(file, "yielded", "not started"))
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

/** What stops a running file: a signal, a land run that wants the lock, or the window's stop bound. */
const stopper = (run: Run) =>
  Effect.raceAll([
    Effect.as(Deferred.await(run.signalled), stopped("signal")),
    Effect.as(Deferred.await(run.wanted), stopped("yielded")),
    Effect.as(Effect.suspend(() => (Number.isFinite(window.stopAt) && Effect.sleep(Math.max(0, window.stopAt - elapsed()))) || Effect.never), stopped("budget")),
  ])

/** Waits for a file's `bun test` to exit, with its output. */
const exited = (running: Running) =>
  Effect.map(
    Effect.all([Effect.promise(() => new Response(running.child.stdout).text()), Effect.promise(() => new Response(running.child.stderr).text()), Effect.promise(() => running.child.exited)], {
      concurrency: 3,
    }),
    ([out, err, code]): Ended => ({ why: Option.none(), code, output: `${out}${err}`.trimEnd() }),
  )

/** Where a file's output goes for this head. */
const logOf = (run: Run, file: string) => path.join(run.logs, `${path.basename(file)}.log`)

/** One file's `bun test`, its leak check and its outcome; a stopped one is owed. `second` marks its second run. */
const runFile = Effect.fn("Accept.runFile")(function* (run: Run, file: string, second = false) {
  const began = elapsed()
  const report = path.join(REPORTS, `${Bun.hash(file).toString(36)}.xml`)
  const running = start(file, report)
  const ended = yield* Effect.raceFirst(exited(running), stopper(run))
  const ms = elapsed() - began
  run.timed.push({ file, tier: run.tiers.get(file) ?? "land", ms })
  if (Option.isSome(ended.why)) {
    yield* stopRun(running)
    yield* say(`accept: stopped ${file} after ${seconds(ms)} (${Accept.whyWords(ended.why.value)})`)
    return Accept.owe(file, ended.why.value, `stopped after ${seconds(ms)}`)
  }
  writeLog(run, file, ended.output, second)
  const leakedAny = yield* leaked(running.watching.stop(), Accept.leakGrace(window, elapsed()), run.wanted)
  // A yield that cut the leak check leaves the file unproven: owed, never passed and never failed.
  if (Option.isNone(leakedAny)) return Accept.owe(file, "yielded", `ended in ${seconds(ms)}, its leak check cut by the yield`)
  const finish = { file, code: ended.code, report: Accept.parseReport(Option.getOrElse(disk.read(report), () => "")), leaked: leakedAny.value, ms, recordable: rest.length === 0 }
  const outcome = Accept.verdict({ ...finish, forked: Boolean(ENV.OPENCODE_DEV), declared: Accept.declaredSkips(run.text(file)) })
  if (outcome.status === "failed") yield* say(ended.output, `accept: failed ${file} in ${seconds(ms)}: ${outcome.reason} (log ${logOf(run, file)})`)
  else yield* say(`accept: ${outcome.status} ${file} in ${seconds(ms)}`)
  settle(run, outcome)
  return outcome
})

/** Writes a file's output to its log; a second run's goes after the first's. */
const writeLog = (run: Run, file: string, output: string, second: boolean) => {
  mkdirSync(run.logs, { recursive: true })
  const before = (second && Option.getOrElse(disk.read(logOf(run, file)), () => "")) || ""
  const header = (second && `\n---- second run, alone, 1-minute load ${load1().toFixed(1)} ----\n`) || ""
  writeFileSync(logOf(run, file), `${before}${header}${output}\n`)
}

/** Keeps the logs of the newest LOG_HEADS heads. */
const pruneLogs = () => {
  const heads = Option.getOrElse(
    Option.map(Option.liftPredicate(LOGS, existsSync), (dir) => readdirSync(dir).map((name) => path.join(dir, name))),
    () => [],
  )
  const newest = [...heads].sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
  for (const old of newest.slice(LOG_HEADS)) rmSync(old, { recursive: true, force: true })
}

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

/** Records an outcome and writes the ledger whole when it changed it; only ever under the lock. */
const settle = (run: Run, outcome: Accept.Outcome) => {
  const next = Accept.record(run.ledger, outcome, run.keys.get(outcome.file) ?? "", wallNow())
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

/**
 * Stops a running file: its group while its `bun test` lives, then every process it started that still
 * runs, by the pid its watch saw or the process table shows under it now (the watch samples once a
 * second, so a child started since is read here, before the SIGTERM hands it to pid 1).
 */
const stopRun = (running: Running) =>
  Effect.gen(function* () {
    const tree = [...running.watching.stop(), ...descendants(table(), running.child.pid)]
    signalRun(running, "SIGTERM")
    // A test's own process groups (its servers, its drive runs) are outside the run's.
    yield* Effect.promise(() => stop(survivors(tree, table()), Yield.STOP_GRACE_MS))
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

/**
 * Whether a finished file left a server or drive run behind; stops those and names every survivor. None
 * when a land run wanted the lock during the grace: the survivors are stopped and the file proves nothing.
 */
const leaked = Effect.fn("Accept.leaked")(function* (seen: ReadonlyArray<Proc>, graceMs: number, wanted: Deferred.Deferred<boolean>) {
  // A test's teardown may still be ending what it started.
  const deadline = elapsed() + graceMs
  let left = survivors(seen, table())
  while (left.length > 0 && elapsed() < deadline && !Deferred.isDoneUnsafe(wanted)) {
    yield* Effect.sleep(Yield.POLL_MS)
    left = survivors(seen, table())
  }
  if (left.length > 0 && Deferred.isDoneUnsafe(wanted)) {
    yield* Effect.promise(() => stop(left, Yield.STOP_GRACE_MS))
    return Option.none<boolean>()
  }
  const strays = servers(left)
  const others = left.filter((proc) => !strays.includes(proc))
  if (others.length > 0) yield* Console.warn(`accept: ${others.length} test processes outlived the run:\n${listing(others)}`)
  if (strays.length === 0) return Option.some(false)
  yield* Console.error(`accept: the run leaked ${strays.length} OpenCode servers or drive runs; stopping them:\n${listing(strays)}`)
  yield* Effect.promise(() => stop(strays))
  return Option.some(true)
})

/** Prints the shares and the closing line, writes `--json`; the run's exit code. */
const finish = Effect.fn("Accept.finish")(function* (run: Run, ran: ReadonlyArray<Accept.Outcome>) {
  run.loads.push(load1())
  const outcomes = Accept.latest([...run.selection.settled, ...ran])
  const quiet = Accept.isQuiet(cores, run.loads)
  const judged = Accept.shares(mode, run.timed, quiet)
  yield* say(...judged.reported)
  if (judged.broken.length > 0) yield* Console.error(judged.broken.join("\n"))
  if (!quiet && mode === "land" && !listOnly)
    yield* say(`accept: the host is loaded (1-minute load ${run.loads.map((each) => each.toFixed(1)).join(" at the start, ")} at the end, ${cores} cores): land shares reported, not judged`)
  yield* say(...outcomes.flatMap((outcome) => Option.toArray(Accept.secondLoad(outcome))).map(([file, load]) => `accept: passed ${file} on its second run at load ${load.toFixed(1)}`))
  yield* say(...Accept.closing(mode, outcomes, elapsed() / 1000))
  rmSync(REPORTS, { recursive: true, force: true })
  yield* Effect.forEach(Option.toArray(jsonOut), (file) => Effect.sync(() => writeJson(run, outcomes, file)))
  if (Deferred.isDoneUnsafe(run.signalled)) return 130
  return Accept.exitOf(outcomes, judged.broken)
})

/** The run's outcome for the post-land step. */
const writeJson = (run: Run, outcomes: ReadonlyArray<Accept.Outcome>, file: string) => {
  const ranFile = (outcome: Accept.Outcome) => (outcome.status === "passed" || outcome.status === "failed") && existsSync(logOf(run, outcome.file))
  const files = outcomes.map((outcome) => Accept.deepFile(outcome, (ranFile(outcome) && logOf(run, outcome.file)) || ""))
  const report: Accept.DeepReport = { head: run.head, host: os.hostname(), load: { start: run.loads[0] ?? 0, end: run.loads.at(-1) ?? 0 }, files }
  disk.write(file, Accept.encodeDeepReport(report))
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Who holds the lock, as its owner file says, when that holder still lives. */
const holder = () => Option.filter(Option.flatMap(disk.read(OWNER), Accept.decodeOwner), (owner) => alive(owner.pid))

/** The pids of the live wanted marks. */
const liveMarks = () =>
  Yield.liveMarks(
    Option.getOrElse(Option.map(Option.liftPredicate(MARKS, existsSync), (dir) => readdirSync(dir).map(Number).filter(Number.isInteger)), () => []),
    alive,
  )

/** Runs `body` holding the lock when no other run holds it; none at once, running nothing, when one does. The kernel frees it when this process ends. */
const tryLock = <A>(body: Effect.Effect<A>): Effect.Effect<Option.Option<A>> =>
  Effect.flatMap(riftRuntime, (rift) =>
    Effect.promise(() =>
      rift.Effect.runPromise(
        rift.Effect.map(rift.Effect.orDie(holdingIfFree(LOCK, rift.Effect.promise(() => Effect.runPromise(body)))), (got) =>
          rift.Option.match(got, { onNone: () => Option.none<A>(), onSome: (value) => Option.some(value) }),
        ),
      ),
    ),
  )

/**
 * The `effect` flock.ts runs on: mods/rift's own (the fork's 4.1, linked there by `bun run link-fork`),
 * not the root's 4.0, so its Effects run on that runtime and this program meets them as a promise.
 * Resolved from flock.ts's folder, so it is whichever copy flock.ts loads.
 */
type RiftRuntime = typeof import("../mods/rift/node_modules/effect/dist/index.js")
const riftRuntime = Effect.promise((): Promise<RiftRuntime> => import(Bun.resolveSync("effect", path.join(ROOT, "mods/rift/process"))))

const writeOwner = () => disk.write(OWNER, Accept.encodeOwner({ pid: process.pid, root: ROOT, mode }))

const unmark = () => rmSync(MARK, { force: true })

/**
 * The run under the lock, once it holds it: waits while another run holds it. A land run behind a
 * yielding run sets its wanted mark, and that wait is on its clock; behind another land run it is off it.
 * None when a signal stopped the wait.
 */
const underLock = <A>(signalled: Deferred.Deferred<boolean>, body: Effect.Effect<A>) =>
  Effect.gen(function* () {
    const from = sinceStart()
    let told = ""
    let behindLand = 0
    for (;;) {
      if (Deferred.isDoneUnsafe(signalled)) {
        unmark()
        yield* Console.error("accept: stopped by a signal while it waited for the lock; it ran nothing, so every due file is still owed")
        return Option.none<A>()
      }
      // A deep run takes the lock only while no live mark is set.
      const may = mode === "land" || Yield.deepMayTake(true, liveMarks())
      // The wait ends as the lock is taken: its line comes before the run under it.
      const taken = Effect.andThen(Effect.sync(writeOwner), Effect.sync(unmark)).pipe(Effect.andThen(Effect.suspend(() => say(waitLine(sinceStart() - from, behindLand)))))
      const held = (may && (yield* tryLock(Effect.andThen(taken, body)))) || Option.none<A>()
      if (Option.isSome(held)) return held
      const owner = Option.map(holder(), (each) => each.mode)
      if (Yield.marks(mode, owner) && !existsSync(MARK)) disk.write(MARK, String(process.pid))
      const line = waitingLine(owner)
      if (line !== told) yield* say(line)
      told = line
      const paused = sinceStart()
      yield* Effect.sleep(Yield.POLL_MS)
      if (!Yield.onClock(owner)) {
        behindLand += sinceStart() - paused
        offClock += sinceStart() - paused
      }
    }
  })

const waitingLine = (owner: Option.Option<Accept.Mode>) => {
  const who = Option.getOrElse(Option.map(holder(), (each) => `the ${each.mode} run in ${each.root} (pid ${each.pid})`), () => "another run")
  if (mode !== "land") return `accept: waiting for the lock: ${who} holds it, or a land run wants it (one at a time per machine)`
  if (Yield.marks(mode, owner)) return `accept: waiting for ${who} to give the lock up: marked wanted (on this run's clock)`
  return `accept: waiting for ${who} (one at a time per machine)`
}

/** The wait for the lock; a land run's with the part on its 60 s clock, a run with no deadline's alone. */
const waitLine = (waited: number, behindLand: number) => {
  if (mode !== "land") return `accept: waited ${seconds(waited)} for the lock`
  return `accept: waited ${seconds(waited)} for the lock (${seconds(waited - behindLand)} on the run's clock, ${seconds(behindLand)} behind another land run off it)`
}

/** Watches for a live wanted mark while this deep run holds the lock: one sets `run.wanted`. */
const watchMarks = (run: Run) =>
  Effect.forever(
    Effect.andThen(
      Effect.sleep(Yield.POLL_MS),
      Effect.suspend(() => Effect.when(Deferred.succeed(run.wanted, true), Effect.sync(() => !Yield.deepMayStart(liveMarks())))),
    ),
  )

/**
 * One hold of the lock by a deep run: reads the ledger again (a land run may have passed files meanwhile),
 * runs what is still due and not settled in this run, then the second runs; stops at a live mark.
 */
const deepHold = Effect.fn("Accept.deepHold")(function* (run: Run, done: ReadonlyArray<Accept.Outcome>) {
  run.wanted = yield* Deferred.make<boolean>()
  const settledHere = new Set(done.flatMap((outcome) => Arr.filter([outcome.file], () => outcome.status === "passed" || outcome.status === "failed")))
  // Read under the lock: every write after builds on what a land run wrote while this run waited.
  const fresh = selectFrom(run.candidates, readAgain(run), run.named, run.text)
  // Passed by a land run while this one waited; a file this run settled itself stays as it ended here.
  const passedMeanwhile = fresh.settled.filter((outcome) => outcome.status === "before" && run.selection.run.includes(outcome.file) && !settledHere.has(outcome.file))
  const todo = fresh.run.filter((file) => run.selection.run.includes(file) && !settledHere.has(file))
  const watcher = yield* Effect.forkChild(watchMarks(run))
  const ran = yield* phases(run, todo)
  const all = Accept.latest([...done, ...passedMeanwhile, ...ran])
  const again = Accept.secondRuns(all).filter((file) => !Deferred.isDoneUnsafe(run.wanted) && !done.some((each) => each.file === file && each.status === "failed"))
  const second = yield* Effect.forEach(again, (file) => secondRun(run, file))
  yield* Fiber.interrupt(watcher)
  return { outcomes: [...passedMeanwhile, ...ran, ...second], yielded: Deferred.isDoneUnsafe(run.wanted) }
})

/** A failed file's second run, alone, at the end of the run; the load is printed with it. */
const secondRun = Effect.fn("Accept.secondRun")(function* (run: Run, file: string) {
  const load = load1()
  yield* say(`accept: ${file} failed; running it once more, alone, at 1-minute load ${load.toFixed(1)}`)
  return Accept.afterSecond(yield* runFile(run, file, true), load)
})

/** The ledger read again after the lock was given up and taken back. */
const readAgain = (run: Run) => {
  run.ledger = Accept.readLedger(disk, LEDGER).ledger
  return run.ledger
}

/** A deep run: holds of the lock until one ends without a yield, each giving the lock up at a live mark and taking it back once none is set. */
const deep = Effect.fn("Accept.deep")(function* (run: Run) {
  const outcomes: Array<Accept.Outcome> = []
  for (;;) {
    const hold = yield* underLock(run.signalled, deepHold(run, outcomes))
    if (Option.isNone(hold)) return { outcomes, stopped: true }
    outcomes.push(...hold.value.outcomes)
    if (!hold.value.yielded) return { outcomes, stopped: false }
    const marked = liveMarks()
    const cut = hold.value.outcomes.filter((outcome) => outcome.status === "owed" && outcome.why === "yielded").map((outcome) => outcome.file)
    yield* say(`accept: yielded the lock to a land run (pid ${marked.join(", ") || "gone"}); ${cut.length} files stopped or not yet started stay owed until it goes on: ${cut.join(", ") || "none"}; it goes on once the lock is free and no land run wants it`)
  }
})

const main = Effect.fn("Accept.main")(function* () {
  const requestedOk = requestedWidth(own)
  if (!requestedOk.ok) return yield* refuse(requestedOk.problem)
  if (!ENV.OPENCODE_DEV) yield* say("accept: OPENCODE_DEV is not set, so the real-OpenCode tests skip and record no pass. Point it at the fork.")
  else {
    // A fork that is not installed here would fail every real-OpenCode test for a reason none of them names.
    const checked = checkFork(ENV.OPENCODE_DEV)
    if ("problem" in checked) return yield* refuse(checked.problem)
  }
  const signalled = yield* Deferred.make<boolean>()
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => Effect.runFork(Deferred.succeed(signalled, true)))
  process.on("exit", unmark)
  if (listOnly) {
    const run = yield* prepare(signalled)
    const outcomes = yield* Effect.suspend(() => (mode === "land" && land(run)) || phases(run, run.selection.run))
    return yield* finish(run, outcomes)
  }
  pruneLogs()
  if (mode === "land") {
    const ran = yield* underLock(
      signalled,
      Effect.gen(function* () {
        const run = yield* prepare(signalled)
        return yield* finish(run, yield* land(run))
      }),
    )
    return Option.getOrElse(ran, () => 130)
  }
  const run = yield* prepare(signalled)
  const ran = yield* deep(run)
  if (ran.stopped && ran.outcomes.length === 0) return 130
  return yield* finish(run, ran.outcomes)
})

/** Ends the run before it starts, naming why. */
const refuse = (problem: string) => Effect.as(Console.error(`accept: ${problem}`), 1)

const code = await Effect.runPromise(main())
process.exit(code)
