// The batch machine's runs on the simulated host (sim/world.ts), each at 20
// seeds: tests/orchestrate-machine.test.ts's OpenCode runs under the same
// names, moved off real OpenCode (machine-world.ts).
//
// - A root that compacts mid-run and drifts: it runs three implementors in the
//   background, compacts while the third runs, then asks for a verifier of one
//   unit and a land of one Rift, which the plugin refuses in the skill's
//   words, then lands the batch and starts its one verifier. The plugin tells
//   it the machine and its run's state after the compaction.
// - The pipeline (SKILL.md, "The pipeline") and round 1's edges: each root turn
//   is one `probe:` call. A verifier the run holds answers once the test opens
//   its gate, as the real run's model held its response; the verifiers'
//   reports are files the plugin's own reader reads, held in memory.
// - A root that moves between locations: the plugin is loaded for two
//   directories, as OpenCode loads a copy for each location it serves, over one
//   ledger; the owner moves each root between them between its steps (host
//   law: move), and each copy must see the other's lines.
import { RULES } from "@dotfiles/opencode-orchestrate/machine"
import { MACHINE_BLOCK } from "@dotfiles/opencode-orchestrate/role"
import { Effect, Option, type Schema } from "effect"
import * as Seed from "../../sim/seed.ts"
import { boot, GAMMA, HAND_BACK, type LedgerLine, MACHINE_DONE, MACHINE_TASK, OTHER, PROBE, type Run, WORK } from "./machine-world.ts"

const { seeded } = Seed.runner("cmd/orchestrate/orchestrate-machine.sim.test.ts")

/** Words of the machine block that nothing else in the run says. */
const BLOCK = "ONE fresh verifier per batch"

const count = (text: string, part: string) => text.split(part).length - 1

seeded(
  "the machine and the run's state follow the compaction; a verifier for one unit and a land of one Rift are refused in the skill's words; one land of three, one batch verifier",
  ({ seed, expect }) =>
    Effect.gen(function* () {
      // The machine block the plugin tells (agents.json's, generated from SKILL.md; that it is SKILL.md's own words is
      // read in tests/orchestrate-machine.test.ts, from the files).
      expect(MACHINE_BLOCK).toContain("ONE fresh verifier per batch")

      const run = yield* boot(seed)
      const root = yield* run.world.session(WORK)
      run.machine.root = root
      yield* run.world.prompt(root, MACHINE_TASK)
      // Gamma still runs as the root compacts, as it did on real OpenCode: its implementor answers once the brief is in.
      yield* run.world.until(() => run.world.logs().some((line) => line.message === "orchestrate: told a compacted root its machine and run"), 120_000)
      yield* run.open(GAMMA)
      // Each child's report wakes the root for its next step, until the batch's verifier hands back.
      yield* run.world.until(() => run.world.messages(root).some((message) => message.type === "assistant" && message.text === MACHINE_DONE), 300_000)
      yield* run.world.until(() => run.lines(root).some((line) => line.kind === "VerifierEnded"), 20_000)

      // The root compacted once, and the requests after its summary request carry the block and the state.
      const requests = run.world.asked().filter((asked) => asked.sessionID === root && asked.kind !== "title")
      const summary = requests.findIndex((asked) => asked.kind === "compaction")
      expect(summary).toBeGreaterThan(0)
      expect(requests.filter((asked) => asked.kind === "compaction")).toHaveLength(1)
      expect(requests.slice(0, summary + 1).map((asked) => asked.text).join("\n")).not.toContain(BLOCK)
      const after = requests.slice(summary + 1)
      expect(after.length).toBeGreaterThan(0)
      // In the root's context by its second request after the compaction, and once per compaction, not once per request.
      const told = after.findIndex((asked) => asked.text.includes(BLOCK))
      expect(told).toBeGreaterThanOrEqual(0)
      expect(told).toBeLessThanOrEqual(1)
      const last = Option.getOrElse(Option.map(Option.fromUndefinedOr(after.at(-1)), (asked) => asked.text), () => "")
      expect(count(last, BLOCK)).toBe(1)
      // The state as of the compaction: gamma still runs in the background, alpha and beta are ready.
      expect(last).toContain("implement: gamma")
      expect(last).toMatch(/ready: alpha \(\d+ min\), beta \(\d+ min\)/)

      // The drift is refused in the skill's words, and nothing it asked for started.
      const said = run.world.messages(root).map(run.said).join("\n")
      expect(said).toContain(RULES.VerifierPerUnit.words)
      expect(said).toContain(RULES.LandPartial.words)
      expect(said).toContain("beta, gamma")

      // One land, of all three; one verifier, the batch's.
      expect(run.lands).toEqual([["alpha", "beta", "gamma"]])
      const steps = run.children(root).map((child) => ({ agent: child.agent, description: Option.getOrElse(child.title, () => "") }))
      expect(steps.filter((step) => step.agent === "verifier")).toEqual([{ agent: "verifier", description: "verifier batch-1 r1" }])
      expect(steps.filter((step) => step.agent === "implementor").map((step) => step.description)).toEqual(["implementor alpha r1", "implementor beta r1", "implementor gamma r1"])

      // The ledger keeps what happened, for the drift metric: two refusals, one batch landed, one verifier over its three units.
      const ledger = run.lines(root)
      const kinds = ledger.map((line) => line.kind)
      expect(kinds.filter((kind) => kind === "Refused")).toHaveLength(2)
      expect(ledger.filter((line) => line.kind === "Refused").map((line) => line.rule)).toEqual(["VerifierPerUnit", "LandPartial"])
      expect(ledger.find((line) => line.kind === "BatchLanded")).toMatchObject({ units: ["alpha", "beta", "gamma"] })
      expect(ledger.find((line) => line.kind === "VerifierStarted")).toMatchObject({ batch: "batch-1", units: ["alpha", "beta", "gamma"] })
      expect(kinds).not.toContain("Departed")
    }),
)

const RUN = "/scratch/run"
const READY = "/nonexistent/loop-probe-x/request.md"
const FINDINGS = "/nonexistent/loop-probe-x/findings.md"

type Input = { readonly [key: string]: Schema.Json }

/** One root's run, its calls each one probe turn. */
const rootOf = (run: Run, root: string) => {
  const call = (name: string, input: Input) => run.probe(root, name, input)
  /** An implementor's call; one not held by a gate is waited out to its hand-back, as the real run's timing gave it. */
  const implement = (unit: string, round = 1, extra: Input = {}, gate = "") =>
    Effect.gen(function* () {
      const before = run.handedBack(root, unit)
      yield* call("subagent", {
        agent: "implementor",
        description: `implementor ${unit} r${round}`,
        prompt: `${gate}${HAND_BACK} implementor ${unit} r${round}: ready ${READY}`,
        ...extra,
      })
      if (gate === "") yield* run.world.until(() => run.handedBack(root, unit) > before, 20_000)
    })
  const land = (rifts: ReadonlyArray<string>) => call("rift", { action: "land", rifts: [...rifts] })
  const has = (match: (line: LedgerLine) => boolean) => run.has(root, match)
  return { call, implement, land, has }
}

/** Batch-1's findings, as its verifier writes them: a batch file naming each unit's findings file. */
const batchOne = (run: Run) => {
  for (const unit of ["auth", "billing"])
    run.files.set(`${RUN}/${unit}/round-1-findings.md`, `Verdict: CHANGES REQUIRED\n\n## Blockers\nNone.\n\n## Major\n\n### M1 — ${unit} drops a line\n`)
  const report = `${RUN}/batch-1-findings.md`
  run.files.set(report, "changes\n\n| Unit | Round | Verdict | Findings |\n| --- | --- | --- | --- |\n| auth | 1 | changes | auth/round-1-findings.md |\n| billing | 1 | changes | billing/round-1-findings.md |\n")
  return report
}

/** The pipeline: batch-1 verifies while batch-2 fans out; its findings fold; batch-2 lands without export; export as batch-3. */
const pipeline = (run: Run) =>
  Effect.gen(function* () {
    const report = batchOne(run)
    const root = yield* run.world.session(WORK)
    const at = rootOf(run, root)
    // Batch 1: two units, landed together; its verifier runs in the background, held until the gate opens.
    yield* at.implement("auth")
    yield* at.implement("billing")
    yield* at.land(["auth", "billing"])
    yield* at.call("subagent", { agent: "verifier", description: "verifier batch-1 r1", prompt: `gate:verify-1\n${HAND_BACK} verifier batch-1 r1: changes ${report}`, background: true })
    // Batch 2 fans out while it verifies: search hands back, export still runs.
    yield* at.implement("search")
    yield* at.implement("export", 1, { background: true }, "gate:export\n")
    yield* at.land(["search"])
    // The verdict comes in; its findings are not folded yet.
    yield* run.open("verify-1")
    yield* at.has((line) => line.kind === "VerifierEnded")
    yield* at.land(["search"])
    // auth/M1 goes to export's running implementor as a round message, billing/M1 to a new fix unit.
    const exported = Option.getOrThrow(Option.fromUndefinedOr(run.lines(root).find((line) => line.kind === "StepSpawned" && line.name === "export")?.child))
    yield* at.call("subagent", {
      agent: "implementor",
      description: "implementor export r1 (folds: auth/M1)",
      prompt: `Fold auth/M1 (${RUN}/auth/round-1-findings.md) into this round.`,
      sessionID: exported,
      background: true,
    })
    yield* at.implement("billing-fix1", 1, { description: "implementor billing-fix1 r1 (folds: billing/M1)" })
    yield* at.implement("docs")
    // auth/M1 rides with export, still implementing: it holds no land, so the three ready units land without it.
    yield* at.land(["search", "billing-fix1", "docs"])
    yield* at.call("subagent", { agent: "verifier", description: "verifier batch-2 r1", prompt: `${HAND_BACK} verifier batch-2 r1: accepted ${FINDINGS}` })
    yield* at.has((line) => line.kind === "VerifierEnded" && line.batch === "batch-2")
    // Export hands back and lands in its own batch; that batch's verifier is told auth/M1.
    yield* run.open("export")
    yield* at.has((line) => line.kind === "UnitHandedBack" && line.unit === "export" && line.ready === true)
    yield* run.world.until(() => run.idle(exported), 20_000)
    yield* at.land(["export"])
    yield* at.call("subagent", { agent: "verifier", description: "verifier batch-3 r1", prompt: `${HAND_BACK} verifier batch-3 r1: accepted ${FINDINGS}` })
    return root
  })

/** Round 1's edges (orch-pipeline r1 M1, M2) on a root of their own. */
const edges = (run: Run) =>
  Effect.gen(function* () {
    const root = yield* run.world.session(WORK)
    const at = rootOf(run, root)
    // M2: the covered unit's round 2 hands back while its batch's verifier runs; its land waits for the verdict.
    yield* at.implement("repeat")
    yield* at.land(["repeat"])
    yield* at.call("subagent", { agent: "verifier", description: "verifier batch-r1 r1", prompt: `gate:repeat-verifier\n${HAND_BACK} verifier batch-r1 r1: accepted ${FINDINGS}`, background: true })
    yield* at.implement("repeat", 2)
    yield* at.land(["repeat"])
    yield* run.open("repeat-verifier")
    yield* at.has((line) => line.kind === "VerifierEnded" && line.batch === "batch-r1")
    yield* at.land(["repeat"])
    // M1: a `changes` whose report does not read yet holds the next land; once written, it is read again, and its finding folds.
    const missing = `${RUN}/edge/batch-m1-findings.md`
    yield* at.call("subagent", { agent: "verifier", description: "verifier batch-m1 r1", prompt: `${HAND_BACK} verifier batch-m1 r1: changes ${missing}` })
    yield* at.has((line) => line.kind === "VerifierEnded" && line.batch === "batch-m1")
    yield* at.implement("after")
    yield* at.land(["after"])
    run.files.set(`${RUN}/edge/repeat/round-1-findings.md`, "Verdict: CHANGES REQUIRED\n\n## Major\n\n### M1 — repeat drops a line\n")
    run.files.set(missing, "changes\n\n| repeat | 1 | changes | repeat/round-1-findings.md |\n")
    yield* at.land(["after"])
    yield* at.implement("repeat-fix1", 1, { description: "implementor repeat-fix1 r1 (folds: repeat/M1)" })
    yield* at.land(["after", "repeat-fix1"])
    return root
  })

/** The text a session's messages say, for a test to look into. */
const textOf = (run: Run, sessionID: string) => run.world.messages(sessionID).map(run.said).join("\n")

seeded(
  "fan-out during verify, a fold into a running implementor and one into a fix unit, the land after the verdict without the running implementor, whose finding rides with its own later land; each verifier told the folds that landed with it; a land before the verdict and one with a finding unfolded are refused",
  ({ seed, expect }) =>
    Effect.gen(function* () {
      const run = yield* boot(seed)
      const root = yield* pipeline(run)
      const lines = run.lines(root)
      const kinds = lines.map((line) => line.kind)
      // Batch-2's implementors started while batch-1's verifier ran: no start was refused.
      const verifying = kinds.indexOf("VerifierStarted")
      const verdict = kinds.indexOf("VerifierEnded")
      expect(lines.slice(verifying, verdict).filter((line) => line.kind === "UnitStarted").map((line) => line.unit)).toEqual(["search", "export"])
      // The two drifts are refused in the skill's words, and neither land reached the rift tool.
      expect(lines.filter((line) => line.kind === "Refused").map((line) => line.rule)).toEqual(["VerdictPending", "FindingUnfolded"])
      const said = textOf(run, root)
      expect(said).toContain(RULES.VerdictPending.words)
      expect(said).toContain(RULES.FindingUnfolded.words)
      expect(run.lands).toEqual([["auth", "billing"], ["search", "billing-fix1", "docs"], ["export"]])
      // The verdict's findings, read from its report, and where each was folded.
      expect(lines.find((line) => line.kind === "VerifierEnded")).toMatchObject({ batch: "batch-1", verdict: "changes", findings: ["auth/M1", "billing/M1"] })
      expect(lines.filter((line) => line.kind === "FindingFolded").map((line) => [line.finding, line.into])).toEqual([["auth/M1", "export"], ["billing/M1", "billing-fix1"]])
      expect(lines.filter((line) => line.kind === "BatchLanded").map((line) => line.units)).toEqual([["auth", "billing"], ["search", "billing-fix1", "docs"], ["export"]])
      // One verifier per batch, each told the batch-1 findings that landed with it, in its prompt.
      expect(lines.filter((line) => line.kind === "VerifierStarted").map((line) => line.batch)).toEqual(["batch-1", "batch-2", "batch-3"])
      const started = lines.filter((line) => line.kind === "VerifierStarted")
      expect(started[1]).toMatchObject({ units: ["search", "billing-fix1", "docs"], findings: ["billing/M1 → billing-fix1"] })
      expect(started[2]).toMatchObject({ units: ["export"], findings: ["auth/M1 → export"] })
      // The verifier's own request: its prompt, not the root's probe that asked for it.
      const told = (batch: string) =>
        Option.getOrElse(
          Option.map(Option.fromUndefinedOr(run.world.asked().find((asked) => asked.text.includes(`verifier ${batch} r1: accepted`) && !asked.text.includes(PROBE))), (asked) => asked.text),
          () => "",
        )
      expect(told("batch-2")).toContain("- batch-1 billing/M1 → billing-fix1")
      expect(told("batch-2")).not.toContain("auth/M1 → export")
      expect(told("batch-3")).toContain("- batch-1 auth/M1 → export")
      expect(kinds).not.toContain("Departed")
    }),
)

// orch-pipeline r1's live probes, promoted: M2, a covered unit's next round does not end its batch's wait; M1, a
// `changes` whose report does not read is never an empty set of findings.
seeded(
  "a covered unit's round 2 cannot land while its batch's verifier runs; a changes whose report does not read holds the land until it reads and its finding folds",
  ({ seed, expect }) =>
    Effect.gen(function* () {
      const run = yield* boot(seed)
      const root = yield* edges(run)
      const lines = run.lines(root)
      const refused = lines.filter((line) => line.kind === "Refused")
      expect(refused.map((line) => line.rule)).toEqual(["VerdictPending", "FindingUnfolded", "FindingUnfolded"])
      // M2: refused while batch-r1's verifier ran, after repeat r2 handed back ready; landed once the verdict was in.
      const verdict = lines.findIndex((line) => line.kind === "VerifierEnded" && line.batch === "batch-r1")
      expect(lines.indexOf(refused[0] ?? lines[0]!)).toBeLessThan(verdict)
      expect(lines.slice(0, verdict).filter((line) => line.kind === "BatchLanded")).toHaveLength(1)
      expect(String(refused[0]?.message)).toContain("Verifier batch-r1 still runs over repeat")
      // M1: the verdict whose report did not read is unresolved, not empty; the refusal says which report.
      expect(lines.find((line) => line.kind === "VerifierEnded" && line.batch === "batch-m1")).toMatchObject({
        verdict: "changes",
        unresolved: { report: expect.stringContaining("batch-m1-findings.md"), why: expect.stringContaining("does not read") },
      })
      expect(String(refused[1]?.message)).toContain("The findings of batch-m1's `changes` are not known")
      // Written since, the report is read again at the next land: its finding opens, unfolded, then folds into a fix unit.
      expect(lines.find((line) => line.kind === "ReportResolved")).toMatchObject({ batch: "batch-m1", findings: ["repeat/M1"] })
      expect(String(refused[2]?.message)).toContain("repeat/M1 (not folded)")
      expect(lines.filter((line) => line.kind === "FindingFolded").map((line) => [line.finding, line.into])).toEqual([["repeat/M1", "repeat-fix1"]])
      expect(run.lands).toEqual([["repeat"], ["repeat"], ["after", "repeat-fix1"]])
      expect(lines.map((line) => line.kind)).not.toContain("Departed")
    }),
)

/** One moving root's steps: each call one probe turn, each move the owner's, waited out. */
const moverOf = (run: Run, root: string) => {
  const call = (name: string, input: { readonly [key: string]: Schema.Json }) => run.probe(root, name, input)
  /** An implementor's call, waited out to its hand-back, as the real run's timing gave it. */
  const implement = (unit: string) =>
    call("subagent", { agent: "implementor", description: `implementor ${unit} r1`, prompt: `${HAND_BACK} implementor ${unit} r1: ready ${READY}` }).pipe(
      Effect.andThen(run.world.until(() => run.handedBack(root, unit) > 0, 20_000)),
    )
  // The owner moves an idle root: the child's report it woke for answered first.
  const rested = run.world.until(() => run.idle(root), 20_000)
  const moveTo = (directory: string) => rested.pipe(Effect.andThen(run.world.move(root, directory)), Effect.andThen(rested))
  const land = (rifts: ReadonlyArray<string>) => call("rift", { action: "land", rifts: [...rifts] })
  return { call, implement, moveTo, land }
}

seeded("a land of one of two ready units made in two places is refused; a run that keeps the machine across moves is never refused", ({ seed, expect }) =>
  Effect.gen(function* () {
    const run = yield* boot(seed, [WORK, OTHER])
    // A root that drifts across a move: a ready unit here, one there, then a land of the first alone.
    const partial = yield* run.world.session(WORK)
    const drifts = moverOf(run, partial)
    yield* drifts.implement("move-a")
    yield* drifts.moveTo(OTHER)
    yield* drifts.implement("move-b")
    yield* drifts.moveTo(WORK)
    yield* drifts.land(["move-a"])
    // A root that keeps the machine across moves: both units land, the batch's verifier hands back, the next unit lands.
    const legal = yield* run.world.session(WORK)
    const keeps = moverOf(run, legal)
    yield* keeps.implement("legal-a")
    yield* keeps.moveTo(OTHER)
    yield* keeps.implement("legal-b")
    yield* keeps.moveTo(WORK)
    yield* keeps.land(["legal-a", "legal-b"])
    yield* keeps.moveTo(OTHER)
    // `accepted`: a `changes` whose report does not read would hold legal-c's land (orch-pipeline r1 M1), and this run is the compliant one.
    yield* keeps.call("subagent", { agent: "verifier", description: "verifier batch-1 r1", prompt: `${HAND_BACK} verifier batch-1 r1: accepted /nonexistent/loop-probe-x/findings.md` })
    yield* keeps.moveTo(WORK)
    yield* keeps.implement("legal-c")
    yield* keeps.land(["legal-c"])

    expect(run.lines(partial).filter((line) => line.kind === "Refused").map((line) => line.rule)).toEqual(["LandPartial"])
    expect(run.lines(legal).filter((line) => line.kind === "Refused")).toEqual([])
    expect(run.lines(legal).filter((line) => line.kind === "BatchLanded").map((line) => line.units)).toEqual([["legal-a", "legal-b"], ["legal-c"]])
    expect(run.lines(legal).find((line) => line.kind === "VerifierEnded")).toMatchObject({ batch: "batch-1", verdict: "accepted" })
    expect(run.lands).toEqual([["legal-a", "legal-b"], ["legal-c"]])
  }),
)
