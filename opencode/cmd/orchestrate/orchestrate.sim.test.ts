// The orchestrate plugin on the simulated host (sim/world.ts), each test at 20
// seeds: tests/orchestrate.test.ts's OpenCode runs under the same names, moved
// off real OpenCode (each booted the fork and waited on its events). The
// plugin is `cmd/orchestrate/server.ts`'s `make` on the world's plugin
// context, with OpenCode's adapters and memory doubles for what it keeps in
// files or asks of processes (sim/plugins.ts `orchestrate`). The model answers
// as tests/orchestrate/sim.ts's scripted model does; the pace is a plugin of
// the test's that answers the pool's `pace` as the real run's fixture does.
// What only the real host proves (the role agents against the skill, a unit's
// log.md through log.ts) stays in tests/orchestrate.test.ts.
import { POOL_STATUS } from "@dotfiles/opencode-pool/status"
import type { CallLine } from "@dotfiles/opencode-orchestrate/call-line"
import { KEEP } from "@dotfiles/opencode-orchestrate/compaction"
import { paceOfReply, parseAdmission } from "@dotfiles/opencode-orchestrate/pace"
import { definitions } from "@dotfiles/opencode-orchestrate/role"
import { Plugin } from "@opencode/plugin/effect"
import { Array as Arr, DateTime, Effect, Option, Schema } from "effect"
import * as Plugins from "../../sim/plugins.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = Seed.runner("cmd/orchestrate/orchestrate.sim.test.ts")

const WORK = "/scratch/work"
/** Friday 30 October 2026, 19:00 in Knowlton (EDT): after sunset, in the Sabbath. */
const FRIDAY_EVENING = "2026-10-30T23:00:00Z"
/** Wednesday 4 November 2026, 10:00 in Knowlton. */
const WEDNESDAY = "2026-11-04T15:00:00Z"
const SABBATH = /^It is the Sabbath; agent work resumes at Sat 18:\d\d \(30 min after sunset, Knowlton, QC\)\.$/

const ROOT_TASK = "orchestrate"
const UNTYPED_TASK = "task-untyped"
const REVIEW_TASK = "task-review"
const SUMMARY = "## Objective\n- sim summary"
const SUMMARIZE = "summarize the conversation above"

/** The sim provider's model, as the real run's config offers it: a window as large as Opus's, four efforts. */
const SIM_MODEL: World.CatalogModel = {
  providerID: "sim",
  id: "sim-model",
  modelID: "sim-model",
  limit: { context: 1_000_000 },
  cost: [],
  variants: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "max" }],
}

/** One request as the test reads it back: whose, its kind, its agent's system prompt, its tools and its text. */
interface Seen {
  readonly sessionID: string
  readonly kind: World.Kind
  readonly system: string
  readonly tools: ReadonlyArray<string>
  readonly text: string
  /** The conversation's first user line: the session's task. */
  readonly task: string
  /** The last message's text. */
  readonly last: string
}

const lines = (text: string) => text.split("\n")
/** A line that opens a message in a request's text. */
const OPENS = /^(user|synthetic|assistant|tool|compaction|error)[ :]/
/** The session's task: the text of its first user message, its last line (a child's first line is the spawned line). */
const taskOf = (text: string) => {
  const first = lines(text).findIndex((line) => line.startsWith("user: "))
  if (first < 0) return ""
  const own = Arr.takeWhile(lines(text).slice(first), (line, index) => index === 0 || !OPENS.test(line))
  const said = lines(own.join("\n").slice("user: ".length)).map((line) => line.trim())
  return Option.getOrElse(Arr.last(said.filter((line) => line !== "")), () => "")
}
/** The last message's text: from the last line that opens a message. */
const lastOf = (text: string) => {
  const all = lines(text)
  return all.slice(Math.max(0, all.findLastIndex((line) => OPENS.test(line)))).join("\n")
}

/**
 * tests/orchestrate/sim.ts's model on the world's requests: the root's `orchestrate` task calls `subagent` with no
 * agent, then with `orchestrate-reviewer`, then closes; a compaction answers the summary; any other request quotes
 * the last line it was told. Every reply reports `tokens` input tokens, by the task's agent before its `:`.
 */
const model = (seen: Array<Seen>, tokens: Readonly<Record<string, number>> = {}): World.Script => (request) => {
  const task = taskOf(request.text)
  const usage = { input: tokens[task.split(":")[0] ?? ""] ?? 100, read: 0, write: 0 }
  seen.push({ sessionID: request.sessionID, kind: request.kind, system: request.system, tools: request.tools, text: request.text, task, last: lastOf(request.text) })
  if (request.kind === "title") return World.say("Orchestrate run", usage)
  if (request.kind === "compaction") return World.say(SUMMARY, usage)
  const results = lines(request.text).filter((line) => line.startsWith("tool ")).length
  if (task === ROOT_TASK && request.tools.includes("subagent")) {
    if (results === 0) return World.call("call_untyped", "subagent", { description: "Untyped task", prompt: UNTYPED_TASK }, usage)
    if (results === 1) return World.call("call_review", "subagent", { agent: "orchestrate-reviewer", description: "Review task", prompt: REVIEW_TASK }, usage)
    return World.say("root: both subagents answered", usage)
  }
  return World.say(`sim: ${lines(lastOf(request.text)).at(-1) || "nothing"}`, usage)
}

/** The fixture's pool: only its `pace`, as the real run's fake pace plugin registers it. */
const PACE_ONLY = { ...POOL_STATUS, methods: { pace: POOL_STATUS.methods.pace } }

/** The pool's `pace` as the real run's fixture answers it: held or open, by a scripted weekly pace that opens a minute on. */
const pace = (held: boolean, now: number) =>
  Plugin.define({
    id: "fixture.pace",
    effect: (ctx) =>
      ctx.rpc
        .register(PACE_ONLY, { pace: () => Effect.succeed({ ok: !held, measured: true, reason: "scripted weekly pace", retryAt: now + 60_000 }) })
        .pipe(Effect.orDie, Effect.asVoid),
  })

interface Spec {
  readonly now: string
  /** The pool's pace holds every new agent, or opens; no pool at all when `none`. */
  readonly pace: "held" | "open" | "none"
  /** The Codex admission's answer, the sim provider paced as Codex; `unpaced` leaves the provider to the pool. */
  readonly codex: "admit" | "hold" | "unpaced"
  readonly tokens?: Readonly<Record<string, number>>
}

/** The Codex admission script's exit code and line, per answer, as the real run's fake script writes them. */
const CODEX_LINES = { admit: [0, "admit: scripted Codex pace"], hold: [1, "hold: scripted Codex week is over; opens about 2026-11-04 16:20Z"] } as const
/** The plugin's Codex options per answer: the sim provider paced as Codex, or the defaults. */
const CODEX_OPTIONS = {
  admit: { codex: { providers: ["sim"], script: "/nonexistent/loop-probe-x/budget.ts" } },
  hold: { codex: { providers: ["sim"], script: "/nonexistent/loop-probe-x/budget.ts" } },
  unpaced: {},
}
const PACE = { held: [true], open: [false], none: [] }

/** One world with the orchestrate plugin (and the pace fixture) loaded for the work dir, and what the run reads back. */
const boot = (seed: number, spec: Spec) =>
  Effect.gen(function* () {
    const now = Date.parse(spec.now)
    const seen: Array<Seen> = []
    const calls: Array<CallLine> = []
    const asked: Array<readonly [string, string]> = []
    const world = World.make({ seed, start: now, script: model(seen, spec.tokens), models: [SIM_MODEL], model: { providerID: "sim", id: "sim-model" } })
    const answers = { admit: Option.some(CODEX_LINES.admit), hold: Option.some(CODEX_LINES.hold), unpaced: Option.none<(typeof CODEX_LINES)["admit" | "hold"]>() }
    const codex = (model: string, role: string) => {
      asked.push([model, role])
      return Option.flatMap(answers[spec.codex], ([code, line]) => Option.fromUndefinedOr(paceOfReply(parseAdmission(code, `${line}\n`))))
    }
    yield* world.load(Plugins.orchestrate({ lines: calls, codex }), { directory: WORK, options: { now: spec.now, ...CODEX_OPTIONS[spec.codex] } })
    for (const held of PACE[spec.pace]) yield* world.load(pace(held, now), { directory: WORK })
    const children = (parent: string) => [...world.sessions.values()].filter((session) => session.parentID._tag === "Some" && session.parentID.value === parent)
    const rested = () => [...world.sessions.values()].every((session) => !session.running && session.inbox.length === 0)
    /** A root session on `task`, run until every session in the world is at rest. */
    const root = (task: string, input: { readonly agent?: string; readonly model?: World.ModelRef } = {}) =>
      Effect.gen(function* () {
        const id = yield* world.session(WORK, input)
        yield* world.prompt(id, task)
        yield* world.until(rested, 120_000)
        return id
      })
    return { world, seen, calls, asked, children, rested, root }
  })

/** The call log's lines of one kind. */
const ofKind = <K extends CallLine["kind"]>(calls: ReadonlyArray<CallLine>, kind: K) =>
  calls.filter((line): line is Extract<CallLine, { readonly kind: K }> => line.kind === kind)

/** A session's messages as one JSON text, for a test to look into. */
const jsonOf = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const textOf = (world: World.World, sessionID: string) => jsonOf(world.messages(sessionID))

seeded("pace: with no wakes to keep a latch, an over-limit pool refuses new agents with when it opens; under pace they run", ({ seed, expect }) =>
  Effect.gen(function* () {
    const held = yield* boot(seed, { now: WEDNESDAY, pace: "held", codex: "unpaced" })
    const heldRoot = yield* held.root(ROOT_TASK)
    expect(held.children(heldRoot)).toEqual([])
    const messages = textOf(held.world, heldRoot)
    expect(messages).toContain("pace holds this agent")
    // The fake pool says it opens a minute on; the latch itself is the wakes'.
    expect(messages).toContain(`It opens about ${DateTime.formatIso(DateTime.makeUnsafe(Date.parse(WEDNESDAY) + 60_000))}`)
    expect(messages).toContain("no latch could be kept for it")
    const open = yield* boot(seed, { now: WEDNESDAY, pace: "open", codex: "unpaced" })
    const openRoot = yield* open.root(ROOT_TASK)
    expect(open.children(openRoot).map((child) => child.agent).toSorted()).toEqual(["verifier", "worker"])
  }),
)

seeded("codex pace: a subagent on a Codex-paced provider asks the Codex admission, with its model and role", ({ seed, expect }) =>
  Effect.gen(function* () {
    const held = yield* boot(seed, { now: WEDNESDAY, codex: "hold", pace: "open" })
    const heldRoot = yield* held.root(ROOT_TASK)
    expect(held.children(heldRoot)).toEqual([])
    const messages = textOf(held.world, heldRoot)
    expect(messages).toContain("the Codex account's pace holds this agent. scripted Codex week is over.")
    // It opens when the admission said the week opens.
    expect(messages).toContain("It opens about 2026-11-04T16:20:00.000Z")
    // The admission is asked with the model and the role, as the script's `--model sim-model --role <role>`.
    expect(held.asked).toContainEqual(["sim-model", "worker"])
    expect(held.asked).toContainEqual(["sim-model", "verifier"])
    // Admitted, they run, and the pool is not asked: its fake would hold them.
    const open = yield* boot(seed, { now: WEDNESDAY, codex: "admit", pace: "held" })
    const openRoot = yield* open.root(ROOT_TASK)
    expect(open.children(openRoot).map((child) => child.agent).toSorted()).toEqual(["verifier", "worker"])
  }),
)

seeded("guard: an untyped subagent runs as the worker, `orchestrate-reviewer` as the verifier at medium effort", ({ seed, expect }) =>
  Effect.gen(function* () {
    const run = yield* boot(seed, { now: WEDNESDAY, pace: "none", codex: "unpaced" })
    const rootID = yield* run.root(ROOT_TASK)
    const children = run.children(rootID)
    const byAgent = Object.fromEntries(children.map((child) => [child.agent, child]))
    // The child sessions, as the host's session API reports them.
    expect(children.map((child) => child.agent).toSorted()).toEqual(["verifier", "worker"])
    expect(byAgent.verifier?.model._tag === "Some" && byAgent.verifier.model.value).toEqual({ id: "sim-model", providerID: "sim", variant: "medium" })
    const variant = Option.flatMap(Option.fromUndefinedOr(byAgent.worker), (worker) => Option.flatMap(worker.model, (model) => Option.fromUndefinedOr(model.variant)))
    expect(variant).toEqual(Option.none())
    // Each child ran on its role's prompt.
    const system = (task: string) => run.seen.find((request) => request.task === task)?.system
    expect(system(UNTYPED_TASK)).toContain(definitions.worker.system)
    expect(system(REVIEW_TASK)).toContain(definitions.verifier.system)
    // The worker is offered only its permitted tools: no subagent, no question.
    const tools = run.seen.find((request) => request.task === UNTYPED_TASK)?.tools ?? []
    expect(tools).not.toContain("subagent")
    expect(tools).toContain("shell")
    // The call log: what was asked, what ran and why, then each child's session and how its call ended: running,
    // since OpenCode runs every subagent in the background.
    const calls = ofKind(run.calls, "call")
    expect(calls.map((line) => ({ asked: Option.fromUndefinedOr(line.asked), agent: line.agent, reason: line.reason, model: Option.fromUndefinedOr(line.model) }))).toEqual([
      { asked: Option.none(), agent: "worker", reason: "untyped", model: Option.none() },
      { asked: Option.some("orchestrate-reviewer"), agent: "verifier", reason: "renamed", model: Option.some("sim/sim-model#medium") },
    ])
    const done = ofKind(run.calls, "done")
    expect(done.map((line) => ({ child: line.child, status: line.status }))).toEqual([
      { child: byAgent.worker?.id, status: "running" },
      { child: byAgent.verifier?.id, status: "running" },
    ])
    expect(done.map((line) => line.callID)).toEqual(calls.map((line) => line.callID))
  }),
)

seeded("worker ceiling: under a root at max, the untyped worker runs at its model's default and the parent is told why; the verifier at medium", ({ seed, expect }) =>
  Effect.gen(function* () {
    const run = yield* boot(seed, { now: WEDNESDAY, pace: "none", codex: "unpaced" })
    const rootID = yield* run.root(ROOT_TASK, { model: { providerID: "sim", id: "sim-model", variant: "max" } })
    const byAgent = Object.fromEntries(run.children(rootID).map((child) => [child.agent, child]))
    // The host names a model asked with no variant at its `default`.
    expect(byAgent.worker?.model._tag === "Some" && byAgent.worker.model.value).toEqual({ id: "sim-model", providerID: "sim", variant: "default" })
    expect(byAgent.verifier?.model._tag === "Some" && byAgent.verifier.model.value).toEqual({ id: "sim-model", providerID: "sim", variant: "medium" })
    const calls = ofKind(run.calls, "call")
    expect(calls.map((line) => ({ agent: line.agent, model: line.model, lowered: Option.fromUndefinedOr(line.lowered) }))).toEqual([
      { agent: "worker", model: "sim/sim-model", lowered: Option.some("max") },
      { agent: "verifier", model: "sim/sim-model#medium", lowered: Option.none() },
    ])
    expect(textOf(run.world, rootID)).toContain(
      "orchestrate: this worker runs on sim/sim-model at the model's default effort, not max: a worker runs at max only when its description ends `(mechanical)`.",
    )
  }),
)

seeded("compaction: on a 1M model, a planner session at 350k compacts at the 400k window; a worker session at 200k does not", ({ seed, expect }) =>
  Effect.gen(function* () {
    // The 400k window's ceiling is 340k (less its 15% reserve): the planner's 350k is over it, far under the model's
    // own 850k; the worker's 200k is under it, and over the 170k a 200k window would compact at.
    const run = yield* boot(seed, { now: WEDNESDAY, pace: "none", codex: "unpaced", tokens: { planner: 350_000, worker: 200_000 } })
    const sessions: Record<string, string> = {}
    for (const agent of ["planner", "worker"]) {
      const id = yield* run.world.session(WORK, { agent })
      yield* run.world.prompt(id, `${agent}: first`)
      yield* run.world.until(run.rested, 60_000)
      yield* run.world.prompt(id, `${agent}: second`)
      yield* run.world.until(run.rested, 60_000)
      sessions[agent] = id
    }
    const messages = (agent: string) => run.world.messages(sessions[agent] ?? "")
    const compactions = (agent: string) => messages(agent).filter((message): message is Extract<World.Message, { readonly type: "compaction" }> => message.type === "compaction")
    expect(run.world.sessions.get(sessions.planner ?? "")?.agent).toBe("planner")
    expect(compactions("planner").map(({ status, reason }) => ({ status, reason }))).toEqual([{ status: "completed", reason: "auto" }])
    // The planner's second turn went on from the summary: its answer follows the compaction.
    expect(messages("planner").at(-1)?.type).toBe("assistant")
    expect(messages("planner").findIndex((message) => message.type === "compaction")).toBeLessThan(messages("planner").length - 1)
    expect(compactions("worker")).toEqual([])
    // The compaction request carried the keep-list after the conversation, right before the summary prompt, not in
    // its system, so its prefix is the normal request's and stays cached; no other request carried it.
    expect(run.seen.filter((request) => request.system.includes(KEEP))).toEqual([])
    const keeping = run.seen.filter((request) => request.text.includes(KEEP))
    expect(keeping.length).toBe(1)
    const compaction = keeping[0]
    expect(compaction?.task).toBe("planner: first")
    expect(compaction?.last).toContain(SUMMARIZE)
    // Every message the planner's request before it sent opens the compaction request unchanged, and the keep-list
    // comes after them, right before the summary prompt.
    const asked = run.seen.filter((request) => request.kind !== "title")
    const before = asked[asked.indexOf(compaction ?? asked[0]!) - 1]
    expect(before?.task).toBe("planner: first")
    expect(compaction?.text.startsWith(before?.text ?? "-")).toBe(true)
    expect(compaction?.text.slice((before?.text ?? "").length, -SUMMARIZE.length)).toContain(KEEP)
    expect(jsonOf(messages("planner"))).toContain(SUMMARY.split("\n")[1])
  }),
)

seeded("Sabbath: on Friday evening the subagent calls are refused with when work resumes, and no child starts", ({ seed, expect }) =>
  Effect.gen(function* () {
    const run = yield* boot(seed, { now: FRIDAY_EVENING, pace: "none", codex: "unpaced" })
    const rootID = yield* run.root(ROOT_TASK)
    expect(run.children(rootID)).toEqual([])
    const denied = ofKind(run.calls, "denied")
    expect(denied.map((line) => line.tool)).toEqual(["subagent", "subagent"])
    for (const line of denied) expect(line.why).toMatch(SABBATH)
    // The model was told, in the tool result.
    const results = run.seen.filter((request) => request.task === ROOT_TASK && request.kind === "primary").map((request) => request.last)
    expect(results.slice(1).every((text) => text.includes("No agent starts now."))).toBe(true)
    expect(results.slice(1).every((text) => /It is the Sabbath; agent work resumes at Sat 18:\d\d/.test(text))).toBe(true)
  }),
)
