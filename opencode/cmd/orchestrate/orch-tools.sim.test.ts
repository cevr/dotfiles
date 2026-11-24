// @reads all
// @reads-reason computed read at mods/guard/filesystem/repo-roots.ts: return yield* Effect.tryPromise({ try: () => stat(join(path, ".git")), catch: (cause) => cause
// The `orchestrate` tool on the simulated host (orch-tools-world.ts): the real orchestrate, rift and status plugins
// on their memory layers, at 20 seeds. The plugin keeps no state of a run: every answer is read from the units' logs
// (the status script's tables) and the Rift list at the call.
//
// - A1, model-based, is in orch-tools-model.sim.test.ts, a file of its own for its own CPU budget.
// - B3's changes-verdict half, and A2 to A6: a restart and a new root lose nothing, a land of a unit that is not ready
//   warns and lands, the harm rules still refuse, no ledger is kept and old options load, and a verdict publishes the
//   fleet target once.
// - The rift tool's description, and the tool's name against the registry's.
import { laneNote } from "@dotfiles/opencode-orchestrate/tools"
import { RIFT_DESCRIPTION } from "@dotfiles/opencode-work/rift"
import { Array as Arr, Effect, Option } from "effect"
import { nearest } from "../../mods/tool-names/near-miss.ts"
import * as Plugins from "../../sim/plugins.ts"
import { simulationRunner } from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"
import {
  boot,
  FINDINGS,
  HAND_BACK,
  implement,
  mergedSince,
  ORCHESTRATE,
  PLAIN,
  RUN_DIR,
  stampOf,
  startsOf,
  suffixOf,
  WORK,
  warningOf,
} from "./orch-tools-world.ts"

const { seeded } = simulationRunner("cmd/orchestrate/orch-tools.sim.test.ts")

/** What a subagent's land is answered (tools.ts `parentRefusal`): merge and push are the root's. */
const PARENT_LAND = "orchestrate: land is the root's: a subagent never lanes, lands or verifies."

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
