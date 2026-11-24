// @reads all
// @reads-reason computed read at mods/guard/filesystem/repo-roots.ts: return yield* Effect.tryPromise({ try: () => stat(join(path, ".git")), catch: (cause) => cause
// One lane, one unit, one branch, with its purpose: the `orchestrate` tool's lane, land and status on the simulated
// host (orch-tools-world.ts: the real orchestrate, rift and status plugins on their memory layers). A lane the tool made
// (marked) then switched to another unit's branch is refused by lane and land and flagged by status; one it did not
// make (Ergo's lanes, in flight before the rule: facts of the lane-names unit) is answered and landed with a warning;
// a land's and a verify's own checkouts are never flagged; a second round of the same unit gets its lane back; a purpose is its branch's description, read back
// through the rift RPC; the naming rule warns and never refuses.
import { workriftFolderOf } from "@dotfiles/opencode-orchestrate/tools"
import * as MemoryRifts from "@dotfiles/opencode-work/memory/rifts"
import { workspaceName } from "@dotfiles/opencode-work/rift"
import { Array as Arr, Effect, Option } from "effect"
import { simulationRunner } from "../../sim/seed.ts"
import { boot, HAND_BACK, RUN_DIR, type Run, requestHeadFor, WORK } from "./orch-tools-world.ts"

const { seeded } = simulationRunner("cmd/orchestrate/lanes.sim.test.ts")

const ORCHESTRATE = "orchestrate"
const READY = "/nonexistent/loop-probe-x/request.md"

/** The Rift a lane of `unit` makes on the Mac, in the run's warm source. */
const pathOf = (unit: string) => `/scratch/.work/work/${unit}`

/** The Rift a lane's answer ends with: its `(lane: <path>)`. */
const suffixOf = (answer: string): string => Option.getOrElse(Option.flatMap(Option.fromNullishOr(/\(lane: ([^)]+)\)\s*$/.exec(answer)), (match) => Arr.get(match, 1)), () => "")

/** A clean Rift detached at `head`, as a verify's or a land's own checkout is. */
const detachedAt = (path: string, head: string) => ({ ...MemoryRifts.clean(path, void 0), head })

/** An implementor's start in `root` that hands back ready, waited out until its log reads ready in its round. */
const implement = Effect.fn("Lanes.implement")(function* (run: Run, root: string, unit: string, round: number, description: string) {
  run.files.set(`${RUN_DIR}/${unit}/round-${round}-request.md`, { text: `Head: ${requestHeadFor(unit, round)}\n`, at: run.world.now() })
  const answer = yield* run.probe(root, "subagent", { agent: "implementor", description, prompt: `${HAND_BACK} implementor ${unit} r${round}: ready ${READY}`, background: true })
  yield* run.world.until(run.settled, 60_000)
  yield* run.world.until(() => Option.exists(Option.fromUndefinedOr(run.logs.get(unit)), (log) => log.state === "ready" && log.round === round), 30_000)
  return answer
})

seeded("L1: a lane reused for another unit is refused by lane and land and flagged by status; a second round of the same unit gets its lane", ({ expect, seed }) =>
  Effect.gen(function* () {
    const run = yield* boot(seed, true)
    const root = yield* run.world.session(WORK)
    const laned = yield* run.probe(root, ORCHESTRATE, { action: "lane", unit: "billing", purpose: "Bill each seat once" })
    expect(laned.error).toBe(false)
    // orchestrate lane marks the lane it makes, on its branch.
    expect(run.memory.rifts.marked.get(pathOf("billing"))).toBe("feat/billing")
    const started = yield* implement(run, root, "billing", 1, `implementor billing r1 — Bill each seat once (lane: ${suffixOf(laned.text)})`)
    expect(started.error).toBe(false)
    // Round 2 of the same unit: its lane is answered, nothing made.
    const again = yield* run.probe(root, ORCHESTRATE, { action: "lane", unit: "billing" })
    expect([again.error, again.text]).toEqual([false, expect.stringContaining("; it existed, so nothing was made.")])
    expect(suffixOf(again.text)).toBe(pathOf("billing"))
    // The lane is switched to another unit's branch in place, as Ergo's lanes were (`git switch -c`).
    MemoryRifts.change(run.memory.rifts, pathOf("billing"), (workspace) => ({ ...workspace, branch: "feat/invoices" }))
    const refused = yield* run.probe(root, ORCHESTRATE, { action: "lane", unit: "billing" })
    expect([refused.error, refused.text]).toEqual([true, expect.stringContaining(`billing's lane ${pathOf("billing")} holds branch feat/invoices`)])
    const status = yield* run.probe(root, ORCHESTRATE, { action: "status" })
    // The purpose was feat/billing's description: the branch checked out now has none.
    expect(status.text).toContain(`- billing: ready · lane ${pathOf("billing")} (branch feat/invoices) · REUSED: branch feat/invoices is not feat/billing, the branch orchestrate lane made it on; a land of it refuses.`)
    expect(status.text).not.toContain('next: orchestrate({ action: "land" })')
    const from = run.memory.landing.steps.length
    for (const units of [["billing"], [{ unit: "billing", path: pathOf("billing") }]]) {
      const landed = yield* run.probe(root, ORCHESTRATE, { action: "land", units })
      expect([landed.error, landed.text]).toEqual([true, expect.stringContaining('a lane is never reused for another unit. Make a lane for the unit its branch names, orchestrate({ action: "lane", unit: "invoices" })')])
    }
    expect(run.memory.landing.steps.length).toBe(from)
    // The fix: the unit the branch names gets a lane of its own.
    const own = yield* run.probe(root, ORCHESTRATE, { action: "lane", unit: "invoices" })
    expect([own.error, suffixOf(own.text), own.text]).toEqual([false, pathOf("invoices"), expect.stringContaining("; made now.")])
  }),
)

seeded("L2: a purpose round-trips through the lane's branch description into the answer, the implementor's call and status; one given later is set; none answers the hint", ({ expect, seed }) =>
  Effect.gen(function* () {
    const run = yield* boot(seed, true)
    const root = yield* run.world.session(WORK)
    const made = yield* run.probe(root, ORCHESTRATE, { action: "lane", unit: "land-notices", purpose: "Land notices only when red" })
    expect(made.text).toContain("Purpose: Land notices only when red")
    expect(made.text).toContain(`description: "implementor land-notices r1 — Land notices only when red (lane: ${pathOf("land-notices")})"`)
    expect(MemoryRifts.purposeOf(run.memory.rifts, pathOf("land-notices"))).toEqual(Option.some("Land notices only when red"))
    // The described form starts the implementor and moves its log, as the plain one does.
    yield* implement(run, root, "land-notices", 1, `implementor land-notices r1 — Land notices only when red (lane: ${pathOf("land-notices")})`)
    expect(run.logs.get("land-notices")).toEqual({ state: "ready", round: 1 })
    const status = yield* run.probe(root, ORCHESTRATE, { action: "status" })
    expect(status.text).toContain(`lane ${pathOf("land-notices")} (branch feat/land-notices) — Land notices only when red`)
    // A lane with none answers the hint; one given later is set on the existing lane.
    const bare = yield* run.probe(root, ORCHESTRATE, { action: "lane", unit: "seat-billing" })
    expect(bare.text).toContain("orchestrate: hint: lane seat-billing has no purpose.")
    const later = yield* run.probe(root, ORCHESTRATE, { action: "lane", unit: "seat-billing", purpose: "Bill each seat once" })
    expect([later.error, later.text]).toEqual([false, expect.stringContaining("Purpose: Bill each seat once")])
    expect(MemoryRifts.purposeOf(run.memory.rifts, pathOf("seat-billing"))).toEqual(Option.some("Bill each seat once"))
    // The naming rule warns and still makes the lane; a branch that does not name its unit is refused, nothing made.
    const round = yield* run.probe(root, ORCHESTRATE, { action: "lane", unit: "poll-entry-r2", purpose: "Poll each entry once" })
    expect([round.error, round.text.split("\n")[0], round.text]).toEqual([false, expect.stringContaining("poll-entry-r2 ends in a round"), expect.stringContaining("; made now.")])
    expect(made.text).not.toContain("orchestrate: warning:")
    const branch = yield* run.probe(root, ORCHESTRATE, { action: "lane", unit: "billing", branch: "fix/invoices" })
    expect([branch.error, branch.text]).toEqual([true, expect.stringContaining('branch: "fix/billing"')])
    expect(run.memory.rifts.rifts.has(pathOf("billing"))).toBe(false)
  }),
)

seeded("L3: a lane orchestrate lane did not make (Ergo's, in flight before the rule) that holds another branch is answered and landed with the warning; a land's and a verify's own detached checkouts are never flagged", ({ expect, seed }) =>
  Effect.gen(function* () {
    const run = yield* boot(seed, true)
    const root = yield* run.world.session(WORK)
    // Made by hand before the rule: no mark, its folder ui-input, its branch another unit's.
    run.memory.rifts.rifts.set(pathOf("ui-input"), MemoryRifts.clean(pathOf("ui-input"), "wf10/ui-hover-areas"))
    for (const name of ["verify-batch-1", "integrate", "land-accept"]) run.memory.rifts.rifts.set(pathOf(name), detachedAt(pathOf(name), "def5678"))
    const again = yield* run.probe(root, ORCHESTRATE, { action: "lane", unit: "ui-input" })
    expect([again.error, again.text.split("\n")[0], again.text]).toEqual([
      false,
      expect.stringContaining(`orchestrate: warning: ui-input's lane ${pathOf("ui-input")} holds branch wf10/ui-hover-areas, not ui-input's; orchestrate lane did not make it, so it is taken as before the one-lane rule.`),
      expect.stringContaining("; it existed, so nothing was made."),
    ])
    expect(run.memory.rifts.marked.has(pathOf("ui-input"))).toBe(false)
    yield* implement(run, root, "ui-input", 1, `implementor ui-input r1 (lane: ${pathOf("ui-input")})`)
    const status = yield* run.probe(root, ORCHESTRATE, { action: "status" })
    expect(status.text).toContain(`- ui-input: ready · lane ${pathOf("ui-input")} (branch wf10/ui-hover-areas) · warning: it holds branch wf10/ui-hover-areas, not ui-input's; orchestrate lane did not make it, so it lands as asked.`)
    expect([status.text.includes("REUSED"), status.text.includes("DETACHED")]).toEqual([false, false])
    expect(status.text).toContain('next: orchestrate({ action: "land" })')
    const from = run.memory.landing.steps.length
    const landed = yield* run.probe(root, ORCHESTRATE, { action: "land", units: ["ui-input"] })
    expect([landed.error, landed.text.split("\n")[0]]).toEqual([false, expect.stringContaining("orchestrate: warning: ui-input's lane")])
    expect(run.memory.landing.steps.length).toBeGreaterThan(from)
  }),
)

seeded("workrift's folder rule in tools.ts is the work mod's", ({ expect }) =>
  Effect.sync(() => {
    for (const branch of ["feat/x", "wf10/ui input", "a/b/c", "-x/y-", "p5/db.2", "Fix/Ünicode"]) expect(workriftFolderOf(branch)).toBe(workspaceName(branch))
  }),
)
