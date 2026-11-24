// Fast, asked per start, on the simulated host (sim/world.ts), each test at
// 20 seeds. The owner's call (2026-11-24): "it's per worker … they can spawn a
// worker that's fast or not based on the owner's discretion". A start asks it
// with the subagent tool's `fast` field, or by naming a fast mode as its
// model (the same ask in another spelling); it then runs on the fast mode of
// the model it would have run on, its fallback's when held, and says so on
// its call line and first in its answer. A start that does not ask never
// runs on a mode. The orchestrate and wakes plugins are their composition
// roots on the world (sim/plugins.ts); the pool is a stand-in that admits,
// holds the first model's provider, or holds for a while; the catalog offers
// the first model with its fast mode, a model with none, and two sols with
// their fast modes. The model answers by the scripts' rules below.
import type { CallLine } from "@dotfiles/opencode-orchestrate/call-line"
import { FAST_AS_ASKED, FAST_AS_STARTED } from "@dotfiles/opencode-orchestrate/call-line"
import { paceOfReply, parseAdmission } from "@dotfiles/opencode-orchestrate/pace"
import { POOL_STATUS } from "@dotfiles/opencode-pool/status"
import { Plugin } from "@opencode/plugin/effect"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Array as Arr, Effect, Option, Schema } from "effect"
import * as Plugins from "../../sim/plugins.ts"
import { simulationRunner } from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = simulationRunner("cmd/orchestrate/orchestrate-fast.sim.test.ts")

const WORK = "/scratch/project"
/** The orchestrate plugin's fixed clock: a Wednesday afternoon, so only the pace holds. */
const PIN = "2026-11-04T15:00:00Z"

const ASK = "Check the export in a worker."
const BRIEF = "Worker brief Q: check the CSV export."
const AGAIN = "Worker brief Q2: check the PDF export too."
const ANSWER = "The export check passed."
const ANSWERED_AGAIN = "The PDF export check passed."
const HEARD = "Root heard: the export check passed."
const GRAND = "Nested brief G: check the export's header row."
const GRAND_ANSWER = "The header row check passed."

/** A catalog model, as opencode-drive's simulation provider offers one. */
const offered = (providerID: string, id: string, fields: Partial<World.CatalogModel> = {}): World.CatalogModel => ({
  providerID,
  id,
  modelID: id,
  limit: { context: 128_000 },
  cost: [],
  variants: [{ id: "low" }, { id: "medium" }, { id: "high" }],
  ...fields,
})
/** The catalog's fast mode of a model: a model of its own, `<id>-fast`, asking `<id>` (models-dev.ts). */
const fastMode = (model: World.CatalogModel): World.CatalogModel => ({ ...model, id: `${model.id}-fast`, modelID: model.id })

const FIRST = offered("simulation", "gpt-sim-model")
const PLAIN = offered("simulation", "plain-model")
/** A model the worker does not inherit, with its fast mode: naming the role's own model drops the name (model-dropped). */
const OTHER = offered("simulation", "other-model")
const sol = (id: string, releaseDate: string) => offered("codex", id, { variants: [{ id: "high" }], family: "gpt-sol", time: { released: Date.parse(releaseDate) } })
const SOL = sol("gpt-6.1-sol", "2026-09-29")
const OPUS = offered("anthropic", "claude-opus-5-5", { family: "claude-opus", time: { released: Date.parse("2026-10-01") } })
const CATALOG = [FIRST, fastMode(FIRST), OPUS, fastMode(OPUS), OTHER, fastMode(OTHER), PLAIN, sol("gpt-6-sol", "2026-06-01"), SOL, fastMode(SOL)]

/** One request as a test reads it back: the agent's, its model, its text. */
interface Seen {
  readonly agent: string
  readonly model: World.ModelRef
  readonly text: string
}

/** What the root asks: one start, and optionally a follow-up to its child once it answered. */
interface Asks {
  readonly start: SubagentCall
  readonly followUp?: SubagentCall
  /** What the started child starts in turn (nesting depth 2), before it answers. */
  readonly nested?: SubagentCall
}

/** A subagent call's input as these tests make one. */
interface SubagentCall {
  readonly agent: string
  readonly description: string
  readonly prompt: string
  readonly model?: string
  readonly fast?: boolean
}

/** A child's answer on its request text `s`, its latest brief deciding; one with a nested start makes it, waits for its answer, then answers. */
const childAnswer = (s: string, asks: Asks) => {
  if (!s.includes(BRIEF) && s.includes(GRAND)) return World.say(GRAND_ANSWER)
  if (s.includes(AGAIN)) return World.say(ANSWERED_AGAIN)
  if (!s.includes(BRIEF)) return World.say("?")
  return Option.match(Option.fromUndefinedOr(asks.nested), {
    onNone: () => World.say(ANSWER),
    onSome: (nested) => {
      if (!s.includes("call_nested")) return World.call("call_nested", "subagent", { ...nested })
      if (!s.includes(GRAND_ANSWER)) return World.say("waiting")
      return World.say(ANSWER)
    },
  })
}

/** The root's and the workers' answers, on the world's request text; `child` names the started child for a follow-up. */
const script =
  (seen: Array<Seen>, asks: Asks, child: () => string): World.Script =>
  (request) => {
    seen.push({ agent: request.agent, model: request.model, text: request.text })
    const s = request.text
    if (request.kind === "title") return World.say("export check")
    // A worker's request carries its briefs, never the parent's prompt.
    if (!s.includes(ASK)) return childAnswer(s, asks)
    const followUp = Option.fromUndefinedOr(asks.followUp)
    if (s.includes(ANSWERED_AGAIN) || (Option.isNone(followUp) && s.includes(ANSWER))) return World.say(HEARD)
    if (Option.isSome(followUp) && s.includes(ANSWER) && !s.includes("call_again"))
      return World.call("call_again", "subagent", { ...followUp.value, sessionID: child() })
    if (!s.includes("call_start")) return World.call("call_start", "subagent", { ...asks.start })
    return World.say("?")
  }

/** How the stand-in pool answers: room for every agent, a hold on the first model's provider, or a hold for the first twelve seconds. */
type Pace = "room" | "holds-first" | "holds-a-while"
const HOLD_MS = 12_000
const POOL = { ...POOL_STATUS, methods: { pace: POOL_STATUS.methods.pace, started: POOL_STATUS.methods.started } }
const ProviderInput = Schema.Struct({ providerID: Schema.String })
const pool = (pace: Pace, now: () => number) =>
  Plugin.define({
    id: "fixture.pool",
    effect: (ctx) =>
      ctx.rpc
        .register(POOL, {
          pace: (input) =>
            Effect.sync(() => {
              const held = { ok: false, measured: true, reason: "scripted 5h window is full" }
              if (pace === "holds-first" && Schema.decodeUnknownSync(ProviderInput)(input).providerID === FIRST.providerID)
                return { ...held, retryAt: Date.parse(PIN) + 3_600_000 }
              if (pace === "holds-a-while" && now() < Date.parse(PIN) + HOLD_MS) return { ...held, retryAt: Date.parse(PIN) + HOLD_MS }
              return { ok: true, measured: true, reason: "scripted room" }
            }),
          started: () => Effect.succeed({}),
        })
        .pipe(Effect.orDie, Effect.asVoid),
  })

/** The owner's agent config naming a fast mode as the worker's model, as an agent file would (loaded after the plugin). */
const workerOnFast = Plugin.define({
  id: "fixture.worker-on-fast",
  effect: (ctx) =>
    ctx.agent.transform((editor) =>
      editor.update("worker", (agent) => {
        agent.model = { providerID: Provider.ID.make(FIRST.providerID), id: Model.ID.make(`${FIRST.id}-fast`) }
      }),
    ),
})

/** The run on one world: the root's ask, its start (and follow-up), until the root heard the answer. */
const boot = (seed: number, asks: Asks, pace: Pace = "room", rootModel: World.CatalogModel = FIRST, config: ReadonlyArray<typeof workerOnFast> = []) =>
  Effect.gen(function* () {
    const seen: Array<Seen> = []
    const calls: Array<CallLine> = []
    let root = ""
    const world = World.make({
      seed,
      start: Date.parse(PIN),
      script: script(seen, asks, () => {
        for (const session of world.sessions.values()) if (Option.contains(session.parentID, root)) return session.id
        return ""
      }),
      models: CATALOG,
      model: { providerID: rootModel.providerID, id: rootModel.id },
      subagentDepth: 2,
    })
    // The Codex admission stand-in admits every fallback.
    const codex = () => Option.fromUndefinedOr(paceOfReply(parseAdmission(0, "admit: scripted room\n")))
    const options = { now: PIN, codex: { providers: ["codex"], script: "/nonexistent/loop-probe-x/admit.ts" } }
    yield* world.load(Plugins.orchestrate({ lines: calls, codex }), { directory: WORK, options })
    yield* world.load(Plugins.wake(world), { directory: WORK, options: { backstop: "off" } })
    yield* world.load(pool(pace, () => world.now()), { directory: WORK })
    for (const plugin of config) yield* world.load(plugin, { directory: WORK })
    root = yield* world.session(WORK)
    yield* world.prompt(root, ASK)
    yield* world.until(() => world.messages(root).some((message) => message.type === "assistant" && message.text === HEARD), 120_000)
    const parent = seen.flatMap((request) => Arr.filter([request.text], (text) => text.includes(ASK))).at(-1)
    const worker = (brief: string) => seen.flatMap((request) => Arr.filter([request.model], () => !request.text.includes(ASK) && request.text.includes(brief)))
    const grand = seen.flatMap((request) => Arr.filter([request.model], () => request.text.includes(GRAND) && !request.text.includes(BRIEF)))
    return { calls, worker, grand, parent: Option.getOrElse(Option.fromUndefinedOr(parent), () => "") }
  })

const WORKER = { agent: "worker", description: "Check the export", prompt: BRIEF }
const started = (calls: ReadonlyArray<CallLine>) => calls.filter((line) => line.kind === "call")

seeded("a worker asked fast runs on the fast mode of the model it would run on, and says so on its line and in its answer", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { calls, worker, parent } = yield* boot(seed, { start: { ...WORKER, fast: true } })
    expect(started(calls)[0]).toMatchObject({ agent: "worker", model: "simulation/gpt-sim-model-fast", fast: FAST_AS_ASKED })
    expect(worker(BRIEF)).toContainEqual(expect.objectContaining({ providerID: "simulation", id: "gpt-sim-model-fast" }))
    expect(parent).toContain(`orchestrate: this agent runs on simulation/gpt-sim-model-fast: ${FAST_AS_ASKED}.`)
  }),
)

seeded("a start that does not ask fast never runs on a fast mode, though its model has one", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { calls, worker, parent } = yield* boot(seed, { start: { ...WORKER, model: "simulation/other-model#medium" } })
    expect(started(calls)[0]).toMatchObject({ model: "simulation/other-model#medium" })
    expect(started(calls)[0]).not.toHaveProperty("fast")
    for (const model of worker(BRIEF)) expect(model.id).toBe("other-model")
    expect(parent).not.toContain("fast")
  }),
)

seeded("naming the fast mode is the same ask as the field: the same model, the same line", ({ seed, expect }) =>
  Effect.gen(function* () {
    const named = yield* boot(seed, { start: { ...WORKER, model: "simulation/other-model-fast#medium" } })
    const field = yield* boot(seed, { start: { ...WORKER, model: "simulation/other-model#medium", fast: true } })
    const line = { model: "simulation/other-model-fast#medium", fast: FAST_AS_ASKED }
    expect(started(named.calls)[0]).toMatchObject(line)
    expect(started(field.calls)[0]).toMatchObject(line)
    expect(named.worker(BRIEF)).toEqual(field.worker(BRIEF))
  }),
)

seeded("asked fast on a model with no fast mode, it runs standard and its answer says so", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { calls, worker, parent } = yield* boot(seed, { start: { ...WORKER, model: "simulation/plain-model", fast: true } })
    const said = "fast asked, but simulation/plain-model has no fast mode: it runs standard"
    expect(started(calls)[0]).toMatchObject({ model: "simulation/plain-model", fast: said })
    for (const model of worker(BRIEF)) expect(model.id).toBe("plain-model")
    expect(parent).toContain(`orchestrate: this agent runs on simulation/plain-model: ${said}.`)
  }),
)

seeded("a held planner asked fast falls back to the fast mode of the newest sol", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { calls, worker } = yield* boot(seed, { start: { agent: "planner", description: "Plan the export", prompt: BRIEF, fast: true } }, "holds-first")
    expect(started(calls)[0]).toMatchObject({ agent: "planner", model: "codex/gpt-6.1-sol-fast#high", fast: FAST_AS_ASKED })
    expect(started(calls)[0]).toMatchObject({ fallback: expect.stringContaining("held: scripted 5h window is full") })
    expect(worker(BRIEF)).toContainEqual({ providerID: "codex", id: "gpt-6.1-sol-fast", variant: "high" })
  }),
)

seeded("a held planner that does not ask fast falls back to the standard sol", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { calls } = yield* boot(seed, { start: { agent: "planner", description: "Plan the export", prompt: BRIEF } }, "holds-first")
    expect(started(calls)[0]).toMatchObject({ model: "codex/gpt-6.1-sol#high" })
    expect(started(calls)[0]).not.toHaveProperty("fast")
  }),
)

seeded("a follow-up keeps the fast mode its child started on, and goes standard when it says not fast", ({ seed, expect }) =>
  Effect.gen(function* () {
    const kept = yield* boot(seed, { start: { ...WORKER, fast: true }, followUp: { ...WORKER, prompt: AGAIN } })
    for (const model of kept.worker(AGAIN)) expect(model.id).toBe("gpt-sim-model-fast")
    // Its line says it runs fast, as it started, not only its row.
    expect(started(kept.calls)[1]).toMatchObject({ reason: "continued", fast: FAST_AS_STARTED })
    const back = yield* boot(seed, { start: { ...WORKER, fast: true }, followUp: { ...WORKER, prompt: AGAIN, fast: false } })
    expect(back.worker(AGAIN).at(-1)).toMatchObject({ id: "gpt-sim-model" })
    expect(started(back.calls)[1]).toMatchObject({ model: "simulation/gpt-sim-model" })
    expect(started(back.calls)[1]).not.toHaveProperty("fast")
  }),
)

seeded("a fast start the pace holds latches as any start does, and opens on the fast mode", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { calls, worker } = yield* boot(seed, { start: { ...WORKER, fast: true } }, "holds-a-while")
    const latched = calls.find((line) => line.kind === "latched")
    expect(latched).toMatchObject({ hold: "pace", fast: FAST_AS_ASKED, model: "simulation/gpt-sim-model-fast" })
    expect(started(calls).at(-1)).toMatchObject({ model: "simulation/gpt-sim-model-fast", fast: FAST_AS_ASKED })
    expect(worker(BRIEF)).toContainEqual(expect.objectContaining({ id: "gpt-sim-model-fast" }))
  }),
)

/** Each agent a start can ask for, by name or by none (`general` runs as the worker); a reviewer is a verifier. */
const UNASKED: ReadonlyArray<{ readonly start: SubagentCall; readonly runs: string }> = [
  { start: { agent: "planner", description: "Plan the export", prompt: BRIEF }, runs: "gpt-sim-model" },
  { start: { agent: "implementor", description: "Fix the export", prompt: BRIEF }, runs: "claude-opus-5-5" },
  { start: WORKER, runs: "gpt-sim-model" },
  { start: { ...WORKER, agent: "general" }, runs: "gpt-sim-model" },
  { start: { agent: "verifier", description: "Review the export", prompt: BRIEF }, runs: "claude-opus-5-5" },
]

seeded("under a parent on a fast mode (the default model here), a start that asks nothing runs standard, whatever its agent", ({ seed, expect }) =>
  Effect.gen(function* () {
    for (const each of UNASKED) {
      const { calls, worker } = yield* boot(seed, { start: each.start }, "room", fastMode(FIRST))
      expect(worker(BRIEF).length).toBeGreaterThan(0)
      for (const model of worker(BRIEF)) expect({ agent: each.start.agent, id: model.id }).toEqual({ agent: each.start.agent, id: each.runs })
      // The configured fast mode it did not use is said, never a fast ask.
      const line = started(calls)[0]
      expect(line).not.toMatchObject({ fast: FAST_AS_ASKED })
      if (each.runs === "gpt-sim-model") expect(line).toMatchObject({ fast: expect.stringMatching(/^standard: simulation\/gpt-sim-model-fast(#\w+)? is a fast mode, and this start did not ask fast$/) })
    }
  }),
)

seeded("under a parent on a fast mode, a start that asks fast runs fast", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { calls, worker } = yield* boot(seed, { start: { ...WORKER, fast: true } }, "room", fastMode(FIRST))
    for (const model of worker(BRIEF)) expect(model.id).toBe("gpt-sim-model-fast")
    expect(started(calls)[0]).toMatchObject({ fast: FAST_AS_ASKED })
  }),
)

seeded("at depth 2, a child of a worker started fast runs standard unless it asks fast itself", ({ seed, expect }) =>
  Effect.gen(function* () {
    const nested = { agent: "worker", description: "Check the header", prompt: GRAND }
    for (const agent of ["worker", "planner"]) {
      const quiet = yield* boot(seed, { start: { ...WORKER, fast: true }, nested: { ...nested, agent } })
      for (const model of quiet.worker(BRIEF)) expect(model.id).toBe("gpt-sim-model-fast")
      expect(quiet.grand.length).toBeGreaterThan(0)
      for (const model of quiet.grand) expect({ agent, id: model.id }).toEqual({ agent, id: "gpt-sim-model" })
      expect(started(quiet.calls)[1]).toMatchObject({ fast: expect.stringContaining("did not ask fast") })
    }
    const asked = yield* boot(seed, { start: { ...WORKER, fast: true }, nested: { ...nested, fast: true } })
    expect(asked.grand.length).toBeGreaterThan(0)
    for (const model of asked.grand) expect(model.id).toBe("gpt-sim-model-fast")
    expect(started(asked.calls)[1]).toMatchObject({ fast: FAST_AS_ASKED })
  }),
)

seeded("an agent config naming a fast mode is not this start's ask: the worker runs standard and its line says so", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { calls, worker, parent } = yield* boot(seed, { start: WORKER }, "room", FIRST, [workerOnFast])
    expect(worker(BRIEF).length).toBeGreaterThan(0)
    for (const model of worker(BRIEF)) expect(model.id).toBe("gpt-sim-model")
    const said = "standard: simulation/gpt-sim-model-fast is a fast mode, and this start did not ask fast"
    expect(started(calls)[0]).toMatchObject({ model: "simulation/gpt-sim-model", fast: said })
    expect(parent).toContain(`orchestrate: this agent runs on simulation/gpt-sim-model: ${said}.`)
  }),
)
