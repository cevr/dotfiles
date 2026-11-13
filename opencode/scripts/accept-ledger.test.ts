// A model-based test of the acceptance ledger and the land plan
// (scripts/accept-ledger.ts, the key in scripts/reach.ts). A reference model
// keeps, per acceptance file, the versions of what it loads and its last pass
// (signature, time) on its own clock; a seeded generator draws commands (change
// a reached file, a lint-only input or a package's own test, bench or Markdown;
// move the clock up to 30 h; a land run with drawn durations, load and
// failures; an owed run; a run killed at a drawn write; a corrupt ledger) and
// after each one the real pure functions must agree with the model (I1 to I8 of
// the unit's spec). A failure names the seed and the command.
import { describe, expect, test } from "bun:test"
import { Array as Arr, Option } from "effect"
import * as Accept from "./accept-ledger.ts"
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
}

/** What each scenario names: a scenario a file drives names a package, which the file then reaches. */
const scenarioNames = (draw: Draw) => new Map(["scenarios/one.ts", "scenarios/two.ts"].map((file) => [file, [draw.pick(PACKAGES)]]))

const fileOf = (draw: Draw, name: string, scenarios: ReadonlyMap<string, ReadonlyArray<string>>): File => {
  const marker = draw.pick(["", "", "// accept: deep (30 s alone on a quiet host: it waits)\n", "// accept: one at a time (it measures)\n"])
  const outside = OUTSIDE.filter(() => draw.chance(0.4))
  const driven = outside.flatMap((file) => scenarios.get(file) ?? [])
  const own = PACKAGES.filter(() => draw.chance(0.4))
  const packages = [...new Set([...own, ...driven])]
  const names = [...new Set([...own.filter(() => draw.chance(0.6)), ...driven])]
  return { name, marker, deep: marker !== "", packages, outside, names }
}

/** The text the real functions read: the marker, the packages it names, the scenarios it drives. */
const textOf = (file: File) => `// ${file.name}\n${file.marker}${file.names.map((dir) => `// drives ${dir}\n`).join("")}${file.outside.map((each) => `// "${each}"\n`).join("")}`

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
  // Short files cycle the pool's slots, so starts fall all through the window; long ones meet the stop.
  const durations = new Map(order.map((file) => [file, draw.below(draw.pick([15_000, 70_000]))]))
  const played = Accept.simulate(order, (file) => durations.get(file) ?? 0, width, window, draw.below(3000))
  const failing = new Set(order.filter(() => draw.chance(0.2)))
  const ran = [...played.ran].sort((left, right) => left.end - right.end)
  const ended = ran.map((slot): Accept.Outcome => {
    if (slot.stopped) return { file: slot.file, status: "owed", why: "budget", detail: "stopped" }
    if (failing.has(slot.file)) return { file: slot.file, status: "failed", ms: slot.end - slot.start, reason: "drawn" }
    return { file: slot.file, status: "passed", ms: slot.end - slot.start }
  })
  const unstarted = played.unstarted.map((file): Accept.Outcome => ({ file, status: "owed", why: "budget", detail: "not started" }))
  const problems = [
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

/** An owed run on the model: every due file, drawn failures, no deadline. */
const playOwed = (draw: Draw, model: Model, ledger: Accept.Ledger, keys: ReadonlyMap<string, string>, failures: boolean): Played => {
  const selection = Accept.select("owed", candidatesOf(model, keys), ledger, model.now)
  const ended = selection.run.map((file): Accept.Outcome => {
    if (failures && draw.chance(0.2)) return { file, status: "failed", ms: 1000, reason: "drawn" }
    return { file, status: "passed", ms: 1000 }
  })
  return { ended, selection, problems: [] }
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
  if (owedRun) return playOwed(draw, model, ledger, keys, draw.chance(0.5))
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
  const clean = kind !== "kill" && owedRun && !played.ended.some((outcome) => outcome.status !== "passed")
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

describe("the acceptance ledger against its model", () => {
  test(`${SEEDS} seeded runs of up to ${COMMANDS} commands keep I1 to I8`, () => {
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

  test("a pass needs exit 0, tests that ran and none failed or skipped, no leak and no narrowing flags", () => {
    const report = (tests: number, failures: number, skipped: number) => Accept.parseReport(`<testsuites name="bun test" tests="${tests}" assertions="1" failures="${failures}" skipped="${skipped}" time="1">`)
    const base = { file: "tests/x.test.ts", code: 0, report: report(3, 0, 0), leaked: false, ms: 10, recordable: true }
    const statuses = [
      base,
      { ...base, code: 1 },
      { ...base, report: report(3, 1, 0) },
      { ...base, report: report(3, 0, 3) },
      { ...base, report: report(0, 0, 0) },
      { ...base, report: Accept.parseReport("") },
      { ...base, leaked: true },
      { ...base, recordable: false },
    ].map((finish) => Accept.verdict(finish).status)
    expect(statuses).toEqual(["passed", "failed", "failed", "owed", "owed", "failed", "failed", "owed"])
  })
})
