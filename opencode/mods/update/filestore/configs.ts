import { Array as Arr, Effect, Layer, Option, Schema } from "effect"
import { Configs, UpdateFailed } from "../service.ts"
import { SERVER_OFF } from "../trees.ts"
import { readText } from "./files.ts"

/** Server plugin entries the host no longer has, dropped from the config: the automation plugin's name before upstream's rename (2026-11-16). */
export const RETIRED_PLUGINS: ReadonlyArray<string> = ["-opencode.tool.schedule"]

/** The old writer's ownership rule (`scripts/daily.ts` `mergeServer`): the plugin directories daily owns, and our entries that name none. */
export interface Ours {
  readonly dirs: ReadonlyArray<string>
  readonly names: ReadonlyArray<string>
}

/** The server config the handoff reads (`~/.config/opencode/opencode.json`), and what is ours in it. */
export interface Paths {
  /** The server config (`opencode.json`), the one the handoff reads for entries of ours. */
  readonly server: string
  /** The live checkout's `opencode/`, under which the old writer's entries are. */
  readonly under: string
  /** What is ours in it (`oursOf`). */
  readonly owned: Ours
}

/**
 * What is ours in a host's server config whose live dotfiles checkout is `checkout` and share
 * directory `share`, as the writer before plugin trees (51fc7c9f's `scripts/daily.ts`) listed it: the checkout's
 * `opencode/mods` and `opencode/cmd`, the auth plugin's old loader directory, the built-ins the server
 * turns off, and the retired names.
 */
export const oursOf = (checkout: string, share: string): Ours => ({
  dirs: [`${checkout}/opencode/mods`, `${checkout}/opencode/cmd`, `${share}/anthropic-auth`],
  names: [...SERVER_OFF, ...RETIRED_PLUGINS],
})

/** A plugin entry: a package path or name, or one with options. */
const decodeName = Schema.decodeUnknownOption(Schema.String)
const decodeWithOptions = Schema.decodeUnknownOption(Schema.Struct({ package: Schema.String }))

/** Whether a package path is ours by the old writer's rule: under a directory daily owns, or one of our names. */
export const ownsPath = (owned: Ours, path: string): boolean => owned.names.includes(path) || owned.dirs.some((dir) => path === dir || path.startsWith(`${dir}/`))

/** The server config, each key as it is. */
const ServerConfig = Schema.Record(Schema.String, Schema.Unknown)
type ServerConfig = Schema.Schema.Type<typeof ServerConfig>
const decodeServer = Schema.decodeUnknownEffect(Schema.fromJsonString(ServerConfig))
const decodePlugins = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown))

/** The server config's plugin entries; none when it lists none. */
const pluginsOf = (config: ServerConfig) => Option.getOrElse(Option.flatMap(Option.fromNullishOr(config["plugins"]), decodePlugins), () => Arr.empty())

/** The server config's plugin entries, each with whether it is ours (the package it names, none for anything else, is ours by `ownsPath`). */
const entriesOf = (config: ServerConfig, owned: Ours) =>
  pluginsOf(config).map((entry) => ({
    entry,
    ours: Option.exists(
      Option.orElse(decodeName(entry), () => Option.map(decodeWithOptions(entry), (each) => each.package)),
      (path) => ownsPath(owned, path),
    ),
  }))

/** Whether the server config lists an entry of ours. */
export const listsOurs = (config: ServerConfig, owned: Ours): boolean => entriesOf(config, owned).some((each) => each.ours)

/** The server config, none when the file is absent; a file that is not one JSON object fails. */
const readServer = (path: string) =>
  readText(path).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<ServerConfig>()),
        onSome: (text) => decodeServer(text).pipe(Effect.map(Option.some), Effect.mapError((cause) => new UpdateFailed({ step: "read the server config", message: `${path} is not one JSON object: ${cause.message}` }))),
      }),
    ),
  )

/** Configs over the file: `ours` reads the server config by the old writer's ownership rule, and nothing writes it. */
export const layer = (paths: Paths) =>
  Layer.succeed(
    Configs,
    Configs.of({
      ours: readServer(paths.server).pipe(
        Effect.map((config) => Option.map(Option.filter(config, (each) => listsOurs(each, paths.owned)), () => ({ file: paths.server, under: paths.under }))),
      ),
    }),
  )
