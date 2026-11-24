// The agent's way in, on the simulated host at 20 seeds: the model calls the
// `model_next` tool in a turn; the switch is queued for its own session, as
// `/model-next` queues one, and its answer says so in words. A queue with no
// model is an error the agent reads; status then cancel answer in words too.
import { Effect, Option } from "effect"
import { KEY } from "@dotfiles/opencode-model-next/pending"
import { NAME } from "@dotfiles/opencode-model-next/tool"
import * as Plugins from "../../sim/plugins.ts"
import { simulationRunner } from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = simulationRunner("cmd/model-next/model-next-tool.sim.test.ts")

const WORK = "/scratch/work"
const OLD = { providerID: "sim", id: "old" } as const
const MODELS: ReadonlyArray<World.CatalogModel> = [
  { providerID: "sim", id: "old", modelID: "old", limit: { context: 1_000_000 }, cost: [], settings: { cache: { ttl: "5m" } } },
  { providerID: "other", id: "new", modelID: "new", limit: { context: 1_000_000 }, cost: [], settings: { cache: { ttl: "5m" } } },
]

/** A model that calls the tool once per prompt, `<action> [model]`, then answers. */
const script: World.Script = (request) => {
  if (request.kind === "title") return World.say("Run")
  const lines = request.text.split("\n")
  const calls = lines.filter((line) => line.startsWith("tool ")).length
  const prompts = lines.filter((line) => line.startsWith("user: "))
  const users = prompts.length
  const [action = "status", model] = (prompts.at(-1) ?? "").slice("user: ".length).split(" ")
  if (calls < users) return World.call(`call_${users}`, NAME, { action, ...Option.match(Option.fromUndefinedOr(model), { onNone: () => ({}), onSome: (named) => ({ model: named }) }) })
  return World.say("Done.")
}

const toolOutputs = (world: World.World, session: string) =>
  world
    .messages(session)
    .filter((message): message is Extract<World.Message, { readonly type: "tool" }> => message.type === "tool" && message.name === NAME)
    .map((message) => message.output)

seeded("an agent queues, reads and cancels a switch for its own session with the model_next tool", ({ seed, expect }) =>
  Effect.gen(function* () {
    const world = World.make({ seed, script, models: MODELS, model: OLD })
    const session = yield* world.session(WORK)
    yield* world.load(Plugins.modelNext, { directory: WORK })
    const idle = (count: number) => world.until(() => world.sessions.get(session)?.running !== true && toolOutputs(world, session).length >= count, 60_000)

    yield* world.prompt(session, "queue other/new")
    yield* idle(1)
    expect(world.sessions.get(session)?.metadata?.[KEY]).toMatchObject({ sessionID: session, model: { providerID: "other", id: "new" } })
    expect(toolOutputs(world, session)[0]).toBe("sim/old → other/new queued: it applies after the next compaction, or at the next turn once the cache has expired.")

    yield* world.prompt(session, "status")
    yield* idle(2)
    expect(toolOutputs(world, session)[1]).toBe("sim/old → other/new queued.")

    yield* world.prompt(session, "queue")
    yield* idle(3)
    expect(toolOutputs(world, session)[2]).toContain("queue needs model")

    yield* world.prompt(session, "cancel")
    yield* idle(4)
    expect(toolOutputs(world, session)[3]).toBe("The queued switch is cancelled.")
    expect(Option.fromNullishOr(world.sessions.get(session)?.metadata?.[KEY])).toEqual(Option.none())
  }),
)
