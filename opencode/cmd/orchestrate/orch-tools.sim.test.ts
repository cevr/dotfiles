// The `orchestrate` tool on the simulated host (orch-tools-world.ts): the real orchestrate plugin and the real rift
// plugin on its memory layers, at 20 seeds.
//
// - A whole batch through the new actions: status, three lanes, three implementors on the lanes' suffixes, a land
//   with no input, a verify, its verifier, and status once its verdict is in.
// - Model-based: a seeded run of generated commands against a reference model of the root's units, lanes and pending
//   verdict, on three worlds in lockstep. A: the tool. B: the same run, each land made as the `rift` land naming the
//   Rifts A's land resolves to (the machine must decide both alike). C: the rift plugin alone, for the plain
//   session's calls (its answers must be byte for byte C's).
// - The next call (`nextOf`) on the real decider, the workbox's lane naming, the rift tool's description, and the
//   tool's name against the registry's.
import { type Command, DEFAULT_CADENCE, dueOf, HandBack, Land, machine, type MachineState, Start, UnitStarted, verdictPending } from "@dotfiles/opencode-orchestrate/machine"
import { driftOf, scoreOf } from "@dotfiles/opencode-orchestrate/drift"
import {
  aliasLine,
  existingLanes,
  type Lane,
  LAND_NEXT,
  laneBranchOf,
  NO_UNITS,
  nextOf,
  ORCHESTRATE,
  parentRefusal,
  resolveLand,
} from "@dotfiles/opencode-orchestrate/tools"
import { RIFT_DESCRIPTION } from "@dotfiles/opencode-rift/rift"
import { workriftName } from "@dotfiles/opencode-rift/rpc"
import { Array as Arr, Cause, Effect, Exit, Option, Predicate } from "effect"
import { nearest } from "../../mods/tool-names/near-miss.ts"
import * as Seed from "../../sim/seed.ts"
import { boot, HAND_BACK, type Input, ORIGIN, PLAIN, type Run, WORK } from "./orch-tools-world.ts"

const { seeded } = Seed.runner("cmd/orchestrate/orch-tools.sim.test.ts")

const READY = "/nonexistent/loop-probe-x/request.md"
const FINDINGS = "/nonexistent/loop-probe-x/findings.md"
const RUN = "/scratch/run"
const UNITS = ["alpha", "beta", "gamma"] as const

/** The Rift a lane's answer ends with: its `(rift: <path>)`. */
const suffixOf = (answer: string): string => Option.getOrElse(Option.flatMap(Option.fromNullishOr(/\(rift: ([^)]+)\)\s*$/.exec(answer)), (match) => Arr.get(match, 1)), () => "")

/** The Rift a lane of `unit` makes on the Mac, in the run's warm source. */
const pathOf = (unit: string) => `/scratch/.rifts/work/${unit}`

/** One root's calls, each one probe turn. */
const rootOf = (run: Run, root: string) => {
  const orchestrate = (input: Input) => run.probe(root, ORCHESTRATE, input)
  const handBacks = (unit: string) => run.lines(root).filter((line) => line.kind === "UnitHandedBack" && line.unit === unit).length
  /** An implementor started on its lane, waited out to its hand-back; its answer. */
  const implement = Effect.fn("OrchTools.implement")(function* (unit: string, round: number, description: string, verdict: string) {
    const before = handBacks(unit)
    const answer = yield* run.probe(root, "subagent", {
      agent: "implementor",
      description,
      prompt: `${HAND_BACK} implementor ${unit} r${round}: ${verdict} ${READY}`,
      background: true,
    })
    if (!answer.error) yield* run.world.until(() => handBacks(unit) > before, 30_000)
    return answer
  })
  return { orchestrate, implement }
}

seeded("a whole batch through the new actions: three lanes, one land of the three, one verify, one verifier, no rift call", ({ seed, expect }) =>
  Effect.gen(function* () {
    const run = yield* boot(seed, true)
    const root = yield* run.world.session(WORK)
    const at = rootOf(run, root)
    expect((yield* at.orchestrate({ action: "status" })).text).toBe(NO_UNITS)
    const lanes = yield* Effect.forEach(UNITS, (unit) => at.orchestrate({ action: "lane", unit }))
    const paths = lanes.map((lane) => suffixOf(lane.text))
    expect(paths).toEqual(UNITS.map(pathOf))
    yield* Effect.forEach(UNITS, (unit, index) => at.implement(unit, 1, `implementor ${unit} r1 (rift: ${paths[index] ?? ""})`, "ready"), { discard: true })

    // A land typed as a lane, and a lane typed as a land, never run; a subagent lands nothing and is answered status.
    const typo = yield* at.orchestrate({ action: "land", unit: "alpha" })
    expect([typo.error, typo.text]).toEqual([true, expect.stringContaining("land takes no unit: unit belongs to lane")])
    const swapped = yield* at.orchestrate({ action: "lane", units: ["alpha"] })
    expect([swapped.error, swapped.text]).toEqual([true, expect.stringContaining("lane takes no units: units belongs to land")])
    const child = yield* run.world.session(WORK, { parentID: root })
    const childLand = yield* run.probe(child, ORCHESTRATE, { action: "land" })
    expect([childLand.error, childLand.text]).toEqual([true, expect.stringContaining(parentRefusal("land"))])
    expect((yield* run.probe(child, ORCHESTRATE, { action: "status" })).error).toBe(false)
    expect(run.memory.landing.steps).toEqual([])

    const landed = yield* at.orchestrate({ action: "land" })
    expect(landed.text.endsWith(LAND_NEXT)).toBe(true)
    const verified = yield* at.orchestrate({ action: "verify", batch: "batch-1" })
    expect(verified.text).toContain('subagent({ agent: "verifier", description: "verifier batch-1 r1"')
    yield* run.probe(root, "subagent", { agent: "verifier", description: "verifier batch-1 r1", prompt: `${HAND_BACK} verifier batch-1 r1: accepted ${FINDINGS}`, background: true })
    yield* run.has(root, (line) => line.kind === "VerifierEnded")
    const last = yield* at.orchestrate({ action: "status" })

    // One land, of the three lanes' branches.
    const steps = run.memory.landing.steps
    expect(steps.filter((step) => step.startsWith("start "))).toHaveLength(1)
    expect(steps.filter((step) => step.startsWith("merge "))).toEqual(UNITS.map((unit) => `merge feat/${unit}`))
    // The ledger: no refusal, no departure, one batch of the three, one verifier over them; no drift.
    const ledger = run.lines(root)
    const kinds = ledger.map((line) => line.kind)
    expect(kinds).not.toContain("Refused")
    expect(kinds).not.toContain("Departed")
    expect(ledger.filter((line) => line.kind === "BatchLanded").map((line) => line.units)).toEqual([[...UNITS]])
    expect(ledger.filter((line) => line.kind === "VerifierStarted").map((line) => line.units)).toEqual([[...UNITS]])
    expect(scoreOf(driftOf(DEFAULT_CADENCE, run.written(root)))).toBe(0)
    // The root made no rift call.
    expect(run.world.messages(root).filter((message) => message.type === "tool" && message.name === "rift")).toEqual([])
    // The verify lane, detached at the pushed head (origin's, read then).
    const pushed = run.memory.landing.headOf(run.memory.landing.pushes)
    const verify = Option.fromUndefinedOr(run.memory.rifts.rifts.get("/scratch/.rifts/work/verify-batch-1"))
    expect(Option.map(verify, (rift) => [Predicate.isUndefined(rift.branch), rift.head])).toEqual(Option.some([true, pushed]))
    expect(verified.text).toContain(`detached at ${pushed} (origin's default branch head, read now)`)
    expect(ORIGIN).toBe("origin/HEAD")
    // The last status names no pending verdict.
    expect(last.text).not.toContain("landed and not verified:")
    expect(last.text).not.toContain('orchestrate({ action: "verify"')
  }),
)

// ── Model-based ──

/** The commands of one seed's run: within the file's CPU budget (sim/seed.ts `BUDGET_MS`) at 20 seeds, on three worlds. */
const STEPS = 18

type UnitState = "implement" | "ready" | "blocked" | "landed"

/** The reference model: the root's units, the Rift each lane made, the rounds started, and the verdict pending. */
interface Model {
  readonly states: Map<string, UnitState>
  readonly lanes: Map<string, string>
  readonly rounds: Map<string, number>
  /** Findings a changes verdict opened and no fix unit folded yet. */
  readonly findings: Array<string>
  /** The units of the last landed batch, while its verdict is pending. */
  pending: ReadonlyArray<string>
  batches: number
  fresh: number
  plain: number
}

const modelOf = (): Model => ({ states: new Map(), lanes: new Map(), rounds: new Map(), findings: [], pending: [], batches: 0, fresh: 0, plain: 0 })

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

/** A land's decision in the ledger: `Refused <rule>` or `BatchLanded <units>`, the lines appended from `from`. */
const decisionsOf = (run: Run, root: string, from: number) =>
  run
    .lines(root)
    .slice(from)
    .flatMap((line) =>
      Arr.match([line.kind].filter((kind) => kind === "Refused" || kind === "BatchLanded"), {
        onEmpty: () => [],
        onNonEmpty: () => [`${line.kind} ${line.rule ?? [...(line.units ?? [])].sort().join(",")}`],
      }),
    )

/** The ledger's story of a root, without its times and sessions: what the twins must agree on. */
const storyOf = (run: Run, root: string) =>
  run.lines(root).map((line) => [line.kind, line.rule ?? "", line.unit ?? "", [...(line.units ?? [])].join(","), line.batch ?? "", line.verdict ?? "", String(line.ready)].join(" "))

/** The three worlds of one seed, and each one's sessions. */
const twinsOf = Effect.fn("OrchTools.twins")(function* (seed: number) {
  const a = yield* boot(seed, true)
  const b = yield* boot(seed, true)
  const c = yield* boot(seed, false)
  const rootA = yield* a.world.session(WORK)
  const rootB = yield* b.world.session(WORK)
  const plainA = yield* a.world.session(PLAIN)
  const plainC = yield* c.world.session(PLAIN)
  return { a, b, c, rootA, rootB, plainA, plainC, atA: rootOf(a, rootA), atB: rootOf(b, rootB) }
})

/** The units a land of `asked` takes in the model, each with the Rift its lane made; none when one has no lane or the machine holds it not. */
const resolvedOf = (model: Model, asked: Option.Option<ReadonlyArray<string>>) => {
  const units = Option.getOrElse(asked, () => [...model.states].flatMap(([unit, state]) => Arr.match([state].filter((each) => each === "ready"), { onEmpty: () => [], onNonEmpty: () => [unit] })))
  const rifts = units.flatMap((unit) =>
    Option.toArray(Option.map(Option.filter(Option.fromUndefinedOr(model.lanes.get(unit)), () => model.states.has(unit)), (path) => ({ path, unit }))),
  )
  return Option.liftPredicate(rifts, (found) => found.length === units.length && found.length > 0)
}

seeded("model-based: a lane once, one decision per land, the same machine for both tools, lands of the ready set, status's next call, the plain session untouched, across restarts", ({ seed, expect }) =>
  Effect.gen(function* () {
    const random = rng(seed)
    const pick = <A,>(list: ReadonlyArray<A>, fallback: A): A => Option.getOrElse(Arr.get(list, Math.floor(random() * list.length)), () => fallback)
    const twins = yield* twinsOf(seed)
    const { a, b, c, rootA, rootB, plainA, plainC, atA, atB } = twins
    const model = modelOf()
    const unitsIn = (state: UnitState) => [...model.states].flatMap(([unit, each]) => Arr.match([each].filter((found) => found === state), { onEmpty: () => [], onNonEmpty: () => [unit] }))
    const workRifts = () => [...a.memory.rifts.rifts.keys()].filter((path) => path.startsWith("/scratch/.rifts/work/"))

    /** laneOnce: a lane, on both twins; a repeated one answers the same path and makes nothing. */
    const lane = Effect.fn("OrchTools.lane")(function* (unit: string, branch: Option.Option<string>) {
      const input: Input = Option.match(branch, { onNone: () => ({ action: "lane", unit }), onSome: (named) => ({ action: "lane", unit, branch: named }) })
      const before = workRifts()
      const had = Option.fromUndefinedOr(model.lanes.get(unit))
      const answer = yield* atA.orchestrate(input)
      yield* atB.orchestrate(input)
      expect(answer.error).toBe(false)
      const path = suffixOf(answer.text)
      expect(path).toBe(pathOf(unit))
      if (Option.isSome(had) && Arr.contains(before, had.value)) {
        expect(path).toBe(had.value)
        expect(workRifts()).toEqual(before)
      }
      model.lanes.set(unit, path)
      // A unit has at most one live Rift.
      for (const each of model.lanes.keys()) expect(workRifts().filter((rift) => rift === pathOf(each) || rift.endsWith(`/${each}`)).length).toBeLessThanOrEqual(1)
    })

    /** An implementor's start and hand-back on both twins; the model follows A's ledger. */
    const implement = Effect.fn("OrchTools.implementBoth")(function* (unit: string, verdict: "ready" | "blocked") {
      const round = Option.getOrElse(Option.fromUndefinedOr(model.rounds.get(unit)), () => 0) + 1
      const folds = Arr.filter(model.findings, (finding) => `${finding.split("/")[0] ?? ""}-fix1` === unit)
      const suffix = Arr.match(folds, { onEmpty: () => "", onNonEmpty: (named) => ` (folds: ${named.join(", ")})` })
      const description = `implementor ${unit} r${round} (rift: ${model.lanes.get(unit) ?? ""})${suffix}`
      const answer = yield* atA.implement(unit, round, description, verdict)
      yield* atB.implement(unit, round, description, verdict)
      if (answer.error) return
      model.rounds.set(unit, round)
      for (const finding of folds) model.findings.splice(model.findings.indexOf(finding), 1)
      model.states.set(unit, Option.getOrElse(Option.liftPredicate("ready" as const, () => verdict === "ready"), () => "blocked" as const))
    })

    /**
     * A land on A by `tool` (the `orchestrate` land, or the root's `rift` land), and on B as the `rift` land naming the
     * Rifts A's resolves to. oneDecision, sameMachine, landsReady.
     */
    const land = Effect.fn("OrchTools.land")(function* (tool: "orchestrate" | "rift", asked: Option.Option<ReadonlyArray<string>>, departs: Option.Option<string>) {
      const resolved = resolvedOf(model, asked)
      const ready = unitsIn("ready").toSorted()
      const fromA = a.lines(rootA).length
      const fromB = b.lines(rootB).length
      const startsA = a.memory.landing.steps.filter((step) => step.startsWith("start ")).length
      const withDeparts = (input: Input): Input => Option.match(departs, { onNone: () => input, onSome: (why) => ({ ...input, departs: why }) })
      const riftInput = withDeparts({ action: "land", rifts: Option.getOrElse(resolved, () => []).map((rift) => ({ path: rift.path, unit: rift.unit })) })
      const answer = yield* Option.match(Option.liftPredicate(tool, (named) => named === "orchestrate"), {
        onNone: () => a.probe(rootA, "rift", riftInput),
        onSome: () => atA.orchestrate(withDeparts(Option.match(asked, { onNone: () => ({ action: "land" }), onSome: (units) => ({ action: "land", units: [...units] }) }))),
      })
      if (Option.isNone(resolved)) {
        // Refused before the machine (no unit, or one with no Rift): no decision, no land.
        expect(answer.error).toBe(true)
        expect(decisionsOf(a, rootA, fromA)).toEqual([])
        expect(a.memory.landing.steps.filter((step) => step.startsWith("start ")).length).toBe(startsA)
        return
      }
      yield* b.probe(rootB, "rift", riftInput)
      const decidedA = decisionsOf(a, rootA, fromA)
      const decidedB = decisionsOf(b, rootB, fromB)
      // oneDecision: one decision per land call; a refused one reaches no Landing call.
      expect(`${decidedA.length} decision(s) of a ${tool} land: ${answer.text}`).toStartWith("1 decision(s)")
      // sameMachine: the rift land naming the same Rifts is decided alike.
      expect(decidedA).toEqual(decidedB)
      const landedA = a.lines(rootA).slice(fromA).filter((line) => line.kind === "BatchLanded")
      expect(landedA.length).toBeLessThanOrEqual(1)
      const decision = Arr.head(decidedA)
      if (Option.exists(decision, (line) => line.startsWith("Refused"))) {
        expect(answer.error).toBe(true)
        expect(a.memory.landing.steps.filter((step) => step.startsWith("start ")).length).toBe(startsA)
        return
      }
      expect(answer.error).toBe(false)
      const units = Option.getOrElse(Option.map(Arr.head(landedA), (line) => [...(line.units ?? [])].toSorted()), () => [])
      // landsReady: a land with no units lands exactly the model's ready set.
      if (Option.isNone(asked)) expect(units).toEqual(ready)
      // The alias: a `rift` land in a root that runs units starts with the orchestrate call.
      if (tool === "rift") expect(answer.text.startsWith(aliasLine("land"))).toBe(true)
      // The land trashed the landed Rifts: a unit's next round needs a new lane.
      for (const unit of units) {
        model.states.set(unit, "landed")
        model.lanes.delete(unit)
      }
      model.pending = units
    })

    /** The batch's verifier on both twins: its start, and its verdict once in. */
    const verifier = Effect.fn("OrchTools.verifier")(function* (verdict: "accepted" | "changes") {
      const batch = `batch-${model.batches + 1}`
      const first = Option.getOrElse(Arr.head(model.pending), () => "none")
      const report = `${RUN}/${batch}-findings.md`
      for (const run of [a, b]) {
        run.files.set(`${RUN}/${first}/round-1-findings.md`, `Verdict: CHANGES REQUIRED\n\n## Major\n\n### M1 — ${first} drops a line\n`)
        run.files.set(report, `changes\n\n| Unit | Round | Verdict | Findings |\n| --- | --- | --- | --- |\n| ${first} | 1 | changes | ${first}/round-1-findings.md |\n`)
      }
      const input: Input = { agent: "verifier", description: `verifier ${batch} r1`, prompt: `${HAND_BACK} verifier ${batch} r1: ${verdict} ${report}`, background: true }
      const started = (run: Run, root: string) => run.lines(root).filter((line) => line.kind === "VerifierStarted").length
      const before = started(a, rootA)
      yield* a.probe(rootA, "subagent", input)
      yield* b.probe(rootB, "subagent", input)
      if (started(a, rootA) === before) return
      yield* a.has(rootA, (line) => line.kind === "VerifierEnded" && line.batch === batch)
      yield* b.has(rootB, (line) => line.kind === "VerifierEnded" && line.batch === batch)
      model.batches += 1
      // The units its start covered (the machine's; a ready unit too, as one landed by hand) are done: the run holds them no longer.
      const covered = Option.getOrElse(
        Option.map(
          Arr.findLast(a.lines(rootA), (line) => line.kind === "VerifierStarted"),
          (line) => line.units ?? [],
        ),
        () => [],
      )
      for (const unit of covered) model.states.delete(unit)
      model.pending = []
      if (verdict === "changes") model.findings.push(`${first}/M1`)
    })

    /** A verify on both twins. */
    const verify = Effect.fn("OrchTools.verify")(function* (batch: string) {
      const answer = yield* atA.orchestrate({ action: "verify", batch })
      yield* atB.orchestrate({ action: "verify", batch })
      return answer
    })

    /** A rift call of the plain session, on A and on C: byte for byte C's answer, and no ledger line. */
    const plain = Effect.fn("OrchTools.plain")(function* (input: Input) {
      const answerA = yield* a.probe(plainA, "rift", input)
      const answerC = yield* c.probe(plainC, "rift", input)
      expect(answerA).toEqual(answerC)
      expect(a.lines(plainA)).toEqual([])
    })

    /** statusTruth: status names each unit of the model, and its next call, made next, is not refused. */
    const status = Effect.fn("OrchTools.status")(function* () {
      const answer = yield* atA.orchestrate({ action: "status" })
      yield* atB.orchestrate({ action: "status" })
      expect(answer.error).toBe(false)
      for (const unit of model.states.keys()) expect(answer.text).toContain(unit)
      const next = Option.getOrElse(Option.fromNullishOr(/^next: orchestrate\(\{ action: "(\w+)"(?:, unit: "([^"]+)")?/m.exec(answer.text)), () => [])
      const action = Option.getOrElse(Arr.get(next, 1), () => "none")
      const refusedBefore = a.lines(rootA).filter((line) => line.kind === "Refused").length
      if (action === "land") yield* land("orchestrate", Option.none(), Option.none())
      if (action === "verify") expect((yield* verify(`batch-${model.batches + 1}`)).error).toBe(false)
      if (action === "lane") {
        const named = Option.filter(Arr.get(next, 2), (unit) => unit !== "<unit>")
        yield* lane(Option.getOrElse(named, () => `u${(model.fresh += 1)}`), Option.none())
      }
      expect(a.lines(rootA).filter((line) => line.kind === "Refused").length).toBe(refusedBefore)
    })

    const commands: ReadonlyArray<readonly [number, () => Effect.Effect<unknown, unknown>]> = [
      [14, () => lane(`u${(model.fresh += 1)}`, Option.none())],
      [6, () => lane(pick([...model.lanes.keys()], `u${(model.fresh += 1)}`), Option.none())],
      [4, () => Effect.suspend(() => { const unit = `u${(model.fresh += 1)}`; return lane(unit, Option.some(`custom/${unit}`)) })],
      [
        20,
        () =>
          Option.match(Arr.findFirst([...model.lanes.keys()], (unit) => !model.states.has(unit) || model.states.get(unit) === "blocked"), {
            onNone: () => Effect.void,
            onSome: (unit) => implement(unit, pick(["ready", "ready", "ready", "blocked"] as const, "ready")),
          }),
      ],
      [10, () => land("orchestrate", Option.none(), Option.none())],
      [5, () => land("orchestrate", Option.some(Arr.filter([...model.lanes.keys()], () => random() < 0.5)), Option.none())],
      [3, () => land("orchestrate", Option.none(), Option.some("the owner asked for it"))],
      [4, () => land("rift", Option.none(), Option.none())],
      [
        3,
        () =>
          Effect.gen(function* () {
            const input: Input = { action: "create", branch: `side/${(model.fresh += 1)}` }
            const answer = yield* a.probe(rootA, "rift", input)
            yield* b.probe(rootB, "rift", input)
            expect(answer.text.startsWith(aliasLine("create"))).toBe(model.states.size > 0 || model.pending.length > 0)
          }),
      ],
      [4, () => plain({ action: "create", branch: `plain/${(model.plain += 1)}` })],
      [3, () => plain({ action: "land", rifts: [`/scratch/.rifts/plain/plain-${model.plain}`] })],
      [2, () => plain({ action: "list" })],
      [5, () => verify(`batch-${model.batches + 1}`)],
      [6, () => verifier(pick(["accepted", "accepted", "changes"] as const, "accepted"))],
      [6, () => status()],
      [2, () => Effect.forEach([a, b, c], (run) => run.world.restart, { discard: true })],
      [5, () => Effect.forEach([a, b, c], (run) => run.world.runtime.advance(13 * 60_000), { discard: true })],
    ]
    const total = commands.reduce((sum, [weight]) => sum + weight, 0)
    for (const _ of Array.from({ length: STEPS })) {
      let roll = random() * total
      const chosen = Option.getOrElse(
        Arr.findFirst(commands, ([weight]) => (roll -= weight) < 0),
        () => commands[0] ?? [0, () => Effect.void],
      )
      yield* chosen[1]()
      // The twins tell one story: the same machine decided the same calls alike.
      expect(storyOf(b, rootB)).toEqual(storyOf(a, rootA))
    }
    // afterRestart and the last word: the plain session wrote no ledger line, and status still tells the truth.
    yield* Effect.forEach([a, b, c], (run) => run.world.restart, { discard: true })
    yield* status()
    expect(a.lines(plainA)).toEqual([])
    expect(twins.c.ledger).toEqual([])
  }),
)

// ── The next call, on the real decider ──

const DUE = { ready: 3, waitMs: 30 * 60_000 }

seeded("the next call nextOf names is not refused by the machine, and it names land only when a batch is due", ({ seed, expect }) =>
  Effect.gen(function* () {
    const random = rng(seed)
    const pick = <A,>(list: ReadonlyArray<A>, fallback: A): A => Option.getOrElse(Arr.get(list, Math.floor(random() * list.length)), () => fallback)
    const decider = machine(DUE)
    for (const _ of Array.from({ length: 40 })) {
      let state: MachineState = decider.initial
      let now = 0
      for (const __ of Array.from({ length: Math.floor(random() * 16) })) {
        now += Math.floor(random() * 20 * 60_000)
        const unit = pick(["alpha", "beta", "gamma", "delta"], "alpha")
        const ready = Object.entries(state.units).flatMap(([name, held]) => Option.toArray(Option.map(Option.liftPredicate(name, () => held.state === "ready"), (named) => named)))
        const command: Command = pick<Command>(
          [
            Start.make({ role: "implementor", name: unit, round: 1, direct: false, rift: `/code/.rifts/app/${unit}` }),
            HandBack.make({ role: "implementor", name: unit, verdict: pick(["ready", "ready", "blocked"] as const, "ready") }),
            Land.make({ rifts: ready.map((name) => ({ rift: `/code/.rifts/app/${name}`, unit: name })) }),
            Start.make({ role: "verifier", name: `batch-${1 + Math.floor(random() * 3)}`, round: 1, direct: false }),
            HandBack.make({ role: "verifier", name: Option.getOrElse(Option.map(Option.fromUndefinedOr(state.verifier), (held) => held.batch), () => "batch-1"), verdict: pick(["accepted", "changes"] as const, "accepted"), findings: [`${unit}/M1`] }),
          ],
          Start.make({ role: "implementor", name: unit, round: 1, direct: false }),
        )
        const decided = yield* Effect.exit(decider.decide(state, command, now))
        if (Exit.isSuccess(decided)) for (const event of decided.value) state = decider.evolve(state, event)
      }
      now += Math.floor(random() * 40 * 60_000)
      const next = nextOf(state, now, DUE)
      // land only when a batch is due, never while a verdict is pending, and the machine lets it pass.
      if (next.action === "land") {
        expect(dueOf(state, now, DUE)).toBeDefined()
        expect(verdictPending(state)).toBe(false)
        // The land it names resolves every ready unit to its Rift (each implementor named one) and the machine passes it.
        const resolved = resolveLand({ action: "land" }, [], state, next)
        expect("refused" in resolved && resolved.refused).toBe(false)
        if ("rifts" in resolved) {
          const land = Land.make({ rifts: resolved.rifts.map((rift) => ({ rift: rift.path, unit: rift.unit })) })
          const passed = yield* Effect.exit(decider.decide(state, land, now))
          expect(Exit.match(passed, { onSuccess: () => "passed", onFailure: (cause) => `refused: ${Cause.pretty(cause)}` })).toBe("passed")
        }
      }
      // verify only when a landed batch awaits its verifier, and its start passes.
      if (next.action === "verify") {
        expect(verdictPending(state)).toBe(true)
        const started = yield* Effect.exit(decider.decide(state, Start.make({ role: "verifier", name: "batch-9", round: 1, direct: false }), now))
        expect(Exit.isSuccess(started)).toBe(true)
      }
    }
  }),
)

// ── The lane name rule, on either naming ──

seeded("a lane's Rift, on the Mac's naming or the workbox's, is the one a land resolves its unit to; two units never share one", ({ seed, expect }) =>
  Effect.sync(() => {
    const random = rng(seed)
    const name = () => {
      const letters = "abcdefghijklmnopqrstuvwxyz"
      const rest = "abcdefghijklmnopqrstuvwxyz0123456789-"
      return `${letters[Math.floor(random() * letters.length)] ?? "a"}${Array.from({ length: Math.floor(random() * 8) }, () => rest[Math.floor(random() * rest.length)] ?? "a").join("")}`
    }
    const decider = machine()
    for (const _ of Array.from({ length: 50 })) {
      const units = Arr.dedupe(Array.from({ length: 1 + Math.floor(random() * 4) }, name))
      const workbox = random() < 0.5
      // The units the machine holds, their implementors started with no `(rift: …)`: the name rule alone finds their Rifts.
      const state = units.reduce((held, unit) => decider.evolve(held, UnitStarted.make({ unit, round: 1, direct: false, at: 0 })), decider.initial)
      // Each unit's lane, made on its default branch with the naming the host uses.
      const lanes: ReadonlyArray<Lane> = units.map((unit) => {
        const branch = laneBranchOf({ unit })
        const named = Option.getOrElse(Option.liftPredicate(workriftName(branch), () => workbox), () => unit)
        return { path: `/code/.rifts/app/${named}`, branch, head: "abc1234", state: "clean" }
      })
      const resolved = resolveLand({ action: "land", units }, lanes, state, nextOf(state, 0, DUE))
      expect("rifts" in resolved && resolved.rifts.map((rift) => rift.path)).toEqual(lanes.map((lane) => lane.path))
      // A lane again finds the one it made, by the same name.
      units.forEach((unit, index) => {
        const named = Option.getOrElse(Option.liftPredicate(workriftName(laneBranchOf({ unit })), () => workbox), () => unit)
        expect(existingLanes(unit, named, lanes, state).map((lane) => lane.path)).toEqual(Option.toArray(Option.map(Arr.get(lanes, index), (lane) => lane.path)))
      })
      expect(Arr.dedupe(lanes.map((lane) => lane.path))).toHaveLength(units.length)
    }
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
