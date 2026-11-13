// A held subagent falling back to Codex on the simulated host (sim/world.ts),
// each test at 20 seeds: tests/prime-fallback.test.ts's server claims under
// the same names, moved off real OpenCode (scenarios/prime-fallback.ts). The
// orchestrate and wakes plugins are their composition roots on the world
// (sim/plugins.ts); the pool is the scenario's stand-in, holding every new
// agent on the first model's provider; the Codex admission is the plugin's
// memory double, admitting and keeping what it was asked; the catalog offers
// the scenario's first model and its two sols. The model answers by the
// scenario's rules. What the TUI draws (the planner's row) stays in
// tests/prime-fallback.test.ts.
import type { CallLine } from "@dotfiles/opencode-orchestrate/call-line"
import { paceOfReply, parseAdmission } from "@dotfiles/opencode-orchestrate/pace"
import { POOL_STATUS } from "@dotfiles/opencode-pool/status"
import { Plugin } from "@opencode/plugin/effect"
import { Effect, Option, Schema } from "effect"
import * as Plugins from "../../sim/plugins.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = Seed.runner("cmd/orchestrate/orchestrate-fallback.sim.test.ts")

const WORK = "/scratch/project"
/** The orchestrate plugin's fixed clock: a Wednesday afternoon, so only the pace holds. */
const PIN = "2026-11-04T15:00:00Z"

const ASK = "Check the export in a worker."
const BRIEF = "Worker brief F: check the CSV export."
const ANSWER = "The export check passed."
const HEARD = "Root heard: the export check passed."
const NOTE = "orchestrate: this agent runs on codex/gpt-6.1-sol#high, the Codex fallback (simulation/gpt-sim-model#medium held: scripted 5h window is full)."

/** The scenario's first model, as opencode-drive's simulation provider offers it. */
const FIRST: World.CatalogModel = {
  providerID: "simulation",
  id: "gpt-sim-model",
  modelID: "gpt-sim-model",
  limit: { context: 128_000 },
  cost: [],
  variants: [{ id: "low" }, { id: "medium" }, { id: "high" }],
}
/** A stand-in Codex sol, as the scenario's `codex` provider configures it. */
const sol = (id: string, releaseDate: string): World.CatalogModel => ({
  providerID: "codex",
  id,
  modelID: id,
  limit: { context: 128_000 },
  cost: [],
  variants: [{ id: "high" }],
  family: "gpt-sol",
  time: { released: Date.parse(releaseDate) },
})

/** One request as the test reads it back: its kind, the agent's, its model, its text. */
interface Seen {
  readonly kind: World.Kind
  readonly agent: string
  readonly model: World.ModelRef
  readonly text: string
}

/** The scenario's model, on the world's request text (its call ids are in it, as in the scenario's JSON). */
const model =
  (seen: Array<Seen>): World.Script =>
  (request) => {
    seen.push({ kind: request.kind, agent: request.agent, model: request.model, text: request.text })
    const s = request.text
    if (request.kind === "title") return World.say("export check")
    // The worker's request carries its brief, never the parent's prompt.
    if (!s.includes(ASK) && s.includes(BRIEF)) return World.say(ANSWER)
    if (!s.includes(ASK)) return World.say("?")
    if (s.includes(ANSWER)) return World.say(HEARD)
    if (!s.includes("call_worker")) return World.call("call_worker", "subagent", { agent: "planner", description: "Check the export", prompt: BRIEF })
    return World.say("?")
  }

/** One answer of the stand-in pool, or a start it was told of: on which provider. */
interface PaceLine {
  readonly providerID: string
  readonly answer: "held" | "ok" | "started"
}

const ProviderInput = Schema.Struct({ providerID: Schema.String })
/** The scenario's pool: it holds every new agent, for an hour on the plugin's fixed clock, and logs each answer and start. */
const POOL = { ...POOL_STATUS, methods: { pace: POOL_STATUS.methods.pace, started: POOL_STATUS.methods.started } }
const pool = (lines: Array<PaceLine>) =>
  Plugin.define({
    id: "fixture.pool",
    effect: (ctx) =>
      ctx.rpc
        .register(POOL, {
          pace: (input) =>
            Effect.sync(() => {
              lines.push({ providerID: Schema.decodeUnknownSync(ProviderInput)(input).providerID, answer: "held" })
              return { ok: false, measured: true, reason: "scripted 5h window is full", retryAt: Date.parse(PIN) + 3_600_000 }
            }),
          started: (input) =>
            Effect.sync(() => void lines.push({ providerID: Schema.decodeUnknownSync(ProviderInput)(input).providerID, answer: "started" })).pipe(Effect.as({})),
        })
        .pipe(Effect.orDie, Effect.asVoid),
  })

/** The scenario on one world: the ask, then the wait for the parent to hear the planner's answer. */
const boot = (seed: number) =>
  Effect.gen(function* () {
    const seen: Array<Seen> = []
    const calls: Array<CallLine> = []
    const paces: Array<PaceLine> = []
    const admits: Array<readonly [string, string]> = []
    const world = World.make({
      seed,
      start: Date.parse(PIN),
      script: model(seen),
      models: [FIRST, sol("gpt-6-sol", "2026-06-01"), sol("gpt-6.1-sol", "2026-09-29")],
      model: { providerID: "simulation", id: "gpt-sim-model" },
    })
    // The stand-in admission script: it admits, and keeps the model and role it was asked about.
    const codex = (asked: string, role: string) => {
      admits.push([asked, role])
      return Option.fromUndefinedOr(paceOfReply(parseAdmission(0, "admit: scripted room\n")))
    }
    const options = { now: PIN, codex: { providers: ["codex"], script: "/nonexistent/loop-probe-x/admit.ts" } }
    yield* world.load(Plugins.orchestrate({ lines: calls, codex }), { directory: WORK, options })
    yield* world.load(Plugins.wake(world), { directory: WORK, options: { backstop: "off" } })
    yield* world.load(pool(paces), { directory: WORK })
    const root = yield* world.session(WORK)
    yield* world.prompt(root, ASK)
    yield* world.until(() => world.messages(root).some((message) => message.type === "assistant" && message.text === HEARD), 120_000)
    const worker = seen.filter((request) => request.agent === "planner")
    // The parent's last turn: its title request also carries the ask, and the host may send it after any turn
    // (SIM_SEED=121414084 sent it last).
    const parent = seen.filter((request) => request.kind === "primary" && request.text.includes(ASK)).at(-1)
    return { calls, paces, admits, worker, parent: Option.getOrElse(Option.fromUndefinedOr(parent?.text), () => "") }
  })

seeded("the pool holds the first model, and the admission script is asked about the newest sol for the role", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { paces, admits } = yield* boot(seed)
    expect(paces.map((line) => `${line.answer} ${line.providerID}`)).toEqual(["held simulation", "started codex"])
    // The admission is asked with the model and the role, as the script's `--model gpt-6.1-sol --role planner`.
    expect(admits).toEqual([["gpt-6.1-sol", "planner"]])
  }),
)

seeded("it starts at once on sol, never latched, and the call log says why", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { calls } = yield* boot(seed)
    expect(calls.map((line) => line.kind)).toEqual(["call", "done"])
    expect(calls[0]).toMatchObject({
      agent: "planner",
      model: "codex/gpt-6.1-sol#high",
      fallback: "simulation/gpt-sim-model#medium held: scripted 5h window is full",
    })
    // OpenCode runs every subagent in the background: the call ends as the worker starts.
    expect(calls[1]).toMatchObject({ status: "running" })
  }),
)

seeded("the worker's request goes to sol", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { worker } = yield* boot(seed)
    expect(worker.map((request) => request.model)).toContainEqual({ providerID: "codex", id: "gpt-6.1-sol", variant: "high" })
  }),
)

seeded("the parent reads where it ran and why, first in the call's result, then the answer, and its row shows sol", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { parent } = yield* boot(seed)
    // The call's result opens with the note; the planner's answer comes back as its completion notice.
    expect(parent).toContain(`${NOTE}\nThe subagent is working in the background`)
    expect(parent).toContain(`state="completed" description="Check the export">\nThe export check passed.`)
    // The parent's last request is the one it answered with what it heard (the row is the TUI's: tests/prime-fallback.test.ts).
    expect(parent.indexOf(NOTE)).toBeLessThan(parent.indexOf(`state="completed" description="Check the export">`))
  }),
)
