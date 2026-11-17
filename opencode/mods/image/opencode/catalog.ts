// The Catalog over OpenCode's model list (`ctx.model.list` in a directory,
// which the plugin hands in). Each model reads by the fields the subscription's
// model rule needs; one that does not read is left out, and a list that cannot
// be read is none, so the request falls back to FALLBACK_MODEL.
import { Array as Arr, Effect, Layer, Schema } from "effect"
import type { Listed } from "../models.ts"
import { Catalog } from "../service.ts"

/** OpenCode's model list in a directory. */
export type List = (directory: string) => Effect.Effect<ReadonlyArray<unknown>, unknown>

const Model = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  family: Schema.optionalKey(Schema.String),
  status: Schema.String,
  time: Schema.Struct({ released: Schema.Finite }),
})

const decode = Schema.decodeUnknownOption(Model)

const listedOf = (model: typeof Model.Type): Listed => ({
    providerID: model.providerID,
    modelID: model.modelID,
    family: model.family ?? "",
    deprecated: model.status === "deprecated",
    released: model.time.released,
  })

export const layer = (list: List) =>
  Layer.succeed(
    Catalog,
    Catalog.of({
      models: (directory) =>
        Effect.suspend(() => list(directory)).pipe(
          Effect.map((models) => Arr.map(Arr.getSomes(Arr.map(models, (model) => decode(model))), listedOf)),
          Effect.orElseSucceed((): ReadonlyArray<Listed> => []),
        ),
    }),
  )
