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

/** A config-only agent stub does not have the plugin's description. */
export const ready = (agents: Option.Option<ReadonlyArray<Agent>>, hasModel: boolean, id: string, description: string) =>
  hasModel && Option.exists(
    Option.flatMap(agents, Arr.findFirst((agent) => agent.mode !== "subagent" && !agent.hidden)),
    (first) => first.id === id && first.description === description,
  )

const announce = Effect.fn("Gamut.announceComposer")(function*<AgentCatalog, SelectedModel>({
  options, data, ui,
}: StartupContext<AgentCatalog, SelectedModel>) {
  const { marker, agent, description } = yield* Schema.decodeUnknownEffect(Startup)(options)
  const fs = yield* FileSystem.FileSystem
  yield* Effect.sync(() =>
    ready(Schema.decodeUnknownOption(Catalog)(data.location.agent.list()), Schema.is(ModelRef)(ui.model.current()), agent, description),
  ).pipe(Effect.repeat({ until: (seen) => seen, schedule: Schedule.spaced("20 millis") }))
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
