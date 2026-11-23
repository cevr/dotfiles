// @reads all
// @reads-reason computed read at mods/pool/store/store.ts: names: (path) => Effect.try({ try: () => readdirSync(path), catch: (cause) => cause }),
// Finished work that never reached main, as `orchestrate status` says it on the simulated host (orch-tools-world.ts:
// the real orchestrate, rift and status plugins on their memory layers; git's answers in memory/work-git.ts). A unit
// handed back ready whose head is not on main is named first once it is past the threshold, never before, and no longer
// once its log ends it (`dropped`); a lane holding commits not on main that nobody is on is named in the lane-first list
// with its age, commits, subject and session, and leaves it while a process works in it.
import { OnMain } from "@dotfiles/opencode-orchestrate/lost"
import { LOST } from "@dotfiles/opencode-orchestrate/lost-now"
import * as MemoryRifts from "@dotfiles/opencode-work/memory/rifts"
import { Effect, Fiber, Option } from "effect"
import * as Plugins from "../../sim/plugins.ts"
import * as Seed from "../../sim/seed.ts"
import { boot, HAND_BACK, RUN_DIR, requestHeadFor, WORK } from "./orch-tools-world.ts"

const { seeded } = Seed.runner("cmd/orchestrate/lost.sim.test.ts")

const ORCHESTRATE = "orchestrate"
const READY = "/nonexistent/loop-probe-x/request.md"
const HOUR = 3_600_000
const LANE = "/scratch/.work/work/billing"
const ORPHAN = "/scratch/.work/work/orphan"

seeded("LOST1: a ready hand-back not on main is named first past the threshold and not after its log drops it; an orphan lane is named until a process works in it", ({ expect, seed }) =>
  Effect.gen(function* () {
    const run = yield* boot(seed, true)
    const root = yield* run.world.session(WORK)
    const laned = yield* run.probe(root, ORCHESTRATE, { action: "lane", unit: "billing", purpose: "Bill each seat once" })
    expect(laned.error).toBe(false)
    const head = requestHeadFor("billing", 1)
    const request = `${RUN_DIR}/billing/round-1-request.md`
    run.files.set(request, { text: `Head: ${head}\n`, at: run.world.now() })
    run.workGit.heads.set(head, { onMain: OnMain.cases.Absent.make({ missing: [head], own: [head], subject: "bill each seat once" }), at: Option.some(run.world.now()) })
    yield* run.probe(root, "subagent", { agent: "implementor", description: `implementor billing r1 (lane: ${LANE})`, prompt: `${HAND_BACK} implementor billing r1: ready ${READY}`, background: true })
    yield* run.world.until(run.settled, 60_000)
    yield* run.world.until(() => Option.exists(Option.fromUndefinedOr(run.logs.get("billing")), (log) => log.state === "ready"), 30_000)
    // Fresh: within the threshold, nothing is said.
    const fresh = yield* run.probe(root, ORCHESTRATE, { action: "status" })
    expect(fresh.text).not.toContain("ready, not landed")
    // Its request seven hours old: named first, with its lane and what to do.
    run.files.set(request, { text: `Head: ${head}\n`, at: run.world.now() - 7 * HOUR })
    const late = yield* run.probe(root, ORCHESTRATE, { action: "status" })
    expect(late.text.split("\n").slice(0, 2)).toEqual(["orchestrate: ready, not landed (1, oldest first):", `- ready, not landed 7 h: billing ${head.slice(0, 9)} ${LANE}`])
    expect(late.text).toContain("dropped r<N> superseded-by <hash>")
    // A lane with commits not on main, still two days, no session in it: the lane-first list names it.
    const orphan = { ...MemoryRifts.clean(ORPHAN, "feat/orphan"), head: "0fa0fa0fa" }
    run.memory.rifts.rifts.set(ORPHAN, orphan)
    run.workGit.heads.set("0fa0fa0fa", { onMain: OnMain.cases.Absent.make({ missing: ["0fa0fa0fa", "0fb"], own: ["0fa0fa0fa", "0fb"], subject: "orphan work" }), at: Option.some(run.world.now() - 48 * HOUR) })
    const lanes = yield* run.probe(root, ORCHESTRATE, { action: "status" })
    expect(lanes.text).toContain(`orchestrate: committed work not on main, nobody on it (1, oldest first):\n- ${ORPHAN} · 2 d · 2 commits · orphan work · no session known`)
    // The unit's log ends it, and a process works in the orphan lane: neither is named.
    run.logs.set("billing", { state: "dropped", round: 1 })
    run.workGit.held.add(ORPHAN)
    const after = yield* run.probe(root, ORCHESTRATE, { action: "status" })
    expect(after.text).not.toContain("not landed")
    expect(after.text).not.toContain("nobody on it")
  }),
)

seeded("LOST2: the queue check's RPC answers an orchestrator status's own lost lines, keyed by lane, and any root the commits its queue names that are due", ({ expect, seed }) =>
  Effect.gen(function* () {
    const run = yield* boot(seed, true, { unitsAnswer: true })
    const root = yield* run.world.session(WORK)
    const other = yield* run.world.session(WORK)
    const laned = yield* run.probe(root, ORCHESTRATE, { action: "lane", unit: "billing", purpose: "Bill each seat once" })
    expect(laned.error).toBe(false)
    yield* run.probe(root, "subagent", { agent: "implementor", description: `implementor billing r1 (lane: ${LANE})`, prompt: `${HAND_BACK} implementor billing r1: ready ${READY}`, background: true })
    yield* run.world.until(run.settled, 60_000)
    run.memory.rifts.rifts.set(ORPHAN, { ...MemoryRifts.clean(ORPHAN, "feat/orphan"), head: "0fa0fa0fa" })
    run.workGit.heads.set("0fa0fa0fa", { onMain: OnMain.cases.Absent.make({ missing: ["0fa0fa0fa", "0fb"], own: ["0fa0fa0fa", "0fb"], subject: "orphan work" }), at: Option.some(run.world.now() - 48 * HOUR) })
    const status = yield* run.probe(root, ORCHESTRATE, { action: "status" })
    // The call as the queue plugin makes it, on a fiber of the world, run until it answers (the rift plugin answers it over its own RPC).
    const lost = (sessionID: string) =>
      Effect.gen(function* () {
        const fiber = run.world.runtime.fork(run.world.clientRpc(LOST.id, "lost", { sessionID, hashes: ["0fa0fa0fa", "c0ffee1"] }))
        yield* run.world.until(() => Option.isSome(Option.fromNullishOr(fiber.pollUnsafe())), 60_000)
        return yield* Fiber.join(fiber)
      })
    const told = yield* lost(root)
    const why = "not on main: 2 commits not there, committed 2 d ago; land it, or mark it superseded or dropped"
    expect(told).toEqual({ lines: status.text.split("\n").slice(0, 3), keys: [ORPHAN], hashes: [{ hash: "0fa0fa0fa", why }] })
    // A root that started no unit's step hears of no lane: only of the commits its own queue names.
    expect(yield* lost(other)).toEqual({ lines: [], keys: [], hashes: [{ hash: "0fa0fa0fa", why }] })
  }),
)

seeded("LOST3: the queue plugin's staleness check tells the orchestrator of the orphan lane and the item naming its commit, through orchestrate's RPC", ({ expect, seed }) =>
  Effect.gen(function* () {
    const run = yield* boot(seed, true, { unitsAnswer: true })
    yield* run.world.load(Plugins.queue(), { directory: WORK })
    const root = yield* run.world.session(WORK)
    yield* run.probe(root, ORCHESTRATE, { action: "lane", unit: "billing", purpose: "Bill each seat once" })
    yield* run.probe(root, "subagent", { agent: "implementor", description: `implementor billing r1 (lane: ${LANE})`, prompt: `${HAND_BACK} implementor billing r1: ready ${READY}`, background: true })
    yield* run.world.until(run.settled, 60_000)
    run.memory.rifts.rifts.set(ORPHAN, { ...MemoryRifts.clean(ORPHAN, "feat/orphan"), head: "0fa0fa0fa" })
    run.workGit.heads.set("0fa0fa0fa", { onMain: OnMain.cases.Absent.make({ missing: ["0fa0fa0fa", "0fb"], own: ["0fa0fa0fa", "0fb"], subject: "orphan work" }), at: Option.some(run.world.now() - 48 * HOUR) })
    yield* run.probe(root, "queue", { set: [{ id: "orphan", text: "land 0fa0fa0fa (orphan work)", state: "next" }] })
    const noted = () =>
      run.world
        .messages(root)
        .filter((message): message is Extract<typeof message, { readonly type: "synthetic" }> => message.type === "synthetic")
        .map((message) => message.text)
        .filter((text) => text.startsWith("Queue check"))
    yield* run.world.until(() => noted().length > 0, HOUR)
    const note = noted().join("\n")
    expect(note).toContain("- orphan [next]: land 0fa0fa0fa (orphan work) (it names commit 0fa0fa0fa, not on main: 2 commits not there, committed 2 d ago")
    expect(note).toContain(`orchestrate: committed work not on main, nobody on it (1, oldest first):\n- ${ORPHAN} · 2 d · 2 commits · orphan work · no session known`)
  }),
)
