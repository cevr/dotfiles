// A generated property over faults, on the simulated host at 20 seeds: the
// orchestrate plugin with the pool's pace (a fixture plugin's, as the real
// run's) and no wakes, the seed choosing up to 16 commands: a root's subagent
// call (untyped, `orchestrate-reviewer`, `planner` or `worker`), the pool's
// answer (open, held, held softly: its spend-evenly target only), a fault on
// the pool's `pace` (its handler dies, or never answers), the clock moving on,
// and a restart of every plugin.
//
// After each call: the root's turn ends, a fault or not (the plugin's own
// timeout on the pace, never the host's); the call starts one child, on the
// role its asked agent maps to, exactly when the pace admits it (open, failed
// open on a fault, or a soft hold on an agent that never runs on Codex), and
// otherwise answers with the pace's hold and when it opens, and starts none.
import { POOL_STATUS } from "@dotfiles/opencode-pool/status"
import { Plugin } from "@opencode/plugin/effect"
import { Array as Arr, Effect, Option, Schema } from "effect"
import * as Plugins from "../../sim/plugins.ts"
import { below, generator } from "../../sim/runtime.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = Seed.runner("cmd/orchestrate/orchestrate-faults.sim.test.ts")

const WORK = "/scratch/work"
/** Wednesday 4 November 2026, 10:00 in Knowlton: 16 commands at most an hour apart stay clear of the Sabbath. */
const WEDNESDAY = "2026-11-04T15:00:00Z"
const HOUR = 3_600_000
/** The root's task: `call <subagent input as JSON>`. */
const CALL = "call "

/** The agents a root asks for, and the role each runs as. */
const ASKED = [
  { asked: Option.none<string>(), role: "worker" },
  { asked: Option.some("orchestrate-reviewer"), role: "verifier" },
  { asked: Option.some("planner"), role: "planner" },
  { asked: Option.some("worker"), role: "worker" },
] as const
/** The roles that run on Codex too: a soft hold (the spend-evenly target alone) holds them. */
const ON_CODEX = new Set(["planner", "verifier"])

type Answer = "open" | "held" | "soft"
type Fault = World.RpcFault | "none"

type Command =
  | { readonly type: "call"; readonly asked: number }
  | { readonly type: "answer"; readonly answer: Answer }
  | { readonly type: "fault"; readonly fault: Fault }
  | { readonly type: "advance"; readonly ms: number }
  | { readonly type: "restart" }

const ANSWERS: ReadonlyArray<Answer> = ["open", "held", "soft"]
const FAULTS: ReadonlyArray<Fault> = ["none", "die", "hang"]

const commandOf = (pick: number, random: ReturnType<typeof generator>): Command => {
  if (pick < 6) return { type: "call", asked: below(random, ASKED.length) }
  if (pick < 8) return { type: "answer", answer: ANSWERS[below(random, ANSWERS.length)] ?? "open" }
  if (pick < 10) return { type: "fault", fault: FAULTS[below(random, FAULTS.length)] ?? "none" }
  if (pick < 11) return { type: "advance", ms: 1 + below(random, HOUR) }
  return { type: "restart" }
}

/** Up to 16 commands, the seed choosing each; the last is a call. */
const commandsOf = (seed: number): ReadonlyArray<Command> => {
  const random = generator(`orchestrate-faults:${seed}`)
  const count = 4 + below(random, 13)
  return [...Array.from({ length: count - 1 }, () => commandOf(below(random, 12), random)), { type: "call", asked: below(random, ASKED.length) }]
}

const SubagentInput = Schema.fromJsonString(Schema.Struct({ agent: Schema.optional(Schema.String), description: Schema.String, prompt: Schema.String }))

/** The root's model: its `call` task makes that one subagent call, then closes; a child answers its task. */
const model: World.Script = (request) => {
  if (request.kind === "title") return World.say("Faults run")
  const task = request.text.split("\n").find((line) => line.startsWith(`user: ${CALL}`))
  const called = request.text.split("\n").some((line) => line.startsWith("tool "))
  const input = Option.flatMap(Option.fromUndefinedOr(task), (line) => Schema.decodeUnknownOption(SubagentInput)(line.slice(`user: ${CALL}`.length)))
  return Option.match(input, {
    onNone: () => World.say("child: done"),
    onSome: (call) => {
      if (called || !request.tools.includes("subagent")) return World.say("root: the call answered")
      return World.call("call_faults", "subagent", { ...call })
    },
  })
}

/** The fixture's pool: only its `pace`, as the real run's fake pace plugin registers it. */
const PACE_ONLY = { ...POOL_STATUS, methods: { pace: POOL_STATUS.methods.pace } }

/** The pool's `pace`, answering as `state.answer` says now: it opens an hour on. */
const pace = (state: { answer: Answer }, now: () => number) =>
  Plugin.define({
    id: "fixture.pace",
    effect: (ctx) =>
      ctx.rpc
        .register(PACE_ONLY, {
          pace: () =>
            Effect.sync(() => ({
              ok: state.answer === "open",
              measured: true,
              reason: `scripted pace ${state.answer}`,
              retryAt: now() + HOUR,
              soft: state.answer === "soft",
            })),
        })
        .pipe(Effect.orDie, Effect.asVoid),
  })

/** What the commands set so far: the pool's answer and the fault on its `pace`. */
interface RunState {
  answer: Answer
  fault: Fault
}

/** A message that is the root's subagent call's result. */
const isCallResult = (message: World.Message): message is Extract<World.Message, { readonly type: "tool" }> =>
  message.type === "tool" && message.callID === "call_faults"

const run = (seed: number, check: (outcome: { readonly admitted: boolean; readonly role: string; readonly children: ReadonlyArray<string>; readonly output: string; readonly rested: boolean }) => void) =>
  Effect.gen(function* () {
    const world = World.make({ seed, start: Date.parse(WEDNESDAY), script: model })
    const state: RunState = { answer: "open", fault: "none" }
    yield* world.load(Plugins.orchestrate(), { directory: WORK, options: { now: WEDNESDAY } })
    yield* world.load(pace(state, () => world.now()), { directory: WORK })
    const rested = () => [...world.sessions.values()].every((session) => !session.running && session.inbox.length === 0)
    for (const command of commandsOf(seed)) {
      if (command.type === "answer") state.answer = command.answer
      if (command.type === "fault") {
        state.fault = command.fault
        yield* world.rpcFault(POOL_STATUS.id, "pace", command.fault)
      }
      if (command.type === "advance") yield* world.advance(command.ms)
      if (command.type === "restart") yield* world.restart
      if (command.type === "call") {
        const { asked, role } = ASKED[command.asked] ?? ASKED[0]
        const input = { description: "Faults task", prompt: "faults: the child task", ...Option.match(asked, { onNone: () => ({}), onSome: (agent) => ({ agent }) }) }
        const root = yield* world.session(WORK)
        yield* world.prompt(root, `${CALL}${Schema.encodeSync(SubagentInput)(input)}`)
        // The pace's own timeout is 8 s; a minute is room for the call, the child's turn and the root's close.
        yield* world.until(rested, 60_000).pipe(Effect.ignore)
        const admitted = state.fault !== "none" || state.answer === "open" || (state.answer === "soft" && !ON_CODEX.has(role))
        const children = world.sessions
          .values()
          .filter((session) => Option.contains(session.parentID, root))
          .map((session) => session.agent)
          .toArray()
        const output = world
          .messages(root)
          .flatMap((message) => Option.toArray(Option.map(Option.liftPredicate(message, isCallResult), (result) => result.output)))
          .join("\n")
        check({ admitted, role, children, output, rested: rested() })
      }
    }
  })

seeded("a call ends its turn under any pace fault, and starts its role's one child exactly when the pace admits it", ({ seed, expect }) =>
  run(seed, ({ admitted, role, children, output, rested }) => {
    expect(rested).toBe(true)
    expect({ admitted, children }).toEqual({ admitted, children: Arr.filter([role], () => admitted) })
    if (!admitted) expect(output).toContain("pace holds this agent")
    if (!admitted) expect(output).toContain("It opens about")
  }),
)
