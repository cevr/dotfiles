import { Effect, Layer, Match, Option, Predicate, Schema } from "effect"
import { readText } from "../filestore/files.ts"
import type { Listed } from "../health.ts"
import { Placement } from "../placement.ts"
import { Service, UpdateFailed } from "../service.ts"
import type { Settings } from "../settings.ts"
import { residentHeader } from "./resident.ts"
import { run, spawned } from "./run.ts"

const PluginList = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      source: Schema.Struct({ type: Schema.String, path: Schema.optionalKey(Schema.String) }),
      state: Schema.Struct({ status: Schema.String, error: Schema.optionalKey(Schema.String) }),
    }),
  ),
})
const decodePlugins = Schema.decodeUnknownOption(Schema.fromJsonString(PluginList))

const PoolStatus = Schema.Struct({ output: Schema.Record(Schema.String, Schema.Struct({ accounts: Schema.Array(Schema.Struct({ credentialID: Schema.String })) })) })
const decodePool = Schema.decodeUnknownOption(Schema.fromJsonString(PoolStatus))

const Config = Schema.Struct({ plugins: Schema.Array(Schema.Union([Schema.String, Schema.Struct({ package: Schema.String })])) })
const decodeConfig = Schema.decodeUnknownOption(Schema.fromJsonString(Config))

/** Where a server config names a model, each read on its own so one odd entry hides no other. */
const DefaultModel = Schema.Struct({ model: Schema.String })
const AgentModels = Schema.Struct({ agents: Schema.Record(Schema.String, Schema.Unknown) })
const AgentModel = Schema.Struct({ model: Schema.String })
const PluginEntries = Schema.Struct({ plugins: Schema.Array(Schema.Unknown) })
const PlannerModel = Schema.Struct({ options: Schema.Struct({ planner: Schema.Struct({ model: Schema.String }) }) })
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/** Credentials as the integration list (`/api/integration`) names them: no secret, only the connections. */
const IntegrationList = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String, connections: Schema.Array(Schema.Unknown) })) })
const decodeIntegrations = Schema.decodeUnknownOption(Schema.fromJsonString(IntegrationList))

const providerOf = (model: string): Option.Option<string> => Option.liftPredicate(model.split("/")[0] ?? "", (provider) => provider !== "" && model.includes("/"))

/**
 * The providers a server config's models use: the default model, each agent's (the orchestrate
 * roles') and a plugin's `planner` model (orchestrate's), as `provider/model` names them.
 */
export const providersOf = (text: string): ReadonlyArray<string> => {
  const json = decodeJson(text)
  const models = [
    ...Option.toArray(Option.flatMap(json, Schema.decodeUnknownOption(DefaultModel))).map((config) => config.model),
    ...Option.toArray(Option.flatMap(json, Schema.decodeUnknownOption(AgentModels))).flatMap((config) =>
      Object.values(config.agents).flatMap((agent) => Option.toArray(Schema.decodeUnknownOption(AgentModel)(agent)).map((each) => each.model)),
    ),
    ...Option.toArray(Option.flatMap(json, Schema.decodeUnknownOption(PluginEntries))).flatMap((config) =>
      config.plugins.flatMap((entry) => Option.toArray(Schema.decodeUnknownOption(PlannerModel)(entry)).map((each) => each.options.planner.model)),
    ),
  ]
  return [...new Set(models.flatMap((model) => Option.toArray(providerOf(model))))]
}

/** The providers whose pool lists at least one account. */
export const pooledOf = (text: string): ReadonlyArray<string> =>
  Option.match(decodePool(text), { onNone: () => [], onSome: (status) => Object.entries(status.output).filter(([, pool]) => pool.accounts.length > 0).map(([provider]) => provider) })

/** The integrations with a stored credential or a key in the environment; none when the list does not read. */
export const connectedOf = (text: string): Option.Option<ReadonlyArray<string>> =>
  decodeIntegrations(text).pipe(Option.map((list) => list.data.filter((integration) => integration.connections.length > 0).map((integration) => integration.id)))

/** The plugins a listing names, by where they load from and whether they failed. */
export const listedOf = (text: string): Option.Option<ReadonlyArray<Listed>> =>
  decodePlugins(text).pipe(
    Option.map((list) =>
      list.data.map((plugin) => ({
        path: Option.fromNullishOr(plugin.source.path).pipe(Option.filter(() => plugin.source.type === "local")),
        failed: Option.liftPredicate(plugin.state.error ?? "failed", () => plugin.state.status === "failed"),
      })),
    ),
  )

const decodePlacement = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ output: Placement })))

/** Where the service runs, in the update plugin's `placement` answer; none for text that is not one. */
export const answeredPlacement = (text: string): Option.Option<Placement> => decodePlacement(text).pipe(Option.map((answer) => answer.output))

/** How many accounts the pool's status answer holds, over every pool. */
export const accountsOf = (text: string): Option.Option<number> =>
  decodePool(text).pipe(Option.map((status) => Object.values(status.output).reduce((sum, pool) => sum + pool.accounts.length, 0)))

/** The local server plugins a server config names: the entries that are absolute paths. */
export const configuredOf = (text: string): ReadonlyArray<string> =>
  Option.match(decodeConfig(text), {
    onNone: () => [],
    onSome: (config) => config.plugins.map((entry) => Match.value(entry).pipe(Match.when(Predicate.isString, (path) => path), Match.orElse((object) => object.package))).filter((path) => path.startsWith("/")),
  })

/** The service as the launcher reaches it: `service restart`, and `api` calls in the resident location. */
export const layer = (settings: Settings, env: Readonly<globalThis.Record<string, string>>) => {
  const place = { cwd: settings.checkout, env }
  const resident = residentHeader(settings.resident)
  const server = settings.config.find((path) => path.endsWith("/opencode.json")) ?? ""
  /** The pool's status answer; none when it does not answer. */
  const pool = spawned("ask the pool", [settings.launcher, "api", "POST", "/api/rpc/dotfiles-opencode.pool/status", "-H", resident, "-d", `{"input":{}}`], place).pipe(
    Effect.map((ran) => Option.map(Option.liftPredicate(ran, (each) => each.code === 0), (each) => each.stdout)),
  )
  /** Where the service runs, as its update plugin answers; none when it does not (a build from before the placement). */
  const placement = spawned("ask where the service runs", [settings.launcher, "api", "POST", "/api/rpc/dotfiles-opencode.update/placement", "-H", resident, "-d", `{"input":{}}`], place).pipe(
    Effect.map((ran) => Option.flatMap(Option.liftPredicate(ran, (each) => each.code === 0), (each) => answeredPlacement(each.stdout))),
  )
  /** The providers with an account in the pool (its answer) or a stored credential. */
  const loginsWith = Effect.fn("Service.logins")(function* (answer: Option.Option<string>) {
    const integrations = yield* run("list the integrations", [settings.launcher, "api", "GET", "/api/integration", "-H", resident], place)
    const connected = connectedOf(integrations)
    if (Option.isNone(connected)) return yield* new UpdateFailed({ step: "list the integrations", message: "the integration list does not read" })
    return [...new Set([...Option.match(answer, { onNone: () => [], onSome: pooledOf }), ...connected.value])]
  })
  return Layer.succeed(
    Service,
    Service.of({
      restart: run("restart the service", [settings.launcher, "service", "restart"], place).pipe(Effect.asVoid),
      read: Effect.gen(function* () {
        const plugins = yield* run("list the plugins", [settings.launcher, "api", "GET", "/api/plugin", "-H", resident], place)
        const listed = listedOf(plugins)
        if (Option.isNone(listed)) return yield* new UpdateFailed({ step: "list the plugins", message: plugins.slice(0, 500) })
        const answer = yield* pool
        const config = Option.getOrElse(yield* readText(server), () => "")
        return {
          configured: configuredOf(config),
          listed: listed.value,
          accounts: Option.flatMap(answer, accountsOf),
          providers: providersOf(config),
          logins: yield* loginsWith(answer),
          placement: yield* placement,
        }
      }),
      logins: Effect.flatMap(pool, loginsWith),
    }),
  )
}
