// The model a new subagent runs on, read from OpenCode: the agent's own
// model, else its parent session's, else (a session that never chose one)
// the default, as the subagent tool picks it. A lookup that fails answers
// undefined, and the call runs as it would have.
import { Effect, Layer, Option } from "effect"
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

/**
 * A model the catalog offers in its own right, not a mode of another: the catalog makes each mode
 * (`fast`, `ultrafast`, `pro`) a model of its own id that asks the base model's `modelID`, with the same
 * family and release. No fallback runs on one (owner, 2026-11-24: "not on SolFast anymore"); only a start
 * that asks fast runs on a fast mode (`fast`).
 */
const standard = (item: Offered) => Option.getOrElse(Option.fromUndefinedOr(item.modelID), () => item.id) === item.id

/** The model an offered item asks the provider with: its own id, or the model it is a mode of. */
const baseOf = (item: Offered) => Option.getOrElse(Option.fromUndefinedOr(item.modelID), () => item.id)

/** The catalog's name of the fast mode. */
const FAST = "fast"

/** Whether `item` is the fast mode of the model it asks (the catalog's `<id>-fast`, models-dev.ts). */
const isFast = (item: Offered) => !standard(item) && item.id === `${baseOf(item)}-${FAST}`

/** `provider/id[#variant]`, split; none without a provider. */
const partsOf = (model: string) => {
  const [ref = "", variant] = model.split("#")
  const slash = ref.indexOf("/")
  return Option.map(Option.liftPredicate(slash, (at) => at > 0), (at) => ({ providerID: ref.slice(0, at), id: ref.slice(at + 1), variant: Option.fromUndefinedOr(variant) }))
}

/** `provider/id`, at `variant` when `item` offers it. */
const named = (item: Offered, variant: Option.Option<string>) =>
  `${item.providerID}/${item.id}${Option.getOrElse(Option.map(Option.filter(variant, (wanted) => item.variants.some((each) => each.id === wanted)), (wanted) => `#${wanted}`), () => "")}`

export const layer = (port: Port) => {
  const base = Effect.fnUntraced(function* (sessionID: string, agentID: string) {
    const parent = yield* port.session(sessionID)
    const own = yield* port.agentModel(agentID, parent.directory).pipe(orNone)
    const model = own ?? parent.model ?? (yield* port.defaultModel(parent.directory))
    return { directory: parent.directory, model }
  })
  /** What `read` makes of `model` as the host offers it, with the whole offer and the variant it named; none when not offered or unread. */
  const offeredAs = (sessionID: string, model: string, read: (item: Offered, offered: ReadonlyArray<Offered>, variant: Option.Option<string>) => Option.Option<string>) =>
    Option.match(partsOf(model), {
      onNone: () => Effect.succeed(Option.none<string>()),
      onSome: (parts) =>
        Effect.gen(function* () {
          const { directory } = yield* port.session(sessionID)
          const offered = yield* port.offered(directory)
          return Option.flatMap(Option.fromUndefinedOr(offered.find((item) => item.providerID === parts.providerID && item.id === parts.id)), (item) => read(item, offered, parts.variant))
        }).pipe(Effect.orElseSucceed(() => Option.none<string>())),
    })
  return Layer.succeed(Models, {
    current: (sessionID) => port.session(sessionID).pipe(orNone, Effect.map((session) => Option.fromUndefinedOr(session?.model))),
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
        .filter((item) => providers.includes(item.providerID) && item.family === family && item.status !== "deprecated" && standard(item))
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
    fast: (sessionID, model) => offeredAs(sessionID, model, (item, offered, variant) => {
      if (isFast(item)) return Option.some(named(item, variant))
      const mode = offered.find((each) => each.providerID === item.providerID && each.id === `${item.id}-${FAST}` && baseOf(each) === item.id && each.status !== "deprecated")
      return Option.map(Option.fromUndefinedOr(mode), (found) => named(found, variant))
    }),
    standardOf: (sessionID, model) => offeredAs(sessionID, model, (item, offered, variant) =>
      Option.flatMap(Option.liftPredicate(item, isFast), (mode) =>
        Option.map(Option.fromUndefinedOr(offered.find((each) => each.providerID === mode.providerID && each.id === baseOf(mode))), (found) => named(found, variant)),
      ),
    ),
  })
}
