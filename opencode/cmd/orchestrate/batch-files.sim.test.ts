// @reads all
// @reads-reason computed read at mods/guard/filesystem/repo-roots.ts: return yield* Effect.tryPromise({ try: () => stat(join(path, ".git")), catch: (cause) => cause
// The verify-due line over batch files as a run really writes them, on the simulated host (orch-tools-world.ts): the
// real orchestrate, rift and status plugins on their memory layers, at 20 seeds. A verify counts from a batch file in a
// `verify-*` dir (this run's verify-1115cc and verify-1115cd: the head only on the `Heads:` line, the findings opening
// with `Verdict:`) or from `<run dir>/batch-<k>.md` (the skill's batch mode). Right after such a batch has a verdict,
// no verify is due. The count is of lands: a fast-forward land, which makes no merge commit, counts like a merge. B3:
// the fifth land since a verify starts land and status with the due line, through restarts and new roots, until a verify
// of main has a verdict. Its own file, so orch-tools.sim.test.ts keeps its CPU budget.
import { headsOf } from "@dotfiles/opencode-orchestrate/fleet"
import { VERIFY_EVERY } from "@dotfiles/opencode-orchestrate/tools"
import { Array as Arr, Effect, Option, Result } from "effect"
import * as Seed from "../../sim/seed.ts"
import { boot, FORK_HEAD, HAND_BACK, requestHeadFor, RUN_DIR, type Run, WORK } from "./orch-tools-world.ts"

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

// ── B3: main since the last verify (moved from orch-tools.sim.test.ts, which keeps its CPU budget) ──

/** A unit laned, its round-1 request written (as its implementor writes it) and landed alone by the orchestrate tool: the land's answer. */
const landOne = Effect.fn("B3.landOne")(function* (run: Run, root: string, unit: string) {
  yield* run.probe(root, ORCHESTRATE, { action: "lane", unit })
  run.files.set(`${RUN_DIR}/${unit}/round-1-request.md`, { text: `Head: ${requestHeadFor(unit, 1)}\n`, at: run.world.now() })
  return yield* run.probe(root, ORCHESTRATE, { action: "land", units: [unit] })
})

/** The due line's words for `n` lands, up to its parenthesis. */
const dueStart = (n: number) => `orchestrate: ${n} lands on main since the last verify (`

seeded("B3: after the fifth land since a verify, land and status start with the due line; a verify with a verdict ends it; restarts and new roots change no answer", ({ seed, expect }) =>
  Effect.gen(function* () {
    // Main holds three merges from before the run: the run's second land is the fifth.
    const run = yield* boot(seed, true, { merges: 3 })
    // A unit in the run's tables, so the run has a dir.
    run.logs.set("w", { state: "implement", round: 1 })
    const roots = [yield* run.world.session(WORK)]
    const root = () => roots.at(-1) ?? ""
    // The seed's picks, one bit each: a restart, a new root, the verdict.
    const bits = Array.from({ length: 16 }, (_, at) => ((Math.imul(seed, 0x9e3779b1) >>> at) & 1) === 1)
    const drawn = { at: 0 }
    const pick = () => Option.getOrElse(Arr.get(bits, drawn.at++ % bits.length), () => false)
    /** A restart, a new root, both or neither, as the seed picks, between two commands. */
    const shuffle = Effect.fn("B3.shuffle")(function* () {
      if (pick()) yield* run.world.restart
      if (pick()) roots.push(yield* run.world.session(WORK))
    })
    for (const n of [1, 2]) {
      const landed = yield* landOne(run, root(), `u${n}`)
      expect([seed, n, landed.error, landed.text.split("\n")[0]]).toEqual([seed, n, false, expect.not.stringContaining("since the last verify")])
      yield* shuffle()
    }
    // The fifth land is in: the next status and land start with the due line, N = 5 (the first verify takes the five back).
    const status = yield* run.probe(root(), ORCHESTRATE, { action: "status" })
    expect(status.text.split("\n")[0]).toStartWith(`${dueStart(5)}none recorded`)
    expect(status.text).toContain('next: orchestrate({ action: "verify" }) (5 lands on main since the last verify).')
    yield* shuffle()
    const sixth = yield* landOne(run, root(), "u3")
    expect([sixth.error, sixth.text.split("\n")[0]]).toEqual([false, expect.stringContaining(dueStart(5))])
    yield* shuffle()
    // The verify of main: its batch file's base is the fifth merge back, its head main's head, its Heads line the fleet's.
    const line = run.memory.main.line()
    const head = Option.getOrElse(Option.map(Arr.last(line), (entry) => entry.sha), () => "")
    const verified = yield* run.probe(root(), ORCHESTRATE, { action: "verify" })
    const name = `batch-main-${head.slice(0, 7)}`
    expect([verified.error, verified.text]).toEqual([false, expect.stringContaining(`subagent({ agent: "verifier", description: "verifier ${name} r1"`)])
    const file = `${RUN_DIR}/verify-main-${head.slice(0, 7)}/${name}.md`
    const text = run.files.get(file)?.text ?? ""
    expect(text.split("\n")).toContain(`Base: ${Option.getOrElse(Option.map(Arr.get(line.toReversed(), VERIFY_EVERY), (entry) => entry.sha), () => "")}`)
    expect(text.split("\n")).toContain(`Head: ${head}`)
    expect(headsOf(text)).toEqual(Result.succeed({ dotfiles: head, fork: FORK_HEAD }))
    // Its units: those whose request head the range holds (u1 to u3); the earlier merges hold no unit's.
    for (const unit of ["u1", "u2", "u3"]) expect(text).toContain(`- ${unit} r1: unit dir ${RUN_DIR}/${unit}`)
    expect(text.split("\n").filter((each) => / r\d+: unit dir /.test(each))).toHaveLength(3)
    yield* shuffle()
    // The verifier hands back a verdict, its findings beside the batch file: no due line after it.
    const verdict = Option.getOrElse(Arr.get(["accepted", "changes"], Number(pick())), () => "accepted")
    const findings = file.replace(/\.md$/, "-findings.md")
    run.files.set(findings, { text: `verifier ${name} r1: ${verdict} ${findings}\n`, at: stampOf(run) })
    yield* run.probe(root(), "subagent", { agent: "verifier", description: `verifier ${name} r1`, prompt: `${HAND_BACK} verifier ${name} r1: ${verdict} ${findings}`, background: true })
    yield* run.world.until(run.settled, 60_000)
    yield* shuffle()
    const after = yield* run.probe(root(), ORCHESTRATE, { action: "status" })
    expect(after.text).not.toContain("since the last verify (")
    const seventh = yield* landOne(run, root(), "u4")
    expect([seventh.error, seventh.text]).toEqual([false, expect.not.stringContaining("since the last verify (")])
    // The next verify counts from the head the last one verified.
    const next = yield* run.probe(root(), ORCHESTRATE, { action: "verify" })
    const nextHead = Option.getOrElse(Option.map(Arr.last(run.memory.main.line()), (entry) => entry.sha), () => "")
    expect(next.error).toBe(false)
    expect((run.files.get(`${RUN_DIR}/verify-main-${nextHead.slice(0, 7)}/batch-main-${nextHead.slice(0, 7)}.md`)?.text ?? "").split("\n")).toContain(`Base: ${head}`)
  }),
)
