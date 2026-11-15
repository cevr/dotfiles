// The verify-due line over batch files as a run really writes them, on the simulated host (orch-tools-world.ts): the
// real orchestrate, rift and status plugins on their memory layers, at 20 seeds. A verify counts from a batch file in a
// `verify-*` dir (this run's verify-1115cc and verify-1115cd: the head only on the `Heads:` line, the findings opening
// with `Verdict:`) or from `<run dir>/batch-<k>.md` (the skill's batch mode). Right after such a batch has a verdict,
// no verify is due. The count is of lands: a fast-forward land, which makes no merge commit, counts like a merge. Its own
// file, so orch-tools.sim.test.ts keeps its CPU budget.
import { Array as Arr, Effect, Option } from "effect"
import * as Seed from "../../sim/seed.ts"
import { boot, FORK_HEAD, requestHeadFor, RUN_DIR, type Run, WORK } from "./orch-tools-world.ts"

const { seeded } = Seed.runner("cmd/orchestrate/batch-files.sim.test.ts")

const ORCHESTRATE = "orchestrate"

/** A time after every file the run holds, as a writer's next file has. */
const stampOf = (run: Run): number => Math.max(run.world.now(), ...[...run.files.values()].map((file) => file.at + 1))

/** A batch file as this run's orchestrator writes one: prose, the base, and the head only on the heads line. */
const batchText = (name: string, base: string, head: string) =>
  [
    `# ${name}`,
    `Base: ${base} (the last batch's head).`,
    `Heads: dotfiles=${head} fork=${FORK_HEAD}`,
    "Land: on receipts; each unit merged with a green gate.ts --merge.",
    `Units (spec ${RUN_DIR}/<unit>/spec.md):`,
    `- u1 r1 (${head.slice(0, 8)}: …).`,
    "",
  ].join("\n")

seeded("right after a batch with a verdict, as this run's verify dirs and batch mode write them (the head only on the Heads line), no verify is due", ({ seed, expect }) =>
  Effect.gen(function* () {
    // Seven merges on main and a unit in the run: with no verify recorded, a verify is due.
    const run = yield* boot(seed, true, { merges: 7 })
    run.logs.set("u1", { state: "implement", round: 1 })
    const root = yield* run.world.session(WORK)
    const shaBack = (n: number) => Option.getOrElse(Option.map(Arr.get(run.memory.main.line().toReversed(), n), (entry) => entry.sha), () => "")
    const due = Effect.map(run.probe(root, ORCHESTRATE, { action: "status" }), (answer) => [answer.text.includes("since the last verify ("), answer.text.includes('next: orchestrate({ action: "verify" })')])
    const put = (path: string, text: string) => void run.files.set(path, { text, at: stampOf(run) })
    expect(yield* due).toEqual([true, true])
    // verify-1115cc: accepted, its head two merges back; under five merges since, nothing is due.
    put(`${RUN_DIR}/verify-1115cc/batch-2026-11-15cc.md`, batchText("batch-2026-11-15cc", shaBack(4), shaBack(2)))
    put(`${RUN_DIR}/verify-1115cc/batch-2026-11-15cc-findings.md`, `Verdict: accepted\n\n# batch-2026-11-15cc: findings (base ${shaBack(4).slice(0, 8)}, head ${shaBack(2).slice(0, 8)})\n`)
    expect(yield* due).toEqual([false, false])
    // verify-1115cd: changes, its head main's head; any verdict ends the due line.
    put(`${RUN_DIR}/verify-1115cd/batch-2026-11-15cd.md`, batchText("batch-2026-11-15cd", shaBack(2), shaBack(0)))
    put(`${RUN_DIR}/verify-1115cd/batch-2026-11-15cd-findings.md`, "Verdict: changes\n\n# batch-2026-11-15cd findings\n")
    expect(yield* due).toEqual([false, false])
    // Batch mode's place, `<run dir>/batch-<k>.md` with its findings beside it, and no verify dir at all.
    for (const path of [...run.files.keys()].filter((each) => each.startsWith(`${RUN_DIR}/verify-`))) run.files.delete(path)
    expect(yield* due).toEqual([true, true])
    put(`${RUN_DIR}/batch-3.md`, batchText("batch-3", shaBack(2), shaBack(0)))
    put(`${RUN_DIR}/batch-3-findings.md`, `verifier batch-3 r1: accepted ${RUN_DIR}/batch-3-findings.md\n`)
    expect(yield* due).toEqual([false, false])
  }),
)

seeded("a fast-forward land counts like a merge: five lands since the verify, some with no merge commit, make the due line", ({ seed, expect }) =>
  Effect.gen(function* () {
    // The seed picks which of the five lands fast-forward (as `rift land` does when main has not moved): at least two, never all.
    const units = ["u1", "u2", "u3", "u4", "u5"]
    const picked = units.filter((_, at) => ((seed >> at) & 1) === 1)
    const fastForward = Option.getOrElse(Option.liftPredicate(picked, (each) => each.length >= 2 && each.length < units.length), () => ["u1", "u3"])
    const run = yield* boot(seed, true, { merges: 2, fastForward })
    run.logs.set("w", { state: "implement", round: 1 })
    const root = yield* run.world.session(WORK)
    const put = (path: string, text: string) => void run.files.set(path, { text, at: stampOf(run) })
    const head = () => Option.getOrElse(Option.map(Arr.last(run.memory.main.line()), (entry) => entry.sha), () => "")
    // A verify accepted at main's head before the lands: the count starts there.
    put(`${RUN_DIR}/verify-1115ce/batch-2026-11-15ce.md`, batchText("batch-2026-11-15ce", head(), head()))
    put(`${RUN_DIR}/verify-1115ce/batch-2026-11-15ce-findings.md`, "Verdict: accepted\n")
    const status = Effect.map(run.probe(root, ORCHESTRATE, { action: "status" }), (answer) => Option.getOrElse(Arr.head(answer.text.split("\n")), () => ""))
    for (const [at, unit] of units.entries()) {
      yield* run.probe(root, ORCHESTRATE, { action: "lane", unit })
      put(`${RUN_DIR}/${unit}/round-1-request.md`, `Head: ${requestHeadFor(unit, 1)}\n`)
      const landed = yield* run.probe(root, ORCHESTRATE, { action: "land", units: [unit] })
      expect([seed, unit, landed.error]).toEqual([seed, unit, false])
      if (at < units.length - 1) expect([seed, unit, yield* status]).toEqual([seed, unit, expect.not.stringContaining("since the last verify (")])
    }
    const merges = run.memory.main.line().filter((entry) => entry.merged.length > 0).length - 2
    expect([seed, fastForward, merges]).toEqual([seed, fastForward, units.length - fastForward.length])
    expect([seed, yield* status]).toEqual([seed, expect.stringContaining("orchestrate: 5 lands on main since the last verify (")])
  }),
)
