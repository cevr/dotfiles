// Nothing-is-hard reaches the agents (features/nothing-is-hard-rule.md, its World suite). The real orchestrate plugin
// on the simulated host (sim/world.ts), loaded with its `skill` option at this checkout's orchestrate skill: a root
// session on the default agent is OFFERED `subagent` and `principles`, asks `principles` to list and to search
// "effort", then starts one child of each role. Each child's model request, as the scripted model receives it,
// carries its role's generated prompt (mods/orchestrate/agents.json), the Ending-a-step sentence for that role and
// the principle's name; both lookups answer principle-nothing-is-hard.
import { definitions } from "@dotfiles/opencode-orchestrate/role"
import { fileURLToPath } from "bun"
import { Array as Arr, Effect, Option } from "effect"
import * as Plugins from "../../sim/plugins.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = Seed.runner("cmd/orchestrate/nothing-is-hard.sim.test.ts")

const WORK = "/scratch/nothing-is-hard"
/** A Wednesday afternoon: no Sabbath rest refuses the calls. */
const PIN = "2026-11-04T15:00:00Z"
const ROOT_TASK = "start each role"
const NAME = "principle-nothing-is-hard"
/** Each role's own required-work line in its end-of-step rows (skills/orchestrate/scripts/ending.ts `REQUIRED`). */
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
