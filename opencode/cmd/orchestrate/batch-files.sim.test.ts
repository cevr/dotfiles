// The verify-due line over batch files as a run really writes them, on the simulated host (orch-tools-world.ts): the
// real orchestrate, rift and status plugins on their memory layers, at 20 seeds. A verify counts from a batch file in a
// `verify-*` dir (this run's verify-1115cc and verify-1115cd: the head only on the `Heads:` line, the findings opening
// with `Verdict:`) or from `<run dir>/batch-<k>.md` (the skill's batch mode). Right after such a batch has a verdict,
// no verify is due. Its own file, so orch-tools.sim.test.ts keeps its CPU budget.
import { Array as Arr, Effect, Option } from "effect"
import * as Seed from "../../sim/seed.ts"
import { boot, FORK_HEAD, RUN_DIR, type Run, WORK } from "./orch-tools-world.ts"

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
