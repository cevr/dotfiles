// A model-based test of the acceptance ledger and the land plan
// (scripts/accept-ledger.ts, the key in scripts/reach.ts). A reference model
// keeps, per acceptance file, the versions of what it loads and its last pass
// (signature, time) on its own clock; a seeded generator draws commands (change
// a reached file, a lint-only input or a package's own test, bench or Markdown;
// move the clock up to 30 h; a land run with drawn durations, load and
// failures; an owed run, loaded or settled, whose files pass, fail once then
// pass, fail twice, leak or are stopped by a yield; a run killed at a drawn
// write; a corrupt ledger) and after each one the real pure functions must
// agree with the model (I1 to I8 of accept-ledger-land's spec; I9: a skip the
// file does not declare never passes; I10 to I14 of accept-deep-owed's: a file
// that bounds a time never starts without --settled, a pass only from a green
// run not stopped, failed twice is failed, the counts equal the sets, the deep
// share judged only when quiet and never for a listed file). A failure names
// the seed and the command.
import { describe, expect, test } from "bun:test"
import { Array as Arr, Option } from "effect"
import * as Accept from "./accept-ledger.ts"
import { isSerial } from "./accept-plan.ts"
import { ACCEPT_SHARED, acceptKey, acceptSharedFrom, packageOf } from "./reach.ts"

const SEEDS = 200
const COMMANDS = 40
const HOUR = 3_600_000
const CORES = 12
const PATH = "/ledger/passed.json"
const PID = 4242

const PACKAGES = ["mods/a", "mods/b", "cmd/c"]
/** A package's files: what a run loads (`src.ts`), and what it does not (its unit test, bench, Markdown). */
const loaded = (dir: string) => `${dir}/src.ts`
const packageOnly = (dir: string) => [`${dir}/src.test.ts`, `${dir}/src.bench.ts`, `${dir}/README.md`]
const OUTSIDE = ["tests/helper.ts", "scenarios/one.ts", "scenarios/two.ts"]
const LINT_ONLY = [".oxlintrc.json", ".oxlintrc.effect-debt.json", "lint/package.json", "effect-debt.json", "scripts/effect-debt.ts", "scripts/gate.ts"]
const FILES = Array.from({ length: 10 }, (_, index) => `tests/f${index}.test.ts`)

/** mulberry32: a seeded generator, so a failing seed replays. */
const generator = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), state | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

interface Draw {
  readonly unit: () => number
  readonly below: (n: number) => number
  readonly chance: (p: number) => boolean
  readonly pick: <A>(items: ReadonlyArray<A>) => A
}

const drawOf = (seed: number): Draw => {
  const unit = generator(seed)
  const below = (n: number) => Math.floor(unit() * n)
  return { unit, below, chance: (p) => unit() < p, pick: (items) => items[below(items.length)] ?? items[0]! }
}

/** One acceptance file of the model: its tier marker, what it reaches and which packages its text names. */
interface File {
  readonly name: string
  readonly marker: string
  /** Whether the model holds it out of a land run: marked deep or one at a time. */
  readonly deep: boolean
  readonly packages: ReadonlyArray<string>
  readonly outside: ReadonlyArray<string>
  readonly names: ReadonlyArray<string>
  /** How many of its 3 tests it declares it may skip (`// accept: may skip <n> (<why>)`), 0 when it declares none. */
  readonly declared: number
}

/** Each run of a file in the model has this many tests. */
const TESTS = 3

/** What each scenario names: a scenario a file drives names a package, which the file then reaches. */
const scenarioNames = (draw: Draw) => new Map(["scenarios/one.ts", "scenarios/two.ts"].map((file) => [file, [draw.pick(PACKAGES)]]))

const fileOf = (draw: Draw, name: string, scenarios: ReadonlyMap<string, ReadonlyArray<string>>): File => {
  const marker = draw.pick(["", "", "// accept: deep (30 s alone on a quiet host: it waits)\n", "// accept: one at a time (it measures)\n"])
  const outside = OUTSIDE.filter(() => draw.chance(0.4))
  const driven = outside.flatMap((file) => scenarios.get(file) ?? [])
  const own = PACKAGES.filter(() => draw.chance(0.4))
  const packages = [...new Set([...own, ...driven])]
  const names = [...new Set([...own.filter(() => draw.chance(0.6)), ...driven])]
  return { name, marker, deep: marker !== "", packages, outside, names, declared: draw.pick([0, 0, 1, 2]) }
}

/** The skip marker a file's text carries, none when it declares no skip. */
const skipLine = (file: File) => Arr.filter([`// accept: may skip ${file.declared} (its condition rules a case out)\n`], () => file.declared > 0).join("")

/** The text the real functions read: the markers, the packages it names, the scenarios it drives. */
const textOf = (file: File) => `// ${file.name}\n${file.marker}${skipLine(file)}${file.names.map((dir) => `// drives ${dir}\n`).join("")}${file.outside.map((each) => `// "${each}"\n`).join("")}`

/** What `reach` gives for a file: itself, every file of each package it reaches (tests, benches and Markdown too), and the outside files. */
const reachOf = (file: File) => new Set([file.name, ...file.packages.flatMap((dir) => [loaded(dir), ...packageOnly(dir)]), ...file.outside])

/** The model's own view of what a file's pass rests on: its own text, the loaded file of each package, the outside files, the shared inputs. */
const inputsOf = (file: File) => [file.name, ...file.packages.map(loaded), ...file.outside, ...ACCEPT_SHARED]

interface Model {
  readonly files: ReadonlyArray<File>
  readonly versions: Map<string, number>
  /** Per file its passes, newest first: a pass of the same signature replaces the older one, an expired one goes, the newest eight stay. */
  readonly passes: Map<string, ReadonlyArray<{ readonly sig: string; readonly at: number }>>
  readonly disk: Map<string, string>
  readonly changed: Array<string>
  now: number
}

const versionOf = (model: Model, file: string) => model.versions.get(file) ?? 0
const sigOf = (model: Model, file: File) => inputsOf(file).map((each) => `${each}@${versionOf(model, each)}`).join(";")
const modelDue = (model: Model, file: File) => !(model.passes.get(file.name) ?? []).some((pass) => pass.sig === sigOf(model, file) && model.now - pass.at < 24 * HOUR)

const modelPass = (model: Model, file: File) => {
  const sig = sigOf(model, file)
  const kept = (model.passes.get(file.name) ?? []).filter((pass) => pass.sig !== sig && model.now - pass.at < 24 * HOUR)
  model.passes.set(file.name, [{ sig, at: model.now }, ...kept].slice(0, 8))
}

const diskOf = (model: Model): Accept.Disk => ({
  read: (file) => Option.fromUndefinedOr(model.disk.get(file)),
  write: (file, text) => {
    model.disk.set(file, text)
  },
  rename: (from, to) => {
    model.disk.set(to, model.disk.get(from) ?? "")
    model.disk.delete(from)
  },
})

/** A disk whose process dies in the first write: that write keeps a cut-short text, and nothing after it happens. */
const dying = (model: Model): Accept.Disk => {
  let dead = false
  return {
    read: (file) => Option.fromUndefinedOr(model.disk.get(file)),
    write: (file, text) => {
      if (!dead) model.disk.set(file, text.slice(0, Math.floor(text.length / 2)))
      dead = true
    },
    rename: () => {
      dead = true
    },
  }
}

const keysOf = (model: Model) => {
  const hash = (file: string) => `v${versionOf(model, file)}`
  const shared = acceptSharedFrom(hash, "fork:model", [`accept-ledger:${Accept.KEY_VERSION}`])
  return new Map(model.files.map((file) => [file.name, acceptKey(shared, reachOf(file), hash)]))
}

const ledgerOf = (model: Model) => Accept.readLedger(diskOf(model), PATH)

const realDue = (model: Model) => {
  const keys = keysOf(model)
  const ledger = ledgerOf(model).ledger
  return model.files.filter((file) => Accept.isDue(ledger, file.name, keys.get(file.name) ?? "", model.now)).map((file) => file.name)
}

const modelDueNames = (model: Model) => model.files.filter((file) => modelDue(model, file)).map((file) => file.name)

/** Whether a model file loads `changed`: a shared input, itself, a reached package's loaded file, an outside file it reaches. */
const loads = (file: File, changed: string) => inputsOf(file).includes(changed)

/** The model's nearness: its text or scenario names a changed file's package, or it reaches a changed file outside the packages. */
const modelNear = (file: File, changed: ReadonlyArray<string>) =>
  changed.some((each) => Option.match(Option.fromUndefinedOr(packageOf(each)), { onSome: (dir) => file.names.includes(dir), onNone: () => reachOf(file).has(each) }))

type Kill = Option.Option<{ readonly writes: number; readonly partial: boolean }>

/** A run's outcomes, in the order they end, and the ones settled before it. */
interface Played {
  readonly ended: ReadonlyArray<Accept.Outcome>
  readonly selection: Accept.Selection
  readonly problems: ReadonlyArray<string>
}

const candidatesOf = (model: Model, keys: ReadonlyMap<string, string>) =>
  model.files.map((file) => ({ file: file.name, tier: Accept.tierOf(textOf(file)), key: keys.get(file.name) ?? "" }))

/** A land run on the model: the real selection, order, width and simulated pool, drawn durations, load and failures. */
const playLand = (draw: Draw, model: Model, ledger: Accept.Ledger, keys: ReadonlyMap<string, string>): Played => {
  const selection = Accept.select("land", candidatesOf(model, keys), ledger, model.now)
  const byName = new Map(model.files.map((file) => [file.name, file]))
  const near = new Set(selection.run.filter((name) => {
    const file = byName.get(name)!
    return Accept.isNear([textOf(file)], reachOf(file), model.changed, (each) => Option.fromUndefinedOr(packageOf(each)))
  }))
  const order = Accept.landOrder(selection.run, near, (file) => Accept.estimate(ledger, file))
  const width = Accept.landWidth(CORES, draw.unit() * 30, Option.none())
  const window = Accept.windowOf(Accept.BUDGET_MS)
  // Short files cycle the pool's slots, so starts fall all through the window; long ones meet the stop; and
  // some free a slot between the start bound and the stop, where no file may start.
  const durations = new Map(order.map((file) => [file, draw.pick([draw.below(15_000), draw.below(70_000), 45_500 + draw.below(1500)])]))
  const played = Accept.simulate(order, (file) => durations.get(file) ?? 0, width, window, draw.below(3000))
  const failing = new Set(order.filter(() => draw.chance(0.2)))
  const ran = [...played.ran].sort((left, right) => left.end - right.end)
  const skips: Array<string> = []
  const ended = ran.map((slot): Accept.Outcome => {
    if (slot.stopped) return { file: slot.file, status: "owed", why: "budget", detail: "stopped" }
    if (failing.has(slot.file)) return { file: slot.file, status: "failed", ms: slot.end - slot.start, reason: "drawn" }
    return finished(draw, byName.get(slot.file)!, slot.end - slot.start, skips)
  })
  const unstarted = played.unstarted.map((file): Accept.Outcome => ({ file, status: "owed", why: "budget", detail: "not started" }))
  const problems = [
    ...skips,
    ...ran.filter((slot) => !(slot.start < 45_000)).map((slot) => `I4: ${slot.file} started at ${slot.start} ms`),
    ...ran.filter((slot) => slot.end > 50_000).map((slot) => `I4: ${slot.file} ran to ${slot.end} ms, past the stop`),
    ...unless(window.stopAt === 50_000 && window.startBy === 45_000, `I4: the window is ${window.startBy}/${window.stopAt}`),
    ...order.filter((file) => byName.get(file)?.deep).map((file) => `I4: deep ${file} in a land run`),
    ...orderProblems(order, model.files.filter((file) => modelNear(file, model.changed)).map((file) => file.name)),
  ]
  return { ended: [...ended, ...unstarted], selection, problems }
}

/** I7: every file the model calls near comes before every file it does not. */
const orderProblems = (order: ReadonlyArray<string>, near: ReadonlyArray<string>) => {
  const lastNear = Math.max(-1, ...order.map((file, index) => Number(near.includes(file)) * (index + 1) - 1))
  const firstFar = Math.min(order.length, ...order.map((file, index) => index + order.length * Number(near.includes(file))))
  return unless(lastNear < firstFar, `I7: order ${order.join(" ")} puts a far file before a near one (near: ${near.join(" ")})`)
}

/** How a file behaves in a deep run: green, red once then green (a flake), red twice, red by a leak, or stopped by a yield. */
type Behaviour = "green" | "flaky" | "red" | "leak" | "yielded"

/**
 * An owed run on the model, loaded (no `--settled`) or settled: every due file, but the files that bound a time
 * only when settled; each file drawn green, flaky, red, leaking or stopped by a yield; the failed ones, but a
 * leak, run once more at the end (`secondRuns`), and each file ends as its last run did (`latest`).
 * I10: without --settled a one-at-a-time file never starts and is owed `unsettled`. I11: a pass only from a
 * green run not stopped. I12: red twice is failed, a leak is failed with no second run. I13: the outcome's
 * counts equal the sets. I15: a yield between the first runs and the second runs drops no second run, and
 * no file runs a third time (`secondRunsDue`).
 */
const playOwed = (draw: Draw, model: Model, ledger: Accept.Ledger, keys: ReadonlyMap<string, string>, failures: boolean, settledHost: boolean): Played => {
  const byName = new Map(model.files.map((file) => [file.name, file]))
  const serial = (name: string) => isSerial(textOf(byName.get(name)!))
  const selection = Accept.holdTiming(Accept.select("owed", candidatesOf(model, keys), ledger, model.now), serial, settledHost)
  const skips: Array<string> = []
  const behaviours = new Map(selection.run.map((file): readonly [string, Behaviour] => [file, (failures && draw.pick<Behaviour>(["green", "flaky", "red", "leak", "yielded"])) || "green"]))
  const behaviour = (file: string): Behaviour => behaviours.get(file) ?? "green"
  const first = selection.run.map((file): Accept.Outcome => {
    const finish = { file, code: 0, report: Option.some({ tests: TESTS, failures: 0, skipped: 0 }), leaked: false, ms: 1000, recordable: true, forked: true, declared: 0 }
    if (behaviour(file) === "yielded") return Accept.owe(file, "yielded", "stopped after 1.0 s")
    if (behaviour(file) === "leak") return Accept.verdict({ ...finish, leaked: true })
    if (behaviour(file) === "flaky" || behaviour(file) === "red") return Accept.verdict({ ...finish, code: 1 })
    return finished(draw, byName.get(file)!, 1000, skips)
  })
  // The hold that runs the second runs reads the first failures as the run carried them (over a yield too), none retried yet.
  const again = Accept.secondRunsDue(first)
  const second = again.map((file) => {
    const load = draw.below(200)
    if (behaviour(file) === "red") return Accept.afterSecond({ file, status: "failed", ms: 1000, reason: "bun test exited 1" }, load)
    return Accept.afterSecond(finished(draw, byName.get(file)!, 1000, skips), load)
  })
  const ended = Accept.latest([...first, ...second])
  // Once each second run ended, no later hold runs a file again.
  const dueAfter = Accept.secondRunsDue([...first, ...second])
  const all = [...selection.settled, ...ended]
  const statusOf = (file: string) => all.find((outcome) => outcome.file === file)?.status
  const counts = Accept.countsOf(all)
  const sets = { passed: 0, failed: 0, owed: 0, before: 0 }
  for (const outcome of all) sets[outcome.status] += 1
  const problems = [
    ...skips,
    ...model.files.flatMap((file) =>
      unless(settledHost || !serial(file.name) || !selection.run.includes(file.name), `I10: ${file.name} bounds a time and started in a run without --settled`),
    ),
    ...selection.settled.flatMap((outcome) => unless(settledHost || !serial(outcome.file) || outcome.status !== "owed" || outcome.why === "unsettled", `I10: ${outcome.file} held for ${outcome.status}`)),
    ...ended.flatMap((outcome) => unless(outcome.status !== "passed" || behaviour(outcome.file) === "green" || behaviour(outcome.file) === "flaky", `I11: ${outcome.file} passed after a ${behaviour(outcome.file)} run`)),
    ...ended.flatMap((outcome) => unless(behaviour(outcome.file) !== "yielded" || (outcome.status === "owed" && outcome.why === "yielded"), `I11: ${outcome.file} stopped by a yield ended ${outcome.status}`)),
    ...selection.run.flatMap((file) => unless(behaviour(file) !== "red" || statusOf(file) === "failed", `I12: ${file} failed twice and ended ${String(statusOf(file))}`)),
    ...selection.run.flatMap((file) => unless(behaviour(file) !== "leak" || (statusOf(file) === "failed" && !again.includes(file)), `I12: ${file} leaked and ended ${String(statusOf(file))}, run again ${again.includes(file)}`)),
    ...ended.flatMap((outcome) => unless(Option.isNone(Accept.secondLoad(outcome)) || behaviour(outcome.file) === "flaky", `I13: ${outcome.file} marked passed on a second run after a ${behaviour(outcome.file)} first`)),
    ...unless(counts.passed === sets.passed && counts.failed === sets.failed && counts.owed === sets.owed && counts.before === sets.before && new Set(all.map((each) => each.file)).size === all.length, `I13: counts ${counts.passed}/${counts.failed}/${counts.owed}/${counts.before} for sets ${sets.passed}/${sets.failed}/${sets.owed}/${sets.before}`),
    ...unless(again.join(" ") === Accept.secondRuns(first).join(" "), `I15: the second runs are ${again.join(" ")}, not every first failure`),
    ...unless(dueAfter.length === 0, `I15: ${dueAfter.join(" ")} due a third run after its second ended`),
    ...deepShares(draw),
  ]
  return { ended, selection, problems }
}

/** I14: in a deep run a file over its 60 s share fails the run only on a quiet host, and never a file SLOW_DEEP lists. */
const deepShares = (draw: Draw): ReadonlyArray<string> => {
  const quiet = draw.chance(0.5)
  const names = [...FILES, ...Accept.SLOW_DEEP.map(([file]) => file)]
  const timed = names.map((file): Accept.Timed => ({ file, tier: "deep", ms: draw.below(120_000) }))
  const judged = Accept.shares("owed", timed, quiet)
  const listed = new Set(Accept.SLOW_DEEP.map(([file]) => file))
  const expected = timed.flatMap((each) => Arr.filter([each.file], () => quiet && each.ms > Accept.DEEP_SHARE_MS && !listed.has(each.file)))
  const broke = timed.flatMap((each) => Arr.filter([each.file], () => judged.broken.some((line) => line.startsWith(`accept: ${each.file} `))))
  return unless(broke.join(" ") === expected.join(" "), `I14: quiet ${quiet}: broke ${broke.join(" ")}, expected ${expected.join(" ")}`)
}

/**
 * A file that ran to its end without a failure, through the real verdict, with a drawn number of skipped tests
 * and a drawn fork. I9: it passes only when it skipped nothing, or (with the fork) no more than it declares and not
 * every test; an undeclared skip, or any skip without the fork, never passes.
 */
const finished = (draw: Draw, file: File, ms: number, problems: Array<string>): Accept.Outcome => {
  const skipped = draw.pick([0, 0, 0, 0, 1, 2, TESTS])
  const forked = draw.chance(0.85)
  const report = Option.some({ tests: TESTS, failures: 0, skipped })
  const outcome = Accept.verdict({ file: file.name, code: 0, report, leaked: false, ms, recordable: true, forked, declared: Accept.declaredSkips(textOf(file)) })
  const expected = skipped === 0 || (forked && skipped <= file.declared && skipped < TESTS)
  problems.push(...unless((outcome.status === "passed") === expected, `I9: ${file.name} skipped ${skipped} of ${TESTS} (declares ${file.declared}, fork ${forked}) and ended ${outcome.status}`))
  return outcome
}

/** Plays a run's outcomes into the ledger on the model's disk, one whole write each, stopping at a drawn kill. */
const apply = (model: Model, played: Played, keys: ReadonlyMap<string, string>, kill: Kill) => {
  let ledger = ledgerOf(model).ledger
  let writes = 0
  const snapshots = [Accept.encodeLedger(ledger)]
  const limit = Option.match(kill, { onNone: () => Number.POSITIVE_INFINITY, onSome: (at) => at.writes })
  for (const outcome of played.ended) {
    const next = Accept.record(ledger, outcome, keys.get(outcome.file) ?? "", model.now)
    if (next === ledger) continue
    if (writes >= limit) {
      // Killed inside this write: whatever it writes is cut short, and it never gets to the next step.
      if (Option.isSome(kill) && kill.value.partial) Accept.writeLedger(dying(model), PATH, PID, next)
      break
    }
    ledger = next
    Accept.writeLedger(diskOf(model), PATH, PID, ledger)
    writes += 1
    snapshots.push(Accept.encodeLedger(ledger))
    if (outcome.status === "passed") modelPass(model, model.files.find((file) => file.name === outcome.file)!)
  }
  return { snapshots, written: writes }
}

/** I1, I2, I3 over a run: the skipped ones are those the model holds a fresh pass for; each file ends once; the closing line counts them. */
const runProblems = (model: Model, played: Played, dueBefore: ReadonlyArray<string>) => {
  const all = [...played.selection.settled, ...played.ended]
  const names = all.map((outcome) => outcome.file)
  const skipped = all.flatMap((outcome) => Arr.filter([outcome.file], () => outcome.status === "before"))
  const counted = Accept.countsOf(all)
  const line = Accept.closing("land", all, 1).at(-1) ?? ""
  const parsed = Accept.parseClosing(line)
  return [
    ...skipped.flatMap((file) => unless(!dueBefore.includes(file), `I1: ${file} skipped while the model holds no fresh pass`)),
    ...model.files.flatMap((file) => unless(dueBefore.includes(file.name) || skipped.includes(file.name), `I1: ${file.name} ran with a fresh pass`)),
    ...unless(names.length === model.files.length && new Set(names).size === names.length, `I3: outcomes ${names.join(" ")}`),
    ...unless(counted.passed + counted.failed + counted.owed + counted.before === model.files.length, "I3: counts do not add up"),
    ...Option.match(parsed, {
      onNone: () => [`I3: no closing line: ${line}`],
      onSome: (read) =>
        unless(read.passed === counted.passed && read.failed === counted.failed && read.owed === counted.owed, `I3: ${line} for ${counted.passed}/${counted.failed}/${counted.owed}`),
    }),
  ]
}

/** No problem when `ok`, else the one named. */
const unless = (ok: boolean, problem: string): ReadonlyArray<string> => Arr.filter([problem], () => !ok)

/** After any command the real ledger and keys agree with the model on which files are due (I1, I2, I6). */
const agreement = (model: Model) => {
  const real = realDue(model)
  const expected = modelDueNames(model)
  return unless(real.join(" ") === expected.join(" "), `due: real ${real.join(" ")}; model ${expected.join(" ")}`)
}

const change = (model: Model, file: string) => {
  model.versions.set(file, versionOf(model, file) + 1)
  model.changed.push(file)
}

/** A change; I6: a lint-only or package-only change makes nothing due, any other makes exactly the files that load it due. */
const changing = (model: Model, file: string) => {
  const before = realDue(model)
  change(model, file)
  const after = realDue(model)
  const loaders = model.files.filter((each) => loads(each, file)).map((each) => each.name)
  const expected = model.files.map((each) => each.name).filter((name) => before.includes(name) || loaders.includes(name))
  return unless(after.join(" ") === expected.join(" "), `I6: ${file} changed; due ${before.join(" ")} became ${after.join(" ")}, expected ${expected.join(" ")}`)
}

/** The run a command plays: an owed one (with drawn failures), else a land one. */
const playOf = (draw: Draw, model: Model, owedRun: boolean, ledger: Accept.Ledger, keys: ReadonlyMap<string, string>) => {
  if (owedRun) return playOwed(draw, model, ledger, keys, draw.chance(0.5), draw.chance(0.5))
  return playLand(draw, model, ledger, keys)
}

/** A kill at a drawn write of a killed run, half the time inside that write; none for the others. */
const killOf = (draw: Draw, kind: "land" | "owed" | "kill", writes: number): Kill => {
  if (kind !== "kill") return Option.none()
  return Option.some({ writes: draw.below(writes + 1), partial: draw.chance(0.5) })
}

const run = (draw: Draw, model: Model, kind: "land" | "owed" | "kill") => {
  const read = ledgerOf(model)
  const keys = keysOf(model)
  const dueBefore = modelDueNames(model)
  const owedRun = kind === "owed" || (kind === "kill" && draw.chance(0.5))
  const played = playOf(draw, model, owedRun, read.ledger, keys)
  const kill = killOf(draw, kind, played.ended.length)
  const applied = apply(model, played, keys, kill)
  model.changed.length = 0
  const after = ledgerOf(model)
  // A corrupt ledger nobody wrote over since stays corrupt (and reads as empty, loudly); any write leaves a readable one.
  const readable = Option.isNone(after.problem) || (applied.written === 0 && Option.isSome(read.problem))
  const settledOk = readable && Accept.encodeLedger(after.ledger) === applied.snapshots.at(-1)
  // Clean: every file it ran passed and it held none back for a settled host.
  const clean = kind !== "kill" && owedRun && !played.ended.some((outcome) => outcome.status !== "passed") && !played.selection.settled.some((outcome) => outcome.status === "owed")
  return [
    ...played.problems,
    ...runProblems(model, played, dueBefore),
    ...unless(settledOk, `I8: the ledger after ${applied.written} writes of a ${kind} run reads as another state`),
    ...unless(!clean || realDue(model).length === 0, `I5: after a clean owed run ${realDue(model).join(" ")} are due`),
  ]
}

const step = (draw: Draw, model: Model): ReadonlyArray<string> => {
  const command = draw.below(10)
  if (command === 9) {
    // A revert or a branch switch: a changed input goes back to an earlier version, so an older pass may count again.
    const changed = [...model.versions].filter(([, version]) => version > 0)
    if (changed.length === 0) return []
    const [file, version] = draw.pick(changed)
    model.versions.set(file, draw.below(version))
    model.changed.push(file)
    return []
  }
  if (command === 0) return changing(model, draw.pick([...model.files.map((file) => file.name), ...PACKAGES.map(loaded), ...OUTSIDE]))
  if (command === 1) return changing(model, draw.pick(LINT_ONLY))
  if (command === 2) return changing(model, draw.pick(PACKAGES.flatMap(packageOnly)))
  if (command === 3) return changing(model, draw.pick(ACCEPT_SHARED))
  if (command === 4) {
    model.now += draw.below(30 * HOUR)
    return []
  }
  if (command === 5) {
    model.disk.set(PATH, "{ not a ledger")
    model.passes.clear()
    return unless(Option.isSome(ledgerOf(model).problem), "a corrupt ledger read without a problem")
  }
  if (command === 6) return run(draw, model, "owed")
  if (command === 7) return run(draw, model, "kill")
  return run(draw, model, "land")
}

const playSeed = (seed: number): ReadonlyArray<string> => {
  const draw = drawOf(seed)
  const scenarios = scenarioNames(draw)
  const model: Model = { files: FILES.map((name) => fileOf(draw, name, scenarios)), versions: new Map(), passes: new Map(), disk: new Map(), changed: [], now: 1_800_000_000_000 }
  const problems: Array<string> = []
  for (let index = 0; index < 1 + draw.below(COMMANDS) && problems.length === 0; index += 1)
    problems.push(...[...step(draw, model), ...agreement(model)].map((problem) => `seed ${seed}, command ${index}: ${problem}`))
  return problems
}

/** How a file behaves in a deep run cut by yields: green, red once then green (a flake), red on every run, or red by a leak. */
type Act = "green" | "flaky" | "red" | "leak"

/** At most this many yields in one modelled deep run; the hold after the last is not cut. */
const MAX_YIELDS = 4

/**
 * A deep run as the runner's holds (`deepHold`), cut by a land run's mark at any run, a first run or a second run:
 * each hold plans with `holdPlan` from all the run did before it and the ledger read again (a land run may have
 * passed a file meanwhile), runs its first runs, then the second runs `secondRunsDue` names from the run's whole
 * history; a cut run is owed, no file starts after it, and the next hold goes on. The model keeps its own count of
 * each file's ended second runs, apart from the marks the runner's functions read.
 * I16: once the run ends, each file whose first run failed (not by a leak) had exactly one second run that ended,
 * every other file none; no file ends owed; a red file ends failed, a flaky one passed on its second run, a leak
 * failed, a green one passed (or passed before, by a land run).
 */
const playHolds = (seed: number) => {
  const draw = drawOf(seed)
  const reached = new Set<string>()
  const files = FILES.slice(0, 1 + draw.below(5))
  const acts = new Map(files.map((file) => [file, draw.pick<Act>(["green", "flaky", "red", "leak"])]))
  const act = (file: string): Act => acts.get(file) ?? "green"
  const cutChance = draw.pick([0.1, 0.3, 0.6])
  const history: Array<Accept.Outcome> = []
  const secondsEnded = new Map<string, number>()
  const firstFailed = new Set<string>()
  const byLand = new Set<string>()
  let yields = 0
  for (;;) {
    // A land run may have passed a file while this run waited.
    const passing = Arr.filter(files, () => yields > 0 && draw.chance(0.15))
    for (const file of passing) byLand.add(file)
    if (passing.length > 0) reached.add("a file passed by a land run meanwhile")
    const fresh: Accept.Selection = { run: files.filter((file) => !byLand.has(file)), settled: [...byLand].map((file): Accept.Outcome => ({ file, status: "before" })) }
    const plan = Accept.holdPlan(files, history, fresh)
    let cut = false
    const cuts = () => {
      cut = cut || (yields < MAX_YIELDS && draw.chance(cutChance))
      return cut
    }
    const ran = plan.todo.map((file): Accept.Outcome => {
      if (cut) return Accept.owe(file, "yielded", "not started")
      if (cuts()) {
        reached.add("a first run cut")
        return Accept.owe(file, "yielded", "stopped")
      }
      if (act(file) === "green") return { file, status: "passed", ms: 1000 }
      firstFailed.add(file)
      if (act(file) === "leak") return { file, status: "failed", ms: 1000, reason: Accept.LEAKED }
      return { file, status: "failed", ms: 1000, reason: "bun test exited 1" }
    })
    history.push(...plan.passedMeanwhile, ...ran)
    const again = Arr.filter(Accept.secondRunsDue(history), () => !cut)
    for (const file of again) {
      if (cut || cuts()) {
        reached.add("a second run cut")
        history.push(Accept.afterSecond(Accept.owe(file, "yielded", "stopped"), 1))
        continue
      }
      secondsEnded.set(file, (secondsEnded.get(file) ?? 0) + 1)
      if (history.some((outcome) => outcome.file === file && outcome.status === "owed")) reached.add("a cut second run run again")
      reached.add(`a second run of a ${act(file)} file`)
      const second: Accept.Outcome = (act(file) === "flaky" && { file, status: "passed", ms: 1000 }) || { file, status: "failed", ms: 1000, reason: "bun test exited 1" }
      history.push(Accept.afterSecond(second, 1))
    }
    if (!cut) break
    yields += 1
  }
  const ended = new Map(Accept.latest(history).map((outcome) => [outcome.file, outcome]))
  const expected = (file: string) => {
    if (act(file) === "red" || act(file) === "leak") return "failed"
    if (act(file) === "flaky") return "passed on its second run"
    return "passed"
  }
  const got = (file: string) => {
    const outcome = ended.get(file)
    if (Option.isSome(Option.flatMap(Option.fromUndefinedOr(outcome), Accept.secondLoad))) return "passed on its second run"
    if (outcome?.status === "before" && act(file) === "green") return "passed"
    return String(outcome?.status)
  }
  const wanted = (file: string) => Number(firstFailed.has(file) && act(file) !== "leak")
  const problems = [
    ...files.flatMap((file) => unless((secondsEnded.get(file) ?? 0) === wanted(file), `I16: ${file} (${act(file)}) had ${secondsEnded.get(file) ?? 0} second runs that ended, not ${wanted(file)}`)),
    // A file a land run passed before its first run here ended is passed before, whatever it does here.
    ...files.flatMap((file) => unless(ended.get(file)?.status === "before" || got(file) === expected(file), `I16: ${file} (${act(file)}) ended ${got(file)}, not ${expected(file)}`)),
  ].map((problem) => `seed ${seed}, ${yields} yields: ${problem}`)
  return { problems, reached }
}

describe("a deep run cut by yields against its model", () => {
  test(`${SEEDS * 5} seeded deep runs, cut at any first or second run, keep I16`, () => {
    const problems = Array.from({ length: SEEDS * 5 }, (_, seed) => playHolds(seed + 1).problems).flat()
    expect(problems.slice(0, 5)).toEqual([])
  })

  test("the generator reaches cuts of first and second runs, a cut second run run again, files a land run passed meanwhile, and second runs of flaky and red files", () => {
    const reached = new Set(Array.from({ length: SEEDS * 5 }, (_, seed) => [...playHolds(seed + 1).reached]).flat())
    expect([...reached].sort()).toEqual([
      "a cut second run run again",
      "a file passed by a land run meanwhile",
      "a first run cut",
      "a second run cut",
      "a second run of a flaky file",
      "a second run of a red file",
    ])
  })
})

describe("the acceptance ledger against its model", () => {
  test(`${SEEDS} seeded runs of up to ${COMMANDS} commands keep I1 to I15`, () => {
    const problems = Array.from({ length: SEEDS }, (_, seed) => playSeed(seed + 1)).flat()
    expect(problems.slice(0, 5)).toEqual([])
  })

  test("the lint-only inputs are outside the acceptance shared key, and in the gate's", () => {
    expect(LINT_ONLY.filter((file) => ACCEPT_SHARED.includes(file))).toEqual([])
  })

  test("a land window starts nothing after 45 s and stops at 50 s; a budget scales it", () => {
    expect([Accept.windowOf(60_000), Accept.windowOf(6000)]).toEqual([
      { startBy: 45_000, stopAt: 50_000, end: 60_000 },
      { startBy: 4500, stopAt: 5000, end: 6000 },
    ])
    expect([Accept.landWidth(12, 2, Option.none()), Accept.landWidth(12, 80, Option.none()), Accept.landWidth(12, 0, Option.some(3))]).toEqual([10, 4, 3])
  })

  test("a pass needs exit 0, tests that ran and none failed, no skip but declared ones with the fork, no leak and no narrowing flags", () => {
    const report = (tests: number, failures: number, skipped: number) => Accept.parseReport(`<testsuites name="bun test" tests="${tests}" assertions="1" failures="${failures}" skipped="${skipped}" time="1">`)
    const base = { file: "tests/x.test.ts", code: 0, report: report(3, 0, 0), leaked: false, ms: 10, recordable: true, forked: true, declared: 0 }
    const statuses = [
      base,
      { ...base, code: 1 },
      { ...base, report: report(3, 1, 0) },
      { ...base, report: report(3, 0, 3), declared: 3 },
      { ...base, report: report(3, 0, 1) },
      { ...base, report: report(3, 0, 1), declared: 1 },
      { ...base, report: report(3, 0, 2), declared: 1 },
      { ...base, report: report(3, 0, 1), declared: 1, forked: false },
      { ...base, forked: false },
      { ...base, report: report(0, 0, 0) },
      { ...base, report: Accept.parseReport("") },
      { ...base, leaked: true },
      { ...base, recordable: false },
    ].map((finish) => Accept.verdict(finish).status)
    expect(statuses).toEqual(["passed", "failed", "failed", "owed", "owed", "passed", "owed", "owed", "passed", "owed", "failed", "failed", "owed"])
  })

  test("a skip is declared by the marker line with a count and a reason, nothing else", () => {
    expect(
      [
        "// accept: may skip 1 (the fork's version picks one case)\n",
        "x\n// accept: may skip 2 (two hosts)\n",
        "// accept: may skip 1\n",
        "// accept: may skip one (why)\n",
        'const note = "// accept: may skip 1 (why)"\n',
        "",
      ].map(Accept.declaredSkips),
    ).toEqual([1, 2, 0, 0, 0, 0])
  })
})
