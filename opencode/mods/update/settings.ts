import { Duration, Effect, Schema } from "effect"

/**
 * Where the host's update finds everything, as `bun run daily` writes it into the plugin's entry
 * (and hands the same to the handoff): absolute paths, so no step depends on PATH or the working
 * directory a service manager gave the process.
 */
export const Settings = Schema.Struct({
  /** The host's name, in each log line. */
  host: Schema.String,
  /**
   * The live dotfiles checkout: the object store each build's tree is made from, and the host's commands
   * script. No update moves it. (A settings text from an older updater still names a `mode`: it decodes,
   * and the key is dropped.)
   */
  checkout: Schema.String,
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
  /** The server and TUI config files; the handoff reads the server one (`filestore/configs.ts`) and writes neither. */
  config: Schema.Array(Schema.String),
  /** The upstream reading Prime's TUI corner draws, where a failed update shows. */
  notice: Schema.String,
  /** The update's own directory: its log, the stage's output, the handoff's mark. */
  state: Schema.String,
})
export interface Settings extends Schema.Schema.Type<typeof Settings> {}

/** The plugin's options: the settings, and how often it looks for a new target. */
export const Options = Schema.Struct({
  ...Settings.fields,
  everyMinutes: Schema.Number.check(Schema.isGreaterThan(0)).pipe(Schema.withDecodingDefaultType(Effect.succeed(10))),
})
export interface Options extends Schema.Schema.Type<typeof Options> {}

/** The share directory daily copies each build into, `opencode-<version>` (`scripts/daily.ts`). */
export const shareDir = (home: string): string => `${home}/.local/share/opencode-prime`

/**
 * The builds lock, an exclusive `flock(2)` on this file: daily holds it from the copy of a build into
 * the share directory through the staged record's write, and a prune from its record read through its
 * last delete, so a prune never sees a build the record does not name yet.
 */
export const buildsLock = (home: string): string => `${home}/.local/state/opencode-prime/builds.lock`

/** The settings in the handoff's environment variable. */
export const SettingsJson = Schema.fromJsonString(Settings)

/** The variable that carries them. */
export const HANDOFF_SETTINGS = "DOTFILES_UPDATE_SETTINGS"

/** The log, the stage's output, the handoff's mark and the rejection, in the update's directory. */
export const files = (settings: Settings) => ({
  log: `${settings.state}/update.log`,
  stage: `${settings.state}/stage.log`,
  handoff: `${settings.state}/handoff.log`,
  mark: `${settings.state}/handoff.json`,
  rejected: `${settings.state}/rejected.json`,
  checked: `${settings.state}/checked`,
})

/** How often the plugin looks for a new target. */
export const every = (options: Options): Duration.Duration => Duration.minutes(options.everyMinutes)

/** The variables every step runs with: bun's directory first on PATH, and the fork daily builds. */
export const stepEnv = (settings: Settings, path: string): globalThis.Record<string, string> => ({
  PATH: [settings.bun.split("/").slice(0, -1).join("/"), ...path.split(":").filter((part) => part !== "")].join(":"),
  OPENCODE_DEV: settings.fork,
})
