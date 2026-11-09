// The model a new subagent runs on, read from OpenCode: the agent's own
// model, else its parent session's, else (a session that never chose one)
// the default, as the subagent tool picks it. A lookup that fails answers
// undefined, and the call runs as it would have.
import { Effect, Layer } from "effect"
import type { ModelRef } from "../pace.ts"
import { Models, type Offered } from "../service.ts"

export type { Offered }

/** OpenCode's lookups, as the plugin calls them, each in the parent session's directory. */
export interface Port {
  readonly session: (sessionID: string) => Effect.Effect<{ readonly directory: string; readonly model?: ModelRef }, unknown>
  readonly agentModel: (agentID: string, directory: string) => Effect.Effect<ModelRef | undefined, unknown>
  readonly defaultModel: (directory: string) => Effect.Effect<ModelRef | undefined, unknown>
  readonly offered: (directory: string) => Effect.Effect<ReadonlyArray<Offered>, unknown>
}

const orNone = Effect.catchCause(() => Effect.succeed(undefined))

/** Newest first: the latest release, then the greater id; a model with no release date is oldest. */
const newer = (a: Offered, b: Offered) => (b.time?.released ?? 0) - (a.time?.released ?? 0) || b.id.localeCompare(a.id)

export const layer = (port: Port) => {
  const base = Effect.fnUntraced(function* (sessionID: string, agentID: string) {
    const parent = yield* port.session(sessionID)
    const own = yield* port.agentModel(agentID, parent.directory).pipe(orNone)
    const model = own ?? parent.model ?? (yield* port.defaultModel(parent.directory))
    return { directory: parent.directory, model }
  })
  return Layer.succeed(Models, {
    base: Effect.fn("Models.base")(function* (sessionID: string, agentID: string) {
      return (yield* base(sessionID, agentID)).model
    }, orNone),
    variant: Effect.fn("Models.variant")(function* (sessionID: string, agentID: string, variant: string) {
      const { directory, model } = yield* base(sessionID, agentID)
      if (model === undefined) return undefined
      const offered = yield* port.offered(directory)
      const found = offered.find((item) => item.providerID === model.providerID && item.id === model.id)
      if (!found?.variants.some((item) => item.id === variant)) return undefined
      return `${model.providerID}/${model.id}#${variant}`
    }, orNone),
    newest: Effect.fn("Models.newest")(function* (sessionID: string, providers: ReadonlyArray<string>, family: string, variant: string) {
      const { directory } = yield* port.session(sessionID)
      const offered = yield* port.offered(directory)
      const found = offered
        .filter((item) => providers.includes(item.providerID) && item.family === family && item.status !== "deprecated")
        .toSorted(newer)[0]
      if (found === undefined) return undefined
      const at = found.variants.some((item) => item.id === variant) ? `#${variant}` : ""
      return `${found.providerID}/${found.id}${at}`
    }, orNone),
    at: Effect.fn("Models.at")(function* (sessionID: string, model: string, variant: string | undefined) {
      const slash = model.indexOf("/")
      if (slash <= 0) return undefined
      const providerID = model.slice(0, slash)
      const id = model.slice(slash + 1)
      const { directory } = yield* port.session(sessionID)
      const found = (yield* port.offered(directory)).find((item) => item.providerID === providerID && item.id === id)
      if (found === undefined) return undefined
      return variant !== undefined && found.variants.some((item) => item.id === variant) ? `${model}#${variant}` : model
    }, orNone),
  })
}
