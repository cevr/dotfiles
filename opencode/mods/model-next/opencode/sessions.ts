// Sessions as OpenCode's plugin context holds them.
//
// Where each fact comes from, in the fork:
// - record: `session.get` (packages/schema/src/session.ts `Info`): `model`,
//   the session's selection, absent until one is made, then the host's
//   default (`model.default`); `metadata`, whole. A session the host lacks
//   fails `get` (`Session.NotFoundError`), read here as none.
// - setMetadata: `session.update({ metadata })`, which replaces the record's
//   metadata whole and publishes `session.metadata.updated`.
// - switchModel: `session.switchModel` (packages/core/src/session/session.ts):
//   publishes `session.model.selected` unless the model and variant are the
//   session's already; the catalog is not checked.
// - entry: the location's `model.list` entry (its `variants`, and
//   `settings.compaction.type`, over its provider's from `provider.list`).
// - cache: idle compaction's reading of the session's data
//   (`@dotfiles/opencode-idle-compact/opencode/sessions` `facts`): the last
//   request since the last compaction, its start, whether it was cached, the
//   lifetime it got (the model's or provider's `cache.ttl`, the agent's own
//   over it, else the provider's default; unresolved when a read failed), and
//   whether a compaction of any status came after it.
import { Sessions as CacheSessions } from "@dotfiles/opencode-idle-compact/service"
import * as CacheReads from "@dotfiles/opencode-idle-compact/opencode/sessions"
import type { Plugin } from "@opencode/plugin/effect"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { SessionID } from "@opencode/schema/session-id"
import { Array as Arr, Effect, Layer, Option, Schema } from "effect"
import { type CacheFacts, type CatalogEntry, type ModelRef, readMetadata } from "../pending.ts"
import { CatalogUnreadable, Sessions, SessionUnreadable, SessionUnwritable } from "../service.ts"

const messageOf = CacheReads.messageOf

/** A failure of `session.get` that says the session is not there. */
const NotFound = Schema.Struct({ _tag: Schema.Literals(["Session.NotFoundError", "NotFoundError"]) })
const isNotFound = Schema.is(NotFound)

/** What the entry reads of the catalog: a model's or a provider's compaction kind, and a model's variants. */
const Compaction = Schema.optional(Schema.Struct({ compaction: Schema.optional(Schema.Struct({ type: Schema.optional(Schema.String) })) }))
const CatalogModel = Schema.Struct({
  providerID: Schema.String,
  id: Schema.String,
  variants: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String }))),
  settings: Compaction,
})
const CatalogProvider = Schema.Struct({ id: Schema.String, settings: Compaction })
const readModels = Schema.decodeUnknownOption(Schema.Array(CatalogModel))
const readProviders = Schema.decodeUnknownOption(Schema.Array(CatalogProvider))

/** A compaction kind as settings name it, when they name one. */
const kindOf = (settings: typeof CatalogModel.Type.settings): Option.Option<string> =>
  Option.flatMap(Option.fromUndefinedOr(settings), (set) => Option.flatMap(Option.fromUndefinedOr(set.compaction), (compaction) => Option.fromUndefinedOr(compaction.type)))

/** A reference as the host's `switchModel` takes it. */
const hostRef = (model: ModelRef) =>
  Option.match(Option.fromUndefinedOr(model.variant), {
    onNone: () => ({ providerID: Provider.ID.make(model.providerID), id: Model.ID.make(model.id) }),
    onSome: (variant) => ({ providerID: Provider.ID.make(model.providerID), id: Model.ID.make(model.id), variant: Model.VariantID.make(variant) }),
  })

export const fromContext = (ctx: Plugin.Context): Layer.Layer<Sessions> => {
  const cacheReads = CacheReads.fromContext(ctx)
  return Layer.effect(
    Sessions,
    Effect.gen(function* () {
      const cache = yield* CacheSessions
      const directoryOf = (sessionID: string) =>
        ctx.session.get({ sessionID: SessionID.make(sessionID) }).pipe(
          Effect.map((info) => info.location.directory),
          Effect.orElseSucceed(() => ctx.location.directory),
        )
      const modelOf = (selected: Option.Option<ModelRef>) =>
        Option.match(selected, {
          onSome: (model) => Effect.succeed<ModelRef>(model),
          onNone: () =>
            ctx.model.default().pipe(
              Effect.flatMap((found) => Effect.fromNullishOr(found.data)),
              Effect.map((data): ModelRef => ({ providerID: data.providerID, id: data.id })),
            ),
        })
      return Sessions.of({
        record: (sessionID) =>
          ctx.session.get({ sessionID: SessionID.make(sessionID) }).pipe(
            Effect.flatMap((info) => modelOf(Option.fromUndefinedOr(info.model)).pipe(Effect.map((model) => Option.some({ model, metadata: Option.getOrElse(readMetadata(info.metadata), () => ({})) })))),
            Effect.catchIf(isNotFound, () => Effect.succeedNone),
            Effect.mapError((cause) => new SessionUnreadable({ sessionID, message: messageOf(cause) })),
          ),
        setMetadata: (sessionID, metadata) =>
          ctx.session.update({ sessionID: SessionID.make(sessionID), metadata: { ...metadata } }).pipe(
            Effect.asVoid,
            Effect.mapError((cause) => new SessionUnwritable({ sessionID, message: messageOf(cause) })),
          ),
        switchModel: (sessionID, model) =>
          ctx.session.switchModel({ sessionID: SessionID.make(sessionID), model: hostRef(model) }).pipe(
            Effect.asVoid,
            Effect.mapError((cause) => new SessionUnwritable({ sessionID, message: messageOf(cause) })),
          ),
        entry: (sessionID, model) =>
          Effect.gen(function* () {
            const directory = yield* directoryOf(sessionID)
            const [models, providers] = yield* Effect.all([ctx.model.list({ location: { directory } }), ctx.provider.list({ location: { directory } })])
            const listed = Option.getOrElse(readModels(models.data), () => [])
            const provider = Arr.findFirst(Option.getOrElse(readProviders(providers.data), () => []), (entry) => entry.id === model.providerID)
            return Option.map(
              Arr.findFirst(listed, (entry) => entry.providerID === model.providerID && entry.id === model.id),
              (found): CatalogEntry => ({
                variants: Arr.map(Option.getOrElse(Option.fromUndefinedOr(found.variants), () => []), (variant) => variant.id),
                native: Option.contains(
                  Option.orElse(kindOf(found.settings), () => Option.flatMap(provider, (entry) => kindOf(entry.settings))),
                  "native",
                ),
              }),
            )
          }).pipe(Effect.mapError((cause) => new CatalogUnreadable({ message: messageOf(cause) }))),
        cache: (sessionID) =>
          cache.facts(sessionID).pipe(
            Effect.map(
              (facts): CacheFacts => ({
                compacted: facts.compacted,
                last: Option.map(facts.last, (last) => ({ startedAt: last.startedAt, cached: last.cached, ttl: last.ttl, unresolved: Option.fromUndefinedOr(last.unresolved) })),
              }),
            ),
            Effect.mapError((error) => new SessionUnreadable({ sessionID, message: error.message })),
          ),
      })
    }),
  ).pipe(Layer.provide(cacheReads))
}
