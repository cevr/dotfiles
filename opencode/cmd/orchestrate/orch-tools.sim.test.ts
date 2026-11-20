// The `orchestrate` tool on the simulated host (orch-tools-world.ts): the real orchestrate, rift and status plugins
// on their memory layers, at 20 seeds. The plugin keeps no state of a run: every answer is read from the units' logs
// (the status script's tables) and the Rift list at the call.
//
// - A1, model-based: a seeded run of generated starts, hand-backs, lanes, lands, verifies, verifier starts, restarts
//   and root handoffs against a reference model of the units' logs and lanes. No batch rule refuses; each land lands
//   exactly the Rifts the model resolves; status is the model's rendering after every command.
// - A2 to A6: a restart and a new root lose nothing, a land of a unit that is not ready warns and lands, the harm
//   rules still refuse, no ledger is kept and old options load, and a verdict publishes the fleet target once.
// - The lane name rule on either naming, the rift tool's description, and the tool's name against the registry's.
import { headsOf } from "@dotfiles/opencode-orchestrate/fleet"
import { laneNote, lanePathOf, VERIFY_EVERY } from "@dotfiles/opencode-orchestrate/tools"
import { RIFT_DESCRIPTION } from "@dotfiles/opencode-work/rift"
import { Array as Arr, Effect, Match, Option, Order, Result, Schema } from "effect"
import { nearest } from "../../mods/tool-names/near-miss.ts"
import * as Plugins from "../../sim/plugins.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"
import { boot, FORK_HEAD, HAND_BACK, type Input, isClosed, PLAIN, requestHeadFor, RUN, RUN_DIR, type Run, type UnitLog, WORK } from "./orch-tools-world.ts"

const { seeded } = Seed.runner("cmd/orchestrate/orch-tools.sim.test.ts")

const ORCHESTRATE = "orchestrate"
const READY = "/nonexistent/loop-probe-x/request.md"
const FINDINGS = "/nonexistent/loop-probe-x/batch-findings.md"
/** What a subagent's land is answered (tools.ts `parentRefusal`): merge and push are the root's. */
const PARENT_LAND = "orchestrate: land is the root's: a subagent never lanes, lands or verifies."
/** Words only the deleted batch machine said. */
const MACHINE_WORDS = /refused by the\s+machine|the machine holds no unit|the machine's rule/

/** The workspace a lane's answer ends with: its `(lane: <path>)` (tools.ts `lanePathOf`, which takes the old `(rift: <path>)` too). */
const suffixOf = (answer: string): string => Option.getOrElse(lanePathOf(answer), () => "")

/** The Rift a lane of `unit` makes on the Mac, in the run's warm source. */
const pathOf = (unit: string) => `/scratch/.work/work/${unit}`

/** The warning a land of a unit the logs show in another state than `ready` starts with. */
const warningOf = (unit: string, state: string) => `orchestrate: warning: ${unit} is ${state}, not ready; landed as asked.`

/** A seeded generator in [0, 1). */
const rng = (seed: number) => {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The branches the land steps since `from` merged, in order. */
const mergedSince = (run: Run, from: number) =>
  run.memory.landing.steps.slice(from).flatMap((step) => Option.toArray(Option.map(Option.liftPredicate(step, (found) => found.startsWith("merge ")), (found) => found.slice("merge ".length))))
const startsOf = (run: Run) => run.memory.landing.steps.filter((step) => step.startsWith("start ")).length

/** The state a unit's log is in after its implementor hands back `verdict` (`none`: still implementing). */
const stateOf = (verdict: "ready" | "blocked" | "none"): string => Match.value(verdict).pipe(Match.when("none", () => "implement"), Match.orElse((said) => said))

/** A prompt: `none` asks plainly, any other verdict ends with that hand-back line. */
const promptOf = (verdict: string, plain: string, line: string): string => Match.value(verdict).pipe(Match.when("none", () => plain), Match.orElse(() => `${HAND_BACK} ${line}`))

/** Ascending order of names, by UTF-16 code units. */
const byName = Order.String

/** An implementor's start in `root`, with its hand-back line (none for `none`), waited out until its hand-back is in the logs. */
const implement = Effect.fn("OrchTools.implement")(function* (run: Run, root: string, unit: string, round: number, description: string, verdict: "ready" | "blocked" | "none") {
  // A ready implementor has written its round's request, naming its Rift's head, before it hands back.
  if (verdict === "ready") run.files.set(`${RUN_DIR}/${unit}/round-${round}-request.md`, { text: `Head: ${requestHeadFor(unit, round)}\n`, at: run.world.now() })
  const prompt = promptOf(verdict, "Work on it.", `implementor ${unit} r${round}: ${verdict} ${READY}`)
  const answer = yield* run.probe(root, "subagent", { agent: "implementor", description, prompt, background: true })
  yield* run.world.until(run.settled, 60_000)
  const expected = stateOf(verdict)
  if (!answer.error) yield* run.world.until(() => Option.exists(Option.fromUndefinedOr(run.logs.get(unit)), (log) => log.state === expected && log.round === round), 30_000)
  return answer
})

// ── A1, model-based ──

/** The commands of one seed's run: within the file's CPU budget (sim/seed.ts `BUDGET_MS`) at 20 seeds. */
const STEPS = 16
const UNITS = ["u1", "u2", "u3", "u4"] as const

interface Lane {
  readonly path: string
  readonly branch: string
}

/** A verify of main the model made: its name, batch file, head, and the merges main held then. */
interface MainVerify {
  readonly name: string
  readonly file: string
  readonly head: string
  readonly total: number
}

/**
 * The reference model: each unit's log as the plugin must have written it, each unit's lane (its Rift), the merges on
 * main so far, the verifies of main made, and the one whose findings were written last.
 */
interface Model {
  readonly logs: Map<string, UnitLog>
  readonly lanes: Map<string, Lane>
  readonly main: { total: number; verified: Option.Option<MainVerify>; readonly made: Map<string, MainVerify> }
}

const NO_UNITS = `orchestrate: no run of this repository holds a unit; orchestrate({ action: "lane", unit: "<unit>" }) starts one.`

/**
 * The lands main holds since the last verify, as the model counts them; with none, at most the five the first verify
 * takes. Each land here is a merge (one per unit), so the count is the merges.
 */
const landsSince = (model: Model): number =>
  Option.match(model.main.verified, { onNone: () => Math.min(model.main.total, VERIFY_EVERY), onSome: (verify) => model.main.total - verify.total })

/** The start of the line a land's and a status's answer start with when a verify of main is due (a run dir exists); none when it is not. */
const duePrefix = (model: Model): Option.Option<string> =>
  Option.liftPredicate(`orchestrate: ${landsSince(model)} lands on main since the last verify (`, () => model.logs.size > 0 && landsSince(model) >= VERIFY_EVERY)

/** Status as the model renders it, after its due line: the run's open units with their states and lanes, and the one next call. */
const rendered = (model: Model): string => {
  const units = [...model.logs].filter(([, log]) => !isClosed(log)).toSorted(([a], [b]) => byName(a, b))
  const dueNext = `next: orchestrate({ action: "verify" }) (${landsSince(model)} lands on main since the last verify).`
  if (units.length === 0) return Option.match(duePrefix(model), { onNone: () => NO_UNITS, onSome: () => [NO_UNITS, dueNext].join("\n") })
  const laneOf = (unit: string) =>
    Option.match(Option.fromUndefinedOr(model.lanes.get(unit)), { onNone: () => "no lane", onSome: (lane) => `lane ${lane.path} (branch ${lane.branch})` })
  const ready = units.flatMap(([unit, log]) => Option.toArray(Option.liftPredicate(unit, () => log.state === "ready" && model.lanes.has(unit))))
  const implementing = units.flatMap(([unit, log]) => Option.toArray(Option.liftPredicate(unit, () => log.state === "implement")))
  const next = Arr.match(ready, {
    onNonEmpty: (named) => `next: orchestrate({ action: "land" }) (ready with a lane: ${named.join(", ")}).`,
    onEmpty: () =>
      Option.match(duePrefix(model), {
        onSome: () => dueNext,
        onNone: () =>
          Arr.match(implementing, {
            onNonEmpty: (named) => `next: wait for the hand-backs of ${named.join(", ")} (implementing).`,
            onEmpty: () => "next: none (no unit is ready with a lane or implementing, and no verify is due).",
          }),
      }),
  })
  return [`orchestrate: run ${RUN}:`, ...units.map(([unit, log]) => `- ${unit}: ${log.state} · ${laneOf(unit)}`), next].join("\n")
}

/** An answer checked against the model's due line: it starts with it when one is due, then `rest`; else it is `rest` alone. */
const dueChecked = (model: Model, text: string): { readonly due: boolean; readonly rest: string } => {
  const prefix = duePrefix(model)
  const [first = "", ...others] = text.split("\n")
  return Option.match(prefix, {
    onNone: () => ({ due: first.includes("since the last verify ("), rest: text }),
    onSome: (start) => ({ due: first.startsWith(start) && first.endsWith(`: orchestrate({ action: "verify" }).`), rest: others.join("\n") }),
  })
}

/** The base a verify of main takes in the world: the last verified head, else the fifth merge back, else the oldest's parent, else the head. */
const baseIn = (run: Run, model: Model): string => {
  const line = run.memory.main.line()
  const merges = line.filter((entry) => entry.merged.length > 0).toReversed()
  return Option.match(model.main.verified, {
    onSome: (verify) => verify.head,
    onNone: () =>
      Option.getOrElse(
        Option.orElse(
          Option.map(Arr.get(merges, VERIFY_EVERY), (entry) => entry.sha),
          () => Option.flatMap(Arr.last(merges), (oldest) => Option.map(Arr.get(line, line.indexOf(oldest) - 1), (entry) => entry.sha)),
        ),
        () => Option.getOrElse(Option.map(Arr.last(line), (entry) => entry.sha), () => ""),
      ),
  })
}

/** The batch file a verify of main's answer says it wrote. */
const batchFileIn = (answer: string): Option.Option<string> => Option.flatMap(Option.fromNullishOr(/^Batch file written: (.+)\.$/m.exec(answer)), (match) => Arr.get(match, 1))

/** When the next findings are written: after every file before them, on the world's clock. */
const stampOf = (run: Run): number => Math.max(run.world.now(), ...[...run.files.values()].map((file) => file.at + 1))

seeded("A1: no batch rule refuses, and a land takes what it names", ({ seed, expect }) =>
  Effect.gen(function* () {
    const random = rng(seed)
    const pick = <A,>(list: ReadonlyArray<A>, fallback: A): A => Option.getOrElse(Arr.get(list, Math.floor(random() * list.length)), () => fallback)
    const coin = () => random() < 0.5
    // Main holds zero to six merges from before the run, so a seed's lands reach a due verify of main.
    const earlier = Math.floor(random() * 7)
    const run = yield* boot(seed, true, { merges: earlier })
    const roots = [yield* run.world.session(WORK)]
    const root = () => roots.at(-1) ?? ""
    const model: Model = { logs: new Map(), lanes: new Map(), main: { total: earlier, verified: Option.none(), made: new Map() } }
    const batches = { count: 0 }

    /** A call's answer, checked: it fails only when the model says it must, and never in the machine's words. */
    const checked = (answer: { readonly text: string; readonly error: boolean }, fails: boolean, what: string) => {
      expect([what, answer.error, answer.text]).toEqual([what, fails, expect.any(String)])
      expect(answer.text).not.toMatch(MACHINE_WORDS)
    }

    const lane = Effect.fn("A1.lane")(function* () {
      const unit = pick(UNITS, "u1")
      const branch = pick([Option.none(), Option.some(`custom/${unit}`), Option.some(`${RUN}/${unit}`)], Option.none<string>())
      const answer = yield* run.probe(root(), ORCHESTRATE, Option.match(branch, { onNone: () => ({ action: "lane", unit }), onSome: (named) => ({ action: "lane", unit, branch: named }) }))
      checked(answer, false, `lane ${unit}`)
      expect(suffixOf(answer.text)).toBe(pathOf(unit))
      if (!model.lanes.has(unit)) model.lanes.set(unit, { path: pathOf(unit), branch: Option.getOrElse(branch, () => `feat/${unit}`) })
    })

    const start = Effect.fn("A1.implementor")(function* () {
      const unit = pick(UNITS, "u1")
      const round = 1 + Math.floor(random() * 3)
      const verdict = pick(["ready", "ready", "blocked", "none"] as const, "ready")
      const suffixes = [
        ...Option.toArray(Option.filter(Option.map(Option.fromUndefinedOr(model.lanes.get(unit)), (found) => pick([laneNote(found.path), `(rift: ${found.path})`], laneNote(found.path))), coin)),
        ...Arr.filter([`(folds: ${pick(UNITS, "u1")}/M1)`], coin),
        ...Arr.filter(["(departs: the owner asked)"], () => random() < 0.3),
      ]
      const answer = yield* implement(run, root(), unit, round, [`implementor ${unit} r${round}`, ...suffixes].join(" "), verdict)
      checked(answer, false, `implementor ${unit} r${round}`)
      model.logs.set(unit, { state: stateOf(verdict), round })
    })

    const verifier = Effect.fn("A1.verifier")(function* () {
      const made = [...model.main.made.keys()]
      const name = pick([`batch-${(batches.count += 1)}`, pick(UNITS, "u1"), "main-abc1234", ...made, ...made], "batch-1")
      const verdict = pick(["accepted", "changes", "none"] as const, "accepted")
      // A verifier of main writes its findings beside the batch file before it hands back, as protocol.md has it.
      const main = Option.fromUndefinedOr(model.main.made.get(name))
      const findings = Option.getOrElse(Option.map(main, (verify) => verify.file.replace(/\.md$/, "-findings.md")), () => FINDINGS)
      if (Option.isSome(main) && verdict !== "none") {
        run.files.set(findings, { text: `verifier ${name} r1: ${verdict} ${findings}\n`, at: stampOf(run) })
        model.main.verified = main
      }
      const prompt = promptOf(verdict, "Verify it.", `verifier ${name} r1: ${verdict} ${findings}`)
      const answer = yield* run.probe(root(), "subagent", { agent: "verifier", description: `verifier ${name} r1`, prompt, background: true })
      checked(answer, false, `verifier ${name}`)
      // Half of them are left running: the next verifier starts while this one works.
      if (coin()) yield* run.world.until(run.settled, 60_000)
    })

    /** A land by the `orchestrate` tool: no units, some by name, some as { unit, path }, with or without departs. */
    const land = Effect.fn("A1.land")(function* () {
      const form = pick(["none", "names", "paths", "unknown", "malformed"] as const, "none")
      const laned = [...model.lanes.keys()].toSorted()
      const named = laned.filter(coin)
      const pathOfLane = (unit: string) => Option.getOrElse(Option.map(Option.fromUndefinedOr(model.lanes.get(unit)), (found) => found.path), () => "")
      // The units it names, and whether each goes by its path too.
      const asked: ReadonlyArray<{ readonly unit: string; readonly path: Option.Option<string> }> = Match.value(form).pipe(
        Match.when("names", () => named.map((unit) => ({ unit, path: Option.none<string>() }))),
        Match.when("paths", () => named.map((unit) => ({ unit, path: Option.some(pathOfLane(unit)) }))),
        Match.when("unknown", () => [{ unit: "zz9", path: Option.none<string>() }]),
        Match.orElse(() => []),
      )
      const departs: Input = Object.fromEntries(Arr.filter([["departs", "the owner asked for it"] as const], coin))
      const units: ReadonlyArray<Schema.Json> = asked.map((each) => Option.match(each.path, { onNone: () => each.unit, onSome: (path) => ({ unit: each.unit, path }) }))
      const malformed = form === "malformed"
      // A malformed land names one `unit`, not `units`; one with no units lands every unit ready with a lane.
      const input: Input = Match.value({ malformed, units }).pipe(
        Match.when({ malformed: true }, () => ({ action: "land", unit: pick(UNITS, "u1") })),
        Match.orElse(() => Arr.match(units, { onEmpty: () => ({ action: "land", ...departs }), onNonEmpty: (list) => ({ action: "land", units: list, ...departs }) })),
      )
      const allReady = () => [...model.logs].flatMap(([unit, log]) => Option.toArray(Option.liftPredicate(unit, () => !malformed && log.state === "ready" && model.lanes.has(unit)))).toSorted(byName)
      const targets = Arr.match(asked, { onEmpty: allReady, onNonEmpty: (list) => list.map((each) => each.unit) })
      const fails = malformed || targets.some((unit) => !model.lanes.has(unit))
      const from = run.memory.landing.steps.length
      const starts = startsOf(run)
      const answer = yield* run.probe(root(), ORCHESTRATE, input)
      checked(answer, fails, `land ${form} ${targets.join(",")}`)
      if (fails || targets.length === 0) {
        expect(startsOf(run)).toBe(starts)
        return
      }
      // The land reached the rift plugin with exactly the Rifts the model resolves.
      expect(mergedSince(run, from).toSorted()).toEqual(targets.map((unit) => model.lanes.get(unit)?.branch ?? "").toSorted())
      // It starts with the due line when a verify of main was due before it, then warns of each named unit the run
      // tables show in another state than ready; it lands.
      const due = dueChecked(model, answer.text)
      expect({ due: due.due }).toEqual({ due: Option.isSome(duePrefix(model)) })
      const open = (unit: string) => Option.filter(Option.fromUndefinedOr(model.logs.get(unit)), (log) => !isClosed(log))
      const warned = Arr.filter(targets, () => asked.length > 0).flatMap((unit) => Option.toArray(Option.filter(open(unit), (log) => log.state !== "ready").pipe(Option.map((log) => warningOf(unit, log.state)))))
      expect(due.rest.split("\n").slice(0, warned.length)).toEqual(warned)
      if (warned.length === 0) expect(due.rest).not.toContain("orchestrate: warning: ")
      // The log follows the land: each unit the tables showed moves to merged. A pushed land trashes the Rifts it landed.
      for (const unit of targets) Option.map(open(unit), (log) => model.logs.set(unit, { state: "merged", round: Math.max(log.round, 1) }))
      for (const unit of targets) model.lanes.delete(unit)
      model.main.total += targets.length
    })

    /** A land by the `rift` tool: the Rifts as paths or { path, unit }. */
    const riftLand = Effect.fn("A1.riftLand")(function* () {
      const laned = [...model.lanes].toSorted(([a], [b]) => byName(a, b)).filter(coin)
      if (laned.length === 0) return
      const rifts: ReadonlyArray<Schema.Json> = laned.map(([unit, found]) => Option.getOrElse(Option.map(Option.liftPredicate(found.path, coin), (path): Schema.Json => path), (): Schema.Json => ({ path: found.path, unit })))
      const from = run.memory.landing.steps.length
      const answer = yield* run.probe(root(), "rift", { action: "land", rifts })
      checked(answer, false, `rift land ${laned.map(([unit]) => unit).join(",")}`)
      expect(mergedSince(run, from).toSorted()).toEqual(laned.map(([, found]) => found.branch).toSorted())
      for (const [unit] of laned) model.lanes.delete(unit)
      model.main.total += laned.length
    })

    const verify = Effect.fn("A1.verify")(function* () {
      const batch = pick([Option.some(`batch-${batches.count + 1}`), Option.some(pick(UNITS, "u1")), Option.some("main-abc1234"), Option.none<string>(), Option.none<string>()], Option.none<string>())
      const answer = yield* run.probe(root(), ORCHESTRATE, Option.match(batch, { onNone: () => ({ action: "verify" }), onSome: (named) => ({ action: "verify", batch: named }) }))
      checked(answer, false, `verify ${Option.getOrElse(batch, () => "main")}`)
      if (Option.isSome(batch)) {
        expect(answer.text).toContain(`subagent({ agent: "verifier", description: "verifier ${batch.value} r1"`)
        return
      }
      // A verify of main: named for the head, its batch file written (with a run dir) from the base the model names.
      const head = Option.getOrElse(Option.map(Arr.last(run.memory.main.line()), (entry) => entry.sha), () => "")
      const name = `batch-main-${head.slice(0, 7)}`
      expect(answer.text).toContain(`subagent({ agent: "verifier", description: "verifier ${name} r1"`)
      const file = batchFileIn(answer.text)
      if (model.logs.size === 0) {
        expect(answer.text).toContain("No run dir is known, so no batch file was written")
        return
      }
      expect(file).toEqual(Option.some(`${RUN_DIR}/verify-main-${head.slice(0, 7)}/${name}.md`))
      const text = Option.getOrElse(Option.map(Option.flatMap(file, (path) => Option.fromUndefinedOr(run.files.get(path))), (written) => written.text), () => "")
      const lines = text.split("\n")
      expect(lines).toContain(`Base: ${baseIn(run, model)}`)
      expect(lines).toContain(`Head: ${head}`)
      expect(lines.filter((line) => /^Heads: dotfiles=[0-9a-f]{40} fork=[0-9a-f]{40}$/.test(line))).toEqual([`Heads: dotfiles=${head} fork=${FORK_HEAD}`])
      expect(Result.isSuccess(headsOf(text))).toBe(true)
      model.main.made.set(name, { name, file: Option.getOrElse(file, () => ""), head, total: model.main.total })
    })

    const commands: ReadonlyArray<readonly [number, () => Effect.Effect<unknown, unknown>]> = [
      [10, lane],
      [14, start],
      [6, verifier],
      [12, land],
      [3, riftLand],
      [4, verify],
      [2, () => run.world.restart],
      [2, () => Effect.map(run.world.session(WORK), (next) => void roots.push(next))],
    ]
    const total = commands.reduce((sum, [weight]) => sum + weight, 0)
    for (const _ of Array.from({ length: STEPS })) {
      let roll = random() * total
      const chosen = Option.getOrElse(
        Arr.findFirst(commands, ([weight]) => (roll -= weight) < 0),
        () => commands[0] ?? [0, () => Effect.void],
      )
      yield* chosen[1]()
      // Status is the model's rendering, from whichever root asks, after every command: its due line first when one is due.
      const status = yield* run.probe(root(), ORCHESTRATE, { action: "status" })
      const due = dueChecked(model, status.text)
      expect([status.error, due.due, due.rest]).toEqual([false, Option.isSome(duePrefix(model)), rendered(model)])
    }
  }),
)

// ── B3: main since the last verify (its due line over five lands is in batch-files.sim.test.ts) ──

seeded("B3: a land of a unit with an open changes verdict lands and warns; once a newer round's request is in, it does not", ({ seed, expect }) =>
  Effect.gen(function* () {
    const run = yield* boot(seed, true)
    const root = yield* run.world.session(WORK)
    yield* run.probe(root, ORCHESTRATE, { action: "lane", unit: "a" })
    yield* implement(run, root, "a", 1, "implementor a r1", "ready")
    const findings = `${RUN_DIR}/a/round-1-findings.md`
    run.files.set(findings, { text: `verifier batch-1 r1: changes ${findings}\n`, at: stampOf(run) })
    const from = run.memory.landing.steps.length
    const landed = yield* run.probe(root, ORCHESTRATE, { action: "land", units: ["a"] })
    expect([landed.error, landed.text.split("\n")[0]]).toEqual([false, `orchestrate: warning: a lands with r1's changes verdict open (${findings}).`])
    expect(mergedSince(run, from)).toEqual(["feat/a"])
    // The log follows the land.
    expect(run.logs.get("a")).toEqual({ state: "merged", round: 1 })
    // Round 2's request answers the verdict: its land warns of nothing.
    yield* run.probe(root, ORCHESTRATE, { action: "lane", unit: "b" })
    yield* implement(run, root, "b", 2, "implementor b r2", "ready")
    run.files.set(`${RUN_DIR}/b/round-1-findings.md`, { text: "verifier batch-1 r1: changes /x\n", at: stampOf(run) })
    const quiet = yield* run.probe(root, ORCHESTRATE, { action: "land", units: ["b"] })
    expect([quiet.error, quiet.text]).toEqual([false, expect.not.stringContaining("orchestrate: warning:")])
  }),
)

// ── A2 to A6 ──

seeded("A2: a restart and a new root lose nothing: the new root lands the unit the old one laned", ({ seed, expect }) =>
  Effect.gen(function* () {
    const run = yield* boot(seed, true)
    const root = yield* run.world.session(WORK)
    const laned = yield* run.probe(root, ORCHESTRATE, { action: "lane", unit: "a" })
    yield* implement(run, root, "a", 1, `implementor a r1 ${laneNote(suffixOf(laned.text))}`, "ready")
    yield* run.world.restart
    const next = yield* run.world.session(WORK)
    const from = run.memory.landing.steps.length
    const landed = yield* run.probe(next, ORCHESTRATE, { action: "land", units: ["a"] })
    expect([landed.error, landed.text]).toEqual([false, expect.not.stringContaining("orchestrate: warning")])
    expect(mergedSince(run, from)).toEqual(["feat/a"])
  }),
)

seeded("A3: a land of a unit that is not ready warns and lands", ({ seed, expect }) =>
  Effect.gen(function* () {
    const run = yield* boot(seed, true)
    const root = yield* run.world.session(WORK)
    for (const unit of ["a", "b"]) yield* run.probe(root, ORCHESTRATE, { action: "lane", unit })
    yield* implement(run, root, "a", 1, "implementor a r1", "blocked")
    yield* implement(run, root, "b", 2, "implementor b r2", "none")
    const from = run.memory.landing.steps.length
    const landed = yield* run.probe(root, ORCHESTRATE, { action: "land", units: ["a", "b"] })
    expect(landed.error).toBe(false)
    expect(landed.text.split("\n").slice(0, 2)).toEqual([warningOf("a", "blocked"), warningOf("b", "implement")])
    expect(mergedSince(run, from)).toEqual(["feat/a", "feat/b"])
  }),
)

/** Friday 30 October 2026, 19:00 in Knowlton (EDT): after sunset, in the Sabbath. */
const FRIDAY_EVENING = "2026-10-30T23:00:00Z"
/** A Codex model, the only one the host offers. */
const SOL: World.CatalogModel = { providerID: "openai", id: "gpt-6.1-sol", modelID: "gpt-6.1-sol", limit: { context: 400_000 }, cost: [], family: "gpt-sol", variants: [{ id: "high" }] }

seeded("A4: the harm rules still refuse: a subagent's land, an implementor on Codex, a start over the Sabbath", ({ seed, expect }) =>
  Effect.gen(function* () {
    const run = yield* boot(seed, true)
    const root = yield* run.world.session(WORK)
    yield* run.probe(root, ORCHESTRATE, { action: "lane", unit: "a" })
    const child = yield* run.world.session(WORK, { parentID: root })
    const childLand = yield* run.probe(child, ORCHESTRATE, { action: "land", units: ["a"] })
    expect([childLand.error, childLand.text]).toEqual([true, expect.stringContaining(PARENT_LAND)])
    expect(startsOf(run)).toBe(0)

    const codex = yield* boot(seed, true, { models: [SOL] })
    const onSol = yield* codex.world.session(WORK, { model: { providerID: SOL.providerID, id: SOL.id } })
    const implementor = yield* codex.probe(onSol, "subagent", { agent: "implementor", description: "implementor a r1", prompt: "Build it.", background: true })
    expect([implementor.error, implementor.text]).toEqual([true, expect.stringContaining("Codex never implements")])

    const sabbath = yield* boot(seed, true, { now: FRIDAY_EVENING })
    const resting = yield* sabbath.world.session(WORK)
    const held = yield* sabbath.probe(resting, "subagent", { agent: "implementor", description: "implementor a r1", prompt: "Build it.", background: true })
    expect([held.error, held.text]).toEqual([true, expect.stringMatching(/It is the Sabbath; agent work resumes at Sat/)])
  }),
)

seeded("A5: no ledger is kept and old options load: no shell hook writes a drops journal, and a config naming ledger, cadence, guard and drops starts", ({ seed, expect }) =>
  Effect.gen(function* () {
    const run = yield* boot(seed, true)
    // The orchestrate plugin hooks no shell: no `ORCHESTRATE_DROPS` for log.ts, no journal it reads back.
    expect(run.world.hooked(World.SHELL_CREATE)).toBe(0)
    // A config an older install wrote still loads, and the tool answers.
    const old = yield* boot(seed, false)
    yield* old.world.load(Plugins.orchestrate(), {
      directory: WORK,
      options: {
        now: "2026-11-04T15:00:00Z",
        ledger: "/nonexistent/loop-probe-x/ledger.jsonl",
        drops: "/nonexistent/loop-probe-x/drops.jsonl",
        cadence: { ready: 3, waitMs: 1_800_000 },
        guard: "refuse",
      },
    })
    const root = yield* old.world.session(WORK)
    const status = yield* old.probe(root, ORCHESTRATE, { action: "status" })
    expect(status.error).toBe(false)
  }),
)

seeded("A6: an accepted verdict publishes the fleet target once, however often its session goes idle after; changes and a non-verifier publish nothing", ({ seed, expect }) =>
  Effect.gen(function* () {
    const run = yield* boot(seed, true)
    const root = yield* run.world.session(WORK)
    const start = (agent: string, description: string, line: string) =>
      run.probe(root, "subagent", { agent, description, prompt: `${HAND_BACK} ${line}`, background: true }).pipe(Effect.andThen(run.world.until(run.settled, 60_000)))
    yield* start("verifier", "verifier batch-1 r1", `verifier batch-1 r1: accepted ${FINDINGS}`)
    expect(run.fleet).toEqual([{ report: FINDINGS, batch: "batch-1" }])
    // The verifier goes idle again, twice, its last words the same verdict.
    const verifier = Option.getOrElse(Option.map(Arr.last(run.children(root)), (session) => session.id), () => "")
    for (const _ of [1, 2]) {
      yield* run.world.prompt(verifier, "Anything else?")
      yield* run.world.until(run.settled, 60_000)
    }
    yield* start("verifier", "verifier batch-2 r1", `verifier batch-2 r1: changes ${FINDINGS}`)
    yield* start("implementor", "implementor a r1", `verifier batch-3 r1: accepted ${FINDINGS}`)
    expect(run.fleet).toEqual([{ report: FINDINGS, batch: "batch-1" }])
  }),
)

// ── The rift tool's description, and the tool's name ──

seeded("the rift tool points a run's root at orchestrate and still tells a plain session create, list, remove and land", ({ expect }) =>
  Effect.sync(() => {
    expect(RIFT_DESCRIPTION).toContain("A root session that runs orchestrate units makes and lands its units' Rifts with the orchestrate tool's lane and land")
    for (const action of ["create", "list", "remove", "land"]) expect(RIFT_DESCRIPTION).toContain(`${action} ({ action: "${action}"`)
  }),
)

seeded("no registered tool is one edit from orchestrate", ({ expect }) =>
  Effect.gen(function* () {
    const run = yield* boot(1, true)
    const root = yield* run.world.session(WORK)
    yield* run.probe(root, ORCHESTRATE, { action: "status" })
    expect(run.offered).toContain(ORCHESTRATE)
    const names = run.offered.filter((name) => name !== ORCHESTRATE)
    expect(names).toContain("rift")
    expect(nearest(ORCHESTRATE, names)).toBeUndefined()
    for (const name of names) expect(nearest(name, [ORCHESTRATE])).toBeUndefined()
  }),
)

// The plain warm source runs no units: its root's status says so.
seeded("a root of another warm source runs no units", ({ seed, expect }) =>
  Effect.gen(function* () {
    const run = yield* boot(seed, true)
    const plain = yield* run.world.session(PLAIN)
    const status = yield* run.probe(plain, ORCHESTRATE, { action: "status" })
    expect(status.text).toBe(`orchestrate: no run of this repository holds a unit; orchestrate({ action: "lane", unit: "<unit>" }) starts one.`)
  }),
)
