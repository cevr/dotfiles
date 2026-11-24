// Nothing-is-hard reaches the agents (features/nothing-is-hard-rule.md, its World suite). The real orchestrate plugin
// on the simulated host (sim/world.ts), loaded with its `skill` option at this checkout's orchestrate skill: a root
// session on the default agent is OFFERED `subagent` and `principles`, asks `principles` to list and to search
// "effort", then starts one child of each role. Each child's model request, as the scripted model receives it,
// carries its role's generated prompt (mods/orchestrate/agents.json), the Ending-a-step sentence for that role and
// the principle's name; both lookups answer principle-nothing-is-hard. NIH8: a child of each role and the lean
// worker, its system read back from the model request and decoded (mods/orchestrate/round-policy.ts) equal to its
// role's policy; a dropped artifact, a dropped refusal form and a swapped role block are each named by the decoder.
import { definitions } from "@dotfiles/opencode-orchestrate/role"
import { block, delivered, policyFaults, project } from "@dotfiles/opencode-orchestrate/round-policy"
import { fileURLToPath } from "bun"
import { Array as Arr, Effect, Option } from "effect"
import * as Plugins from "../../sim/plugins.ts"
import { simulationRunner } from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = simulationRunner("cmd/orchestrate/nothing-is-hard.sim.test.ts")

const WORK = "/scratch/nothing-is-hard"
/** A Wednesday afternoon: no Sabbath rest refuses the calls. */
const PIN = "2026-11-04T15:00:00Z"
const ROOT_TASK = "start each role"
const NAME = "principle-nothing-is-hard"
/** Each role's own required-work line in its round-policy block (mods/orchestrate/round-policy.ts `REQUIRED`). */
const ENDING = {
  planner: "Your required work: every section of the spec filled, and its acceptance check runnable and recorded red.",
  implementor: "Your required work: every item of the spec, built, gated and requested.",
  verifier: "Your required work: every check of step 1 ran to a result that settles pass or fail, for every unit;",
} as const
const ROLES = ["planner", "implementor", "verifier"] as const

/** The root's calls, in order: the two lookups, then a child of each role. */
const STEPS: ReadonlyArray<readonly [string, Record<string, string>]> = [
  ["principles", { action: "list" }],
  ["principles", { action: "search", query: "effort" }],
  ...ROLES.map((role) => ["subagent", { agent: role, description: `${role} delivery`, prompt: `${role} task` }] as const),
]

interface Seen {
  readonly sessionID: string
  readonly system: string
  readonly tools: ReadonlyArray<string>
  readonly text: string
}

type ToolMessage = Extract<World.Message, { readonly type: "tool" }>

const boot = (seed: number) =>
  Effect.gen(function* () {
    const skills = fileURLToPath(new URL("../../../skills", import.meta.url))
    const seen: Array<Seen> = []
    const asked = new Map<string, number>()
    // The model: the root makes its next call while it is offered both tools, each child answers once.
    const script: World.Script = (request) => {
      if (request.kind !== "primary") return World.say("nothing-is-hard")
      seen.push({ sessionID: request.sessionID, system: request.system, tools: request.tools, text: request.text })
      if (!request.text.includes(`user: ${ROOT_TASK}`)) return World.say("child: done")
      if (!request.tools.includes("subagent") || !request.tools.includes("principles")) return World.say("root: not offered")
      const step = Option.getOrElse(Option.fromUndefinedOr(asked.get(request.sessionID)), () => 0)
      return Option.match(Option.fromUndefinedOr(STEPS[step]), {
        onNone: () => World.say("root: done"),
        onSome: ([tool, input]) => {
          asked.set(request.sessionID, step + 1)
          return World.call(`call_${step}`, tool, { ...input })
        },
      })
    }
    const world = World.make({ seed, start: Date.parse(PIN), script })
    yield* world.load(Plugins.orchestrate(), { directory: WORK, options: { now: PIN, skill: `${skills}/orchestrate` } })
    const rested = () => [...world.sessions.values()].every((session) => !session.running && session.inbox.length === 0)
    const root = yield* world.session(WORK)
    yield* world.prompt(root, ROOT_TASK)
    yield* world.until(rested, 120_000)
    return { world, seen, root }
  })

seeded("the root is offered subagent and principles; each role's child runs on its Ending sentence and the principle", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { world, seen, root } = yield* boot(seed)
    // Offered, on the default agent's first request: not only callable.
    const first = seen.find((request) => request.sessionID === root)
    expect(first?.tools).toEqual(expect.arrayContaining(["subagent", "principles"]))
    // Both lookups answer the principle.
    const answers = world.messages(root).filter((message): message is ToolMessage => message.type === "tool")
    const lookups = answers.slice(0, 2)
    expect(lookups.map((tool) => [tool.error, tool.output.split("\n").some((line) => line.startsWith(`${NAME}:`))])).toEqual([
      [false, true],
      [false, true],
    ])
    // One child per role, each request on its role's generated prompt.
    const children = [...world.sessions.values()].filter((session) => session.parentID._tag === "Some" && session.parentID.value === root)
    expect(children.map((child) => child.agent).toSorted()).toEqual(["implementor", "planner", "verifier"])
    for (const role of ROLES) {
      // The child's first request, as the scripted model received it; an empty system when none reached it.
      const system = Option.getOrElse(
        Option.map(
          Arr.findFirst(seen, (one) => children.some((session) => session.agent === role && session.id === one.sessionID)),
          (one) => one.system,
        ),
        () => "",
      )
      expect([role, system.includes(definitions[role].system), system.includes(ENDING[role]), system.includes(NAME)]).toEqual([role, true, true, true])
    }
  }),
)

/** NIH8's roles: the three named roles and the lean worker, each a child the owner opens on that agent. */
const DELIVERED = [...ROLES, "worker"] as const

/** The system each child's first model request carries, as the scripted model receives it: the delivery NIH8 decodes. */
const delivery = (seed: number) =>
  Effect.gen(function* () {
    const skills = fileURLToPath(new URL("../../../skills", import.meta.url))
    const seen: Array<{ readonly sessionID: string; readonly system: string }> = []
    const script: World.Script = (request) => {
      if (request.kind === "primary") seen.push({ sessionID: request.sessionID, system: request.system })
      return World.say("done")
    }
    const world = World.make({ seed, start: Date.parse(PIN), script })
    yield* world.load(Plugins.orchestrate(), { directory: WORK, options: { now: PIN, skill: `${skills}/orchestrate` } })
    const root = yield* world.session(WORK)
    const children = yield* Effect.forEach(DELIVERED, (role) => Effect.map(world.session(WORK, { parentID: root, agent: role }), (id) => [role, id] as const))
    yield* Effect.forEach(children, ([, id]) => world.prompt(id, "Report the synthetic check."))
    yield* world.until(() => children.every(([, id]) => seen.some((one) => one.sessionID === id)), 120_000)
    return children.map(([role, id]) => [role, Arr.findFirst(seen, (one) => one.sessionID === id).pipe(Option.map((one) => one.system), Option.getOrElse(() => ""))] as const)
  })

seeded("NIH8: each role's model request carries its round policy, decoded equal to the source; a lost artifact, form or role is caught", ({ seed, expect }) =>
  Effect.gen(function* () {
    const systems = yield* delivery(seed)
    const of = (role: (typeof DELIVERED)[number]) => Option.getOrElse(Option.map(Arr.findFirst(systems, ([one]) => one === role), ([, system]) => system), () => "")
    // Positive control: each delivered prompt's one block decodes to exactly its role's policy (every part, then the bytes).
    for (const role of DELIVERED) expect([role, policyFaults(role, of(role)), delivered(role, of(role))]).toEqual([role, [], { ok: true, value: project(role) }])
    // The implementor's blocked verdict loses state.md: the decoded F2 artifacts differ, named.
    const implementor = of("implementor")
    const noState = implementor.replace("`<unit dir>/state.md` current (even with no commit since) and ", "")
    expect([noState !== implementor, policyFaults("implementor", noState).some((line) => line.startsWith("implementor: verdict blocked: source "))]).toEqual([true, true])
    // A refusal that named a form loses its exact form field: the decoded stop evidence differs, named.
    const noForm = implementor.replace(/\n\| a refusal named an accepted form \| `refused\.form` \|[^\n]*/, "")
    expect([noForm !== implementor, policyFaults("implementor", noForm).some((line) => line.startsWith("implementor: stop refusalForm: source "))]).toEqual([true, true])
    // Another role's block delivered in its place.
    const swapped = of("planner").replace(block("planner"), () => block("implementor"))
    expect(policyFaults("planner", swapped)).toContain("planner: role: source planner, shown implementor")
  }),
)
