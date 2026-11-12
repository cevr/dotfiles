import { env, spawnSync } from "bun"
import { Option, Schema } from "effect"
import { type Build, parseRecord, recordText, stagedRecord } from "../record.ts"
import { HANDOFF_SETTINGS, modeOf, type Settings, SettingsJson, stepEnv } from "../settings.ts"
import { environment } from "./run.ts"

const encodeSettings = Schema.encodeSync(SettingsJson)

/** The value after `--name` in `argv`, as a list of none or one, for a caller with no Option. */
export const flagValue = (argv: ReadonlyArray<string>, name: string): ReadonlyArray<string> => {
  const at = argv.indexOf(name)
  return Option.toArray(Option.filter(Option.fromNullishOr(argv[at + 1]), (value) => at >= 0 && !value.startsWith("--")))
}

/** Where daily's install puts things on a host, for the update's settings. */
export interface Host {
  readonly host: string
  readonly home: string
  /** The XDG state directory: `XDG_STATE_HOME`, else `~/.local/state`. */
  readonly state: string
  readonly checkout: string
  readonly fork: string
  readonly bun: string
  readonly resident: string
  readonly launcher: string
}

/** The update's settings on a host, as daily writes them into the plugin's entry. */
export const settingsFor = (host: Host): Settings => ({
  host: host.host,
  checkout: host.checkout,
  mode: modeOf(host.host),
  fork: host.fork,
  bun: host.bun,
  launcher: host.launcher,
  resident: host.resident,
  record: `${host.state}/opencode/installed.json`,
  config: [`${host.home}/.config/opencode/opencode.json`, `${host.home}/.config/opencode/cli.json`],
  notice: `${host.state}/opencode-daily/upstream.json`,
  state: `${host.state}/opencode-update`,
})

/** The update plugin's entry in the server config. */
export const updateEntry = (directory: string, settings: Settings) => ({ package: directory, options: settings })

/** The commit a checkout is on, in full. */
export const headOf = (directory: string): string => spawnSync(["git", "-C", directory, "rev-parse", "HEAD"]).stdout.toString().trim()

/**
 * The installed record once daily built `build` (`record.ts` `stagedRecord`): the last record's text
 * read back, `build` staged for the handoff to install, the builds in the share directory superseded.
 */
export const stagedText = (last: string, build: Build, share: ReadonlyArray<string>): string => recordText(stagedRecord(parseRecord(last), build, share))

/**
 * Restarts the service through the update's handoff, as the plugin does, waiting for it: the health
 * check and its recovery run for an install by hand too. Answers the handoff's exit code (`model.ts`
 * `EXIT_CODES`: 0 only for a proven build); its lines are in the update's log.
 */
export const restartThroughHandoff = (settings: Settings, reason: string): number =>
  spawnSync([settings.bun, `${settings.checkout}/opencode/cmd/update/handoff.ts`, reason], {
    cwd: settings.checkout,
    env: environment({ ...stepEnv(settings, Option.getOrElse(Option.fromNullishOr(env.PATH), () => "")), [HANDOFF_SETTINGS]: encodeSettings(settings) }),
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  }).exitCode
