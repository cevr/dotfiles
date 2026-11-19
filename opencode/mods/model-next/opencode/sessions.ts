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
import { Effect, Layer, Option, Schema } from "effect"
import type { CacheFacts, CatalogEntry, ModelRef } from "../pending.ts"
import { CatalogUnreadable, Sessions, SessionUnreadable, SessionUnwritable } from "../service.ts"

type SessionID = Parameters<Plugin.Context["session"]["get"]>[0]["sessionID"]
type SwitchInput = Parameters<Plugin.Context["session"]["switchModel"]>[0]
type UpdateInput = Parameters<Plugin.Context["session"]["update"]>[0]

const messageOf = CacheReads.messageOf

/** A failure of `session.get` that says the session is not there. */
const NotFound = Schema.Struct({ _tag: Schema.Literals(["Session.NotFoundError", "NotFoundError"]) })
const isNotFound = Schema.is(NotFound)

/** What the entry reads of a catalog model: its variants and its compaction kind. */
interface CatalogModel {
  readonly providerID: string
  readonly id: string
  readonly variants?: ReadonlyArray<{ readonly id: string }>
  readonly settings?: { readonly compaction?: { readonly type?: string } }
}
interface CatalogProvider {
  readonly id: string
  readonly settings?: { readonly compaction?: { readonly type?: string } }
}

export const fromContext = (ctx: Plugin.Context): Layer.Layer<Sessions> => {
  const cacheReads = CacheReads.fromContext(ctx)
  return Layer.effect(
    Sessions,
    Effect.gen(function* () {
      const cache = yield* CacheSessions
      const directoryOf = (sessionID: string) =>
        ctx.session.get({ sessionID: sessionID as SessionID }).pipe(
          Effect.map((info) => info.location.directory),
          Effect.orElseSucceed(() => ctx.location.directory),
        )
      return Sessions.of({
        record: (sessionID) =>
          ctx.session.get({ sessionID: sessionID as SessionID }).pipe(
            Effect.flatMap((info) =>
              Option.match(Option.fromUndefinedOr(info.model), {
                onSome: (model) => Effect.succeed<ModelRef>(model),
                onNone: () =>
                  ctx.model.default().pipe(
                    Effect.flatMap((found) => Effect.fromNullishOr(found.data)),
                    Effect.map((data): ModelRef => ({ providerID: data.providerID, id: data.id })),
                  ),
              }).pipe(Effect.map((model) => Option.some({ model, metadata: { ...info.metadata } }))),
            ),
            Effect.catch((cause) =>
              isNotFound(cause) ? Effect.succeed(Option.none()) : Effect.fail(new SessionUnreadable({ sessionID, message: messageOf(cause) })),
            ),
          ),
        setMetadata: (sessionID, metadata) =>
          ctx.session.update({ sessionID: sessionID as SessionID, metadata: metadata as UpdateInput["metadata"] }).pipe(
            Effect.asVoid,
            Effect.mapError((cause) => new SessionUnwritable({ sessionID, message: messageOf(cause) })),
          ),
        switchModel: (sessionID, model) =>
          ctx.session.switchModel({ sessionID: sessionID as SessionID, model: model as SwitchInput["model"] }).pipe(
            Effect.asVoid,
            Effect.mapError((cause) => new SessionUnwritable({ sessionID, message: messageOf(cause) })),
          ),
        entry: (sessionID, model) =>
          Effect.gen(function* () {
            const directory = yield* directoryOf(sessionID)
            const [models, providers] = yield* Effect.all([ctx.model.list({ location: { directory } }), ctx.provider.list({ location: { directory } })])
            const listed: ReadonlyArray<CatalogModel> = models.data
            const found = listed.find((entry) => entry.providerID === model.providerID && entry.id === model.id)
            if (found === undefined) return Option.none<CatalogEntry>()
            const provider: CatalogProvider | undefined = (providers.data as ReadonlyArray<CatalogProvider>).find((entry) => entry.id === model.providerID)
            const kind = found.settings?.compaction?.type ?? provider?.settings?.compaction?.type
            return Option.some<CatalogEntry>({ variants: (found.variants ?? []).map((variant) => variant.id), native: kind === "native" })
          }).pipe(Effect.mapError((cause) => new CatalogUnreadable({ message: messageOf(cause) }))),
        cache: (sessionID) =>
          cache.facts(sessionID).pipe(
            Effect.map(
              (facts): CacheFacts => ({
                compacted: facts.compacted,
                last: Option.map(facts.last, (last) => ({ startedAt: last.startedAt, cached: last.cached, ttl: last.ttl, unresolved: last.unresolved })),
              }),
            ),
            Effect.mapError((error) => new SessionUnreadable({ sessionID, message: error.message })),
          ),
      })
    }),
  ).pipe(Layer.provide(cacheReads))
}
