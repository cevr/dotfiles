import { Array as Arr, Effect, Layer, Option, Schema } from "effect"
import { Configs, UpdateFailed } from "../service.ts"
import { SERVER_OFF, TUI_OFF } from "../trees.ts"
import { readText, remove, writeText } from "./files.ts"

/** Server plugin entries the host no longer has, dropped from the config: the automation plugin's name before upstream's rename (2026-11-16). */
export const RETIRED_PLUGINS: ReadonlyArray<string> = ["-opencode.tool.schedule"]

/** The old writer's ownership rule (`scripts/daily.ts` `mergeServer`): the plugin directories daily owns, and our entries that name none. */
export interface Ours {
  readonly dirs: ReadonlyArray<string>
  readonly names: ReadonlyArray<string>
}

/** The config files a stage writes (`~/.config/opencode`), and where the replaced ones are kept. */
export interface Paths {
  readonly config: ReadonlyArray<string>
  readonly kept: string
  /** The server config (`opencode.json`), the one the first tree install strips. */
  readonly server: string
  /** What is ours in it (`oursOf`). */
  readonly owned: Ours
  /** The TUI config (`cli.json`), the one the late strip strips. */
  readonly tui: string
  /** What is ours in it (`tuiOursOf`). */
  readonly tuiOwned: Ours
}

/**
 * What is ours in the TUI config, as `scripts/daily.ts` `mergeCli` wrote it: entries under the same
 * directories as the server's (`oursOf`), and the built-ins the TUI turns off.
 */
export const tuiOursOf = (checkout: string, share: string): Ours => ({ dirs: oursOf(checkout, share).dirs, names: [...TUI_OFF] })

/** Where the late strip keeps the TUI config it strips: beside the migration's copies, under its own name. */
export const tuiKeptOf = (paths: Pick<Paths, "kept">): string => `${paths.kept}/cli.json.before-late-strip`

/**
 * What is ours in a host's server config whose live dotfiles checkout is `checkout` and share
 * directory `share`, as `scripts/daily.ts` `ownedDirs` and its plugin lists say: the checkout's
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

/** The server config, each key kept as it is, written as daily writes a config (two-space JSON). */
const ServerConfig = Schema.Record(Schema.String, Schema.Unknown)
type ServerConfig = Schema.Schema.Type<typeof ServerConfig>
const ServerJson = Schema.fromJsonString(ServerConfig, { space: 2 })
const decodeServer = Schema.decodeUnknownEffect(ServerJson)
const encodeServer = Schema.encodeSync(ServerJson)
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

/** The plugin entries of the server config that are not ours, in order; every other key stays as it was. */
export const stripped = (config: ServerConfig, owned: Ours): ServerConfig => ({
  ...config,
  plugins: entriesOf(config, owned).flatMap((each) => Option.toArray(Option.liftPredicate(each.entry, () => !each.ours))),
})

/** Whether the server config lists an entry of ours. */
export const listsOurs = (config: ServerConfig, owned: Ours): boolean => entriesOf(config, owned).some((each) => each.ours)

const keptOf = (paths: Pick<Paths, "kept">, path: string): string => `${paths.kept}/${Option.getOrElse(Arr.last(path.split("/")), () => path)}`

/** The server config, none when the file is absent; a file that is not one JSON object fails. */
const readServer = (path: string, what = "server config") =>
  readText(path).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<ServerConfig>()),
        onSome: (text) => decodeServer(text).pipe(Effect.map(Option.some), Effect.mapError((cause) => new UpdateFailed({ step: `read the ${what}`, message: `${path} is not one JSON object: ${cause.message}` }))),
      }),
    ),
  )

/**
 * The late strip of the TUI config: when it lists ours, its text is kept (`tuiKeptOf`) and then it is
 * written with only the entries that are not ours, every other key (the theme, the tabs) kept. A file
 * absent, or listing none of ours, is not written.
 */
const stripTui = (paths: Paths) =>
  readText(paths.tui).pipe(
    Effect.flatMap((text) =>
      Effect.forEach(Option.toArray(text), (each) =>
        readServer(paths.tui, "TUI config").pipe(
          Effect.flatMap((config) =>
            Effect.forEach(Option.toArray(Option.filter(config, (one) => listsOurs(one, paths.tuiOwned))), (one) =>
              writeText("keep the TUI config", tuiKeptOf(paths), each).pipe(Effect.andThen(writeText("strip the TUI config", paths.tui, `${encodeServer(stripped(one, paths.tuiOwned))}\n`))),
            ),
          ),
        ),
      ),
    ),
    Effect.asVoid,
  )

/**
 * Configs over the files: keep copies them aside (a file absent then has no copy); restore puts each
 * copy back where its file differs and leaves a file with no copy as it is, so a file the update did
 * not change is not written (a TUI watches its config). `ours` and `strip` read the server config by
 * the old writer's ownership rule; a strip with nothing of ours writes nothing.
 */
export const layer = (paths: Paths) =>
  Layer.succeed(
    Configs,
    Configs.of({
      keep: Effect.forEach(
        paths.config,
        (path) =>
          readText(path).pipe(
            Effect.flatMap((text) =>
              Option.match(text, { onNone: () => remove(keptOf(paths, path)), onSome: (each) => writeText("keep the config", keptOf(paths, path), each) }),
            ),
          ),
        { discard: true },
      ),
      restore: Effect.forEach(
        paths.config,
        (path) =>
          Effect.all([readText(keptOf(paths, path)), readText(path)]).pipe(
            Effect.flatMap(([kept, now]) =>
              Option.match(Option.filter(kept, (each) => !Option.contains(now, each)), { onNone: () => Effect.void, onSome: (each) => writeText("restore the config", path, each) }),
            ),
          ),
        { discard: true },
      ),
      ours: readServer(paths.server).pipe(Effect.map(Option.exists((config) => listsOurs(config, paths.owned)))),
      strip: readServer(paths.server).pipe(
        Effect.flatMap((config) =>
          Effect.forEach(Option.toArray(Option.filter(config, (each) => listsOurs(each, paths.owned))), (each) => writeText("strip the server config", paths.server, `${encodeServer(stripped(each, paths.owned))}\n`), {
            discard: true,
          }),
        ),
      ),
      tuiOurs: readServer(paths.tui, "TUI config").pipe(Effect.map(Option.exists((config) => listsOurs(config, paths.tuiOwned)))),
      stripTui: stripTui(paths),
    }),
  )
