// Gamut-only handshake: use the same location-scoped catalog the composer reads.
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import { Array as Arr, Effect, Fiber, FileSystem, Option, Schedule, Schema } from "effect"

const Agent = Schema.Struct({
  id: Schema.String,
  mode: Schema.String,
  hidden: Schema.optional(Schema.Boolean),
  description: Schema.optional(Schema.String),
})
type Agent = typeof Agent.Type
const Catalog = Schema.Array(Agent)
const ModelRef = Schema.Struct({ providerID: Schema.String, modelID: Schema.String })

interface StartupContext<AgentCatalog, SelectedModel> {
  readonly options: unknown
  readonly data: { readonly location: { readonly agent: { list(): AgentCatalog } } }
  readonly ui: { readonly model: { current(): SelectedModel } }
}

const Startup = Schema.Struct({ marker: Schema.String, agent: Schema.String, description: Schema.String })

const primary = (agents: Option.Option<ReadonlyArray<Agent>>) =>
  Option.flatMap(agents, Arr.findFirst((agent) => agent.mode !== "subagent" && !agent.hidden))

/** A config-only agent stub does not have the plugin's description. */
export const ready = (agents: Option.Option<ReadonlyArray<Agent>>, hasModel: boolean, id: string, description: string) =>
  hasModel && Option.exists(primary(agents), (first) => first.id === id && first.description === description)

/** What the composer showed at one look, for the waiter's failure message. */
const seen = (catalog: unknown, model: unknown) => {
  const agents = Schema.decodeUnknownOption(Catalog)(catalog)
  const first = primary(agents)
  return {
    agents: Option.match(agents, { onNone: () => "unreadable", onSome: (list) => list.map((agent) => agent.id).join(",") }),
    default: Option.match(first, { onNone: () => "none", onSome: (agent) => agent.id }),
    description: Option.match(first, { onNone: () => "none", onSome: (agent) => agent.description ?? "none" }),
    model: Schema.is(ModelRef)(model) ? `${model.providerID}/${model.modelID}` : "none",
  }
}

/** The file beside the marker that holds the composer's last look. */
export const seenPath = (marker: string) => `${marker}.seen`

const announce = Effect.fn("Gamut.announceComposer")(function*<AgentCatalog, SelectedModel>({
  options, data, ui,
}: StartupContext<AgentCatalog, SelectedModel>) {
  const { marker, agent, description } = yield* Schema.decodeUnknownEffect(Startup)(options)
  const fs = yield* FileSystem.FileSystem
  let last = ""
  const look = Effect.gen(function* () {
    const catalog = data.location.agent.list()
    const model = ui.model.current()
    const line = JSON.stringify(seen(catalog, model))
    if (line !== last) {
      last = line
      yield* fs.writeFileString(seenPath(marker), `${line}\n`)
    }
    return ready(Schema.decodeUnknownOption(Catalog)(catalog), Schema.is(ModelRef)(model), agent, description)
  })
  yield* look.pipe(Effect.repeat({ until: (ok) => ok, schedule: Schedule.spaced("20 millis") }))
  yield* fs.writeFileString(marker, "ready\n")
})

export default {
  id: "dotfiles-gamut.startup",
  setup<AgentCatalog, SelectedModel>(context: StartupContext<AgentCatalog, SelectedModel>) {
    const fiber = Effect.runFork(
      announce(context).pipe(Effect.provide(BunFileSystem.layer), Effect.tapError((error) => Effect.logError("Gamut composer handshake failed", error))),
    )
    return () => Effect.runPromise(Fiber.interrupt(fiber))
  },
}
