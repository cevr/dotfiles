import { Duration, Effect, Layer, Match, Option, Predicate, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { readText } from "../filestore/files.ts"
import type { Listed } from "../health.ts"
import { Placement } from "../placement.ts"
import { Service, UpdateFailed } from "../service.ts"
import type { Settings } from "../settings.ts"
import { run } from "./run.ts"

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

/** The registration `opencode serve --service` writes: where it listens, and its password. */
const Registration = Schema.Struct({ url: Schema.String, password: Schema.optionalKey(Schema.String) })
const decodeRegistration = Schema.decodeUnknownOption(Schema.fromJsonString(Registration))

/** The service's registration file: `${XDG_STATE_HOME ?? ~/.local/state}/opencode/service.json` (the fork's `service-probe.ts` `fallback`). */
export const registrationFile = (state: Option.Option<string>, home: string): string => `${Option.getOrElse(state, () => `${home}/.local/state`)}/opencode/service.json`

/** How long one ask may take: a service that boots under load answers late, and the health check reads again. */
export const ASK_TIMEOUT = Duration.seconds(30)

/** An answer of the service: its status and its body. */
interface Answer {
  readonly status: number
  readonly text: string
}

/** One ask of the service, in the resident location. */
interface Ask {
  readonly step: string
  readonly method: "GET" | "POST"
  readonly path: string
  readonly body: Option.Option<string>
}

const get = (step: string, path: string): Ask => ({ step, method: "GET", path, body: Option.none() })
const rpc = (step: string, id: string): Ask => ({ step, method: "POST", path: `/api/rpc/${id}`, body: Option.some(`{"input":{}}`) })

/** The asks that boot the resident location and wait for its plugins (`/api/model` waits up to 5 s for them, then answers 503). */
const BOOT = get("load the resident location", "/api/location")
const ACTIVATED = get("wait for the resident location's plugins", "/api/model")

/**
 * The service as the handoff reaches it. The restart goes through the launcher (`service restart`).
 * Every read goes to the registered service over HTTP, never through `opencode api`: that client
 * runs the fork's `Service.ensure`, which stops a service that misses three 2 s probes, so on a
 * loaded host the health check's own reads killed the service it was waiting for, every minute
 * (workbox, 2026-11-12). A read first boots the resident location and waits for its plugins to
 * finish activating, so a plugin list read mid-activation is never taken for a plugin that did
 * not load.
 */
export const layer = (settings: Settings, env: Readonly<globalThis.Record<string, string>>, registration: string) => {
  const place = { cwd: settings.checkout, env }
  const server = settings.config.find((path) => path.endsWith("/opencode.json")) ?? ""
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      /** One ask: its answer, whatever its status; a service that is not registered or does not answer fails the step. */
      const ask = Effect.fn("Service.ask")(function* (asked: Ask) {
        const found = Option.flatMap(yield* readText(registration), decodeRegistration)
        if (Option.isNone(found)) return yield* new UpdateFailed({ step: asked.step, message: `no service is registered in ${registration}` })
        const request = HttpClientRequest.make(asked.method)(new URL(asked.path, found.value.url), { headers: { "x-opencode-directory": encodeURIComponent(settings.resident) } })
        const authed = Option.match(Option.fromNullishOr(found.value.password), {
          onNone: () => request,
          onSome: (password) => HttpClientRequest.basicAuth(request, "opencode", Redacted.make(password)),
        })
        const sent = Option.match(asked.body, { onNone: () => authed, onSome: (body) => HttpClientRequest.bodyText(authed, body, "application/json") })
        return yield* client.execute(sent).pipe(
          Effect.flatMap((response) => response.text.pipe(Effect.map((text): Answer => ({ status: response.status, text })))),
          Effect.timeoutOrElse({ duration: ASK_TIMEOUT, orElse: () => Effect.fail(new UpdateFailed({ step: asked.step, message: `no answer in ${Duration.format(ASK_TIMEOUT)}` })) }),
          Effect.catchTag("HttpClientError", (failed) => Effect.fail(new UpdateFailed({ step: asked.step, message: failed.message }))),
        )
      })
      /** An ask that must succeed: its body, or the step failed with what the service said. */
      const answered = (asked: Ask) =>
        ask(asked).pipe(
          Effect.filterOrFail(
            (answer) => answer.status >= 200 && answer.status < 300,
            (answer) => new UpdateFailed({ step: asked.step, message: `${answer.status} ${answer.text.slice(0, 300)}` }),
          ),
          Effect.map((answer) => answer.text),
        )
      /** An ask that may fail: its body when it succeeds, none otherwise. */
      const optional = (asked: Ask) =>
        ask(asked).pipe(Effect.map((answer) => Option.liftPredicate(answer.text, () => answer.status >= 200 && answer.status < 300)), Effect.orElseSucceed(() => Option.none<string>()))
      /** The resident location booted and its plugins active, or a failed step that says which is not. */
      const ready = answered(BOOT).pipe(
        Effect.andThen(ask(ACTIVATED)),
        Effect.flatMap((answer) => {
          if (answer.status === 503) return Effect.fail(new UpdateFailed({ step: ACTIVATED.step, message: "its plugins are still activating" }))
          return Effect.void
        }),
      )
      const pool = optional(rpc("ask the pool", "dotfiles-opencode.pool/status"))
      /** The providers with an account in the pool (its answer) or a stored credential. */
      const loginsWith = Effect.fn("Service.logins")(function* (answer: Option.Option<string>) {
        const connected = connectedOf(yield* answered(get("list the integrations", "/api/integration")))
        if (Option.isNone(connected)) return yield* new UpdateFailed({ step: "list the integrations", message: "the integration list does not read" })
        return [...new Set([...Option.match(answer, { onNone: () => [], onSome: pooledOf }), ...connected.value])]
      })
      return Service.of({
        restart: run("restart the service", [settings.launcher, "service", "restart"], place).pipe(Effect.asVoid),
        read: Effect.gen(function* () {
          yield* ready
          const plugins = yield* answered(get("list the plugins", "/api/plugin"))
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
            placement: Option.flatMap(yield* optional(rpc("ask where the service runs", "dotfiles-opencode.update/placement")), answeredPlacement),
          }
        }),
        logins: ready.pipe(Effect.andThen(pool), Effect.flatMap(loginsWith)),
      })
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer))
}
