/**
 * The host's directories our TUI plugins read their files from: `HOME` and
 * the XDG base dirs, read through Effect's Config. A TUI plugin is loaded by
 * the host's own loader, so nothing can be handed to it; the config source is
 * process-wide instead, as the TUI clock is (tui-clock.ts): the process's env
 * by default, and a harness's own once it `install`s one (sim-tui/app.ts points
 * every dir into the test's scratch), so a simulated TUI never reads the
 * host's files. Every read is of the source installed at that moment.
 */
import { Config, ConfigProvider, Effect, Option } from "effect"

/** The directories a plugin's files live under, as the XDG base directory spec places them. */
export interface Dirs {
  readonly home: string
  readonly state: string
  readonly data: string
  readonly config: string
  readonly cache: string
}

/** An XDG base dir: its variable when set and not empty, else `fallback` under home. */
const base = (name: string, home: string, fallback: string) =>
  Config.option(Config.String(name)).pipe(
    Config.map((value) =>
      Option.getOrElse(
        Option.filter(value, (dir) => dir !== ""),
        () => `${home}/${fallback}`,
      ),
    ),
  )

const read = Effect.gen(function* () {
  const home = yield* Config.String("HOME").pipe(Config.withDefault(""))
  return {
    home,
    state: yield* base("XDG_STATE_HOME", home, ".local/state"),
    data: yield* base("XDG_DATA_HOME", home, ".local/share"),
    config: yield* base("XDG_CONFIG_HOME", home, ".config"),
    cache: yield* base("XDG_CACHE_HOME", home, ".cache"),
  } satisfies Dirs
})

const KEY = Symbol.for("dotfiles.tui-dirs")
const registry: { [key: symbol]: Option.Option<ConfigProvider.ConfigProvider> } = globalThis

/** The installed config source, if any; with none, Effect's own default (the process's env). */
export const current = (): Option.Option<ConfigProvider.ConfigProvider> => Option.flatten(Option.fromNullishOr(registry[KEY]))

/** Makes `provider` the source every plugin's dirs come from; the returned function puts the one before it back. */
export const install = (provider: ConfigProvider.ConfigProvider) => {
  const before = current()
  registry[KEY] = Option.some(provider)
  return () => {
    registry[KEY] = before
  }
}

/** The dirs now, from the source in force. */
export const dirs = (): Dirs =>
  Effect.runSync(
    Option.match(current(), {
      onNone: () => Effect.orDie(read),
      onSome: (provider) => Effect.provideService(Effect.orDie(read), ConfigProvider.ConfigProvider, provider),
    }),
  )
