import { Effect, Layer, Match, Option, Predicate, Schema } from "effect"
import { readText } from "../filestore/files.ts"
import type { Listed } from "../health.ts"
import { Service, UpdateFailed } from "../service.ts"
import type { Settings } from "../settings.ts"
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
  const resident = `x-opencode-directory:${encodeURIComponent(settings.resident)}`
  const server = settings.config.find((path) => path.endsWith("/opencode.json")) ?? ""
  return Layer.succeed(
    Service,
    Service.of({
      restart: run("restart the service", [settings.launcher, "service", "restart"], place).pipe(Effect.asVoid),
      read: Effect.gen(function* () {
        const plugins = yield* run("list the plugins", [settings.launcher, "api", "GET", "/api/plugin", "-H", resident], place)
        const listed = listedOf(plugins)
        if (Option.isNone(listed)) return yield* new UpdateFailed({ step: "list the plugins", message: plugins.slice(0, 500) })
        const pool = yield* spawned("ask the pool", [settings.launcher, "api", "POST", "/api/rpc/dotfiles-opencode.pool/status", "-H", resident, "-d", `{"input":{}}`], place)
        const configured = configuredOf(Option.getOrElse(yield* readText(server), () => ""))
        return { configured, listed: listed.value, accounts: Option.flatMap(Option.liftPredicate(pool, (ran) => ran.code === 0), (ran) => accountsOf(ran.stdout)) }
      }),
    }),
  )
}
