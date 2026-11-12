import { Duration, Effect, Schema } from "effect"

/**
 * Where the host's update finds everything, as `bun run daily` writes it into the plugin's entry
 * (and hands the same to the handoff): absolute paths, so no step depends on PATH or the working
 * directory a service manager gave the process.
 */
export const Settings = Schema.Struct({
  /** The host's name, in each log line. */
  host: Schema.String,
  /** The dotfiles checkout the plugins load from (the warm source). */
  checkout: Schema.String,
  /** How the checkout moves: `ff`, or `reset` where Syncthing keeps its files (`git/source.ts`). */
  mode: Schema.Literals(["ff", "reset"]),
  /** The fork checkout daily builds. */
  fork: Schema.String,
  /** The bun that runs every step. */
  bun: Schema.String,
  /** `~/.local/bin/opencode`, the launcher daily writes. */
  launcher: Schema.String,
  /** The resident location's directory: the copy of the plugin there is the one that updates. */
  resident: Schema.String,
  /** The installed record (`record.ts`). */
  record: Schema.String,
  /** The server and TUI config files a stage writes. */
  config: Schema.Array(Schema.String),
  /** The upstream reading Prime's TUI corner draws, where a failed update shows. */
  notice: Schema.String,
  /** The update's own directory: its log, the stage's output, the kept config. */
  state: Schema.String,
})
export interface Settings extends Schema.Schema.Type<typeof Settings> {}

/** The plugin's options: the settings, and how often it looks for a new target. */
export const Options = Schema.Struct({
  ...Settings.fields,
  everyMinutes: Schema.Number.check(Schema.isGreaterThan(0)).pipe(Schema.withDecodingDefaultType(Effect.succeed(10))),
})
export interface Options extends Schema.Schema.Type<typeof Options> {}

/**
 * The hosts whose dotfiles checkout follows the Mac's through Syncthing: their checkout moves by
 * reset, since a merge can refuse files Syncthing already brought. The workbox is one.
 */
export const SYNCTHING_FOLLOWERS: ReadonlyArray<string> = ["bite-cristian"]

/** How a host moves its checkout, by its host name (lower case, without `.local`). */
export const modeOf = (host: string): Settings["mode"] => {
  if (SYNCTHING_FOLLOWERS.includes(host.toLowerCase().replace(/\.local$/, ""))) return "reset"
  return "ff"
}

/** The settings in the handoff's environment variable. */
export const SettingsJson = Schema.fromJsonString(Settings)

/** The variable that carries them. */
export const HANDOFF_SETTINGS = "DOTFILES_UPDATE_SETTINGS"

/** The log, the stage's output and the kept config, in the update's directory. */
export const files = (settings: Settings) => ({
  log: `${settings.state}/update.log`,
  stage: `${settings.state}/stage.log`,
  handoff: `${settings.state}/handoff.log`,
  mark: `${settings.state}/handoff.json`,
  kept: `${settings.state}/config-kept`,
  rejected: `${settings.state}/rejected.json`,
})

/** How often the plugin looks for a new target. */
export const every = (options: Options): Duration.Duration => Duration.minutes(options.everyMinutes)

/** The variables every step runs with: bun's directory first on PATH, the fork for the tooling links. */
export const stepEnv = (settings: Settings, path: string): globalThis.Record<string, string> => ({
  PATH: [settings.bun.split("/").slice(0, -1).join("/"), ...path.split(":").filter((part) => part !== "")].join(":"),
  OPENCODE_DEV: settings.fork,
})
