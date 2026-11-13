// A latched subagent on the simulated host (sim/world.ts), each test at 20
// seeds: tests/prime-latch.test.ts's server claims under the same names, moved
// off real OpenCode (scenarios/prime-latch.ts waited out a twelve-second hold
// in real time). The orchestrate and wakes plugins are their composition roots
// on the world (sim/plugins.ts); the pool is the scenario's stand-in, a plugin
// whose `pace` holds every new agent for the first twelve seconds, six at a
// time, then admits, and whose `started` is told of each start. The model
// answers by the scenario's rules. What the TUI draws (the call's answer on
// screen, the worker's row and the dock) stays in tests/prime-latch.test.ts.
import type { CallLine } from "@dotfiles/opencode-orchestrate/call-line"
import { POOL_STATUS } from "@dotfiles/opencode-pool/status"
import { Plugin } from "@opencode/plugin/effect"
import { Array as Arr, Effect, Option, Schema } from "effect"
import * as Plugins from "../../sim/plugins.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = Seed.runner("cmd/orchestrate/orchestrate-latch.sim.test.ts")

const WORK = "/scratch/project"
/** How long the stand-in pool holds, from the first agent it is asked about. */
const HOLD_MS = 12_000
/** How far ahead each hold says it opens: half the hold, so the first opening finds it still held. */
const RETRY_MS = 6_000
/** The orchestrate plugin's fixed clock: a Wednesday afternoon, so only the pace holds. */
const PIN = "2026-11-04T15:00:00Z"

const ASK = "Check the export in a worker."
const BRIEF = "Worker brief L: check the CSV export."
const ANSWER = "The export check passed."
const LATCHED = "Latched; I will hear back."
const HEARD = "Root heard: the export check passed."
const LIST = "List the wakes."
const LISTED = "Listed."

/** The scenario's model, on the world's request text (its call ids are in it, as in the scenario's JSON). */
const model: World.Script = (request) => {
  const s = request.text
  if (request.kind === "title") return World.say("export check")
  // The worker's request carries its brief, never the parent's prompt.
  if (!s.includes(ASK) && s.includes(BRIEF)) return World.say(ANSWER)
  if (!s.includes(ASK)) return World.say("?")
  if (s.includes(ANSWER)) return World.say(HEARD)
  if (s.includes(LIST) && s.includes("call_list")) return World.say(LISTED)
  if (s.includes(LIST)) return World.call("call_list", "wake_list", {})
  if (!s.includes("call_worker")) return World.call("call_worker", "subagent", { agent: "worker", description: "Check the export", prompt: BRIEF })
  if (s.includes("The subagent is latched")) return World.say(LATCHED)
  return World.say("Not latched.")
}

/** One answer of the stand-in pool: when, and what it said (`started` for a start it was told of). */
interface PaceLine {
  readonly at: number
  readonly answer: "held" | "ok" | "started"
}

/** The scenario's pool: `pace` and `started`, its holds' `retryAt` on the orchestrate plugin's fixed clock. */
const POOL = { ...POOL_STATUS, methods: { pace: POOL_STATUS.methods.pace, started: POOL_STATUS.methods.started } }
const pool = (lines: Array<PaceLine>, now: () => number) => {
  const first: Array<number> = []
  return Plugin.define({
    id: "fixture.pool",
    effect: (ctx) =>
      ctx.rpc
        .register(POOL, {
          pace: () =>
            Effect.sync(() => {
              if (first.length === 0) first.push(now())
              const left = Math.min((first[0] ?? now()) + HOLD_MS - now(), RETRY_MS)
              if (left > 0) {
                lines.push({ at: now(), answer: "held" })
                return { ok: false, measured: true, reason: "scripted 5h window is full", retryAt: Date.parse(PIN) + left }
              }
              lines.push({ at: now(), answer: "ok" })
              return { ok: true, measured: true, reason: "scripted room" }
            }),
          started: () => Effect.sync(() => void lines.push({ at: now(), answer: "started" })).pipe(Effect.as({})),
        })
        .pipe(Effect.orDie, Effect.asVoid),
  })
}

/** The root's wake_list call's result. */
const isListing = (message: World.Message): message is Extract<World.Message, { readonly type: "tool" }> =>
  message.type === "tool" && message.callID === "call_list"

/** A call line's child session, when it names one. */
const WithChild = Schema.Struct({ child: Schema.String })
const childOf = (line: CallLine) => Option.map(Schema.decodeUnknownOption(WithChild)(line), (named) => named.child)

/** The scenario, on one world: the ask, the listing while latched, then the wait for the worker's answer. */
const boot = (seed: number) =>
  Effect.gen(function* () {
    const world = World.make({ seed, start: Date.parse(PIN), script: model })
    const calls: Array<CallLine> = []
    const paces: Array<PaceLine> = []
    yield* world.load(Plugins.orchestrate({ lines: calls }), { directory: WORK, options: { now: PIN } })
    yield* world.load(Plugins.wake(world), { directory: WORK, options: { backstop: "off" } })
    yield* world.load(pool(paces, () => world.now()), { directory: WORK })
    const root = yield* world.session(WORK)
    const said = (text: string) => () => world.messages(root).some((message) => message.type === "assistant" && message.text === text)
    yield* world.prompt(root, ASK)
    yield* world.until(said(LATCHED), 60_000)
    yield* world.prompt(root, LIST)
    yield* world.until(said(LISTED), 60_000)
    const listing = world
      .messages(root)
      .flatMap((message) => Option.toArray(Option.map(Option.liftPredicate(message, isListing), (result) => result.output)))
      .join("\n")
    yield* world.until(said(HEARD), 120_000)
    return { world, root, calls, paces, listing }
  })

seeded("wake_list shows the latch: the subagent, its child, the hold and when it opens", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { listing } = yield* boot(seed)
    expect(listing).toContain('latch · the worker subagent "Check the export" (sessionID: ses_')
    expect(listing).toContain("held by the pace: scripted 5h window is full · opens ")
  }),
)

seeded("decided again while still held it latches again; once admitted it starts in the background on its child", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { calls, paces } = yield* boot(seed)
    expect(calls.map((line) => line.kind)).toEqual(["latched", "done", "latched", "call", "done"])
    // Every line names one child: the one made when it latched.
    const child = Option.flatMap(Arr.head(calls), childOf)
    expect(Option.isSome(child)).toBe(true)
    expect(calls.map((line) => childOf(line))).toEqual(calls.map(() => child))
    expect(calls[1]).toMatchObject({ status: "latched" })
    expect(calls[3]).toMatchObject({ agent: "worker", description: "Check the export", background: true })
    expect(calls[4]).toMatchObject({ status: "running" })
    // The pace was asked three times, about six seconds apart (no busy loop), and told of the start once.
    expect(paces.map((line) => line.answer)).toEqual(["held", "held", "ok", "started"])
    const at = paces.map((line) => line.at)
    expect((at[1] ?? 0) - (at[0] ?? 0)).toBeGreaterThanOrEqual(5_000)
    expect((at[2] ?? 0) - (at[1] ?? 0)).toBeGreaterThanOrEqual(5_000)
  }),
)
