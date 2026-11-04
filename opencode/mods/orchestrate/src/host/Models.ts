// The model a new subagent runs on, read from OpenCode: the agent's own
// model, else its parent session's, else (a session that never chose one)
// the default, as the subagent tool picks it. A lookup that fails answers
// undefined, and the call runs as it would have.
import { Effect, Layer } from "effect"
import type { ModelRef } from "../domain/Pace.ts"
import { Models } from "../domain/ToolCall/Models.external.ts"

/** A model OpenCode offers, with the variants it runs at. */
export interface Offered extends ModelRef {
  readonly variants: ReadonlyArray<{ readonly id: string }>
}

/** OpenCode's lookups, as the plugin calls them, each in the parent session's directory. */
export interface Port {
  readonly session: (sessionID: string) => Effect.Effect<{ readonly directory: string; readonly model?: ModelRef }, unknown>
  readonly agentModel: (agentID: string, directory: string) => Effect.Effect<ModelRef | undefined, unknown>
  readonly defaultModel: (directory: string) => Effect.Effect<ModelRef | undefined, unknown>
  readonly offered: (directory: string) => Effect.Effect<ReadonlyArray<Offered>, unknown>
}

const orNone = Effect.catchCause(() => Effect.succeed(undefined))

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
  })
}

/**
 * One model for every agent, offered at `variants`; none when absent. A
 * stand-in for OpenCode's lookups with the same answers the live layer gives.
 */
export const layerTest = (model: ModelRef | undefined, variants: ReadonlyArray<string> = []) =>
  Layer.succeed(Models, {
    base: () => Effect.succeed(model),
    variant: (_sessionID: string, _agentID: string, variant: string) =>
      Effect.succeed(model !== undefined && variants.includes(variant) ? `${model.providerID}/${model.id}#${variant}` : undefined),
  })
