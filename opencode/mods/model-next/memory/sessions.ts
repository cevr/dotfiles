// Sessions in memory, for the model's tests: records by id, a catalog, cache
// facts a test sets. It keeps the contract's laws (laws.ts).
import { Effect, Layer, Option } from "effect"
import { type CacheFacts, type CatalogEntry, label, type ModelRef } from "../pending.ts"
import { Sessions, type SessionRecord } from "../service.ts"

export interface Store {
  readonly records: Map<string, SessionRecord>
  /** The catalog, by `label` of a model at no variant. */
  readonly catalog: Map<string, CatalogEntry>
  readonly cache: Map<string, CacheFacts>
  /** Every switch made, in order. */
  readonly switched: Array<{ readonly sessionID: string; readonly model: ModelRef }>
}

export const store = (): Store => ({ records: new Map(), catalog: new Map(), cache: new Map(), switched: [] })

const NO_CACHE: CacheFacts = { last: Option.none(), compacted: false }

export const layer = (held: Store) =>
  Layer.succeed(
    Sessions,
    Sessions.of({
      record: (sessionID) => Effect.sync(() => Option.fromUndefinedOr(held.records.get(sessionID))),
      setMetadata: (sessionID, metadata) =>
        Effect.sync(() => {
          for (const found of Option.toArray(Option.fromUndefinedOr(held.records.get(sessionID)))) held.records.set(sessionID, { ...found, metadata: { ...metadata } })
        }),
      switchModel: (sessionID, model) =>
        Effect.sync(() => {
          for (const found of Option.toArray(Option.fromUndefinedOr(held.records.get(sessionID)))) {
            held.records.set(sessionID, { ...found, model })
            held.switched.push({ sessionID, model })
          }
        }),
      entry: (_sessionID, model) => Effect.sync(() => Option.fromUndefinedOr(held.catalog.get(label({ providerID: model.providerID, id: model.id })))),
      cache: (sessionID) => Effect.sync(() => held.cache.get(sessionID) ?? NO_CACHE),
    }),
  )
