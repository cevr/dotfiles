import * as Builds from "@dotfiles/opencode-update/filestore/builds"
import * as Builder from "@dotfiles/opencode-update/process/builder"
import * as Configs from "@dotfiles/opencode-update/filestore/configs"
import * as Log from "@dotfiles/opencode-update/filestore/log"
import * as Notice from "@dotfiles/opencode-update/filestore/notice"
import * as Records from "@dotfiles/opencode-update/filestore/records"
import * as Rejections from "@dotfiles/opencode-update/filestore/rejections"
import * as Stage from "@dotfiles/opencode-update/filestore/stage"
import * as Source from "@dotfiles/opencode-update/git/source"
import { DigestLog } from "@dotfiles/opencode-digest/event"
import * as DigestFile from "@dotfiles/opencode-digest/filestore/log"
import { installOf } from "@dotfiles/opencode-update/digest"
import { EXIT_CODES, handoff, type Outcome } from "@dotfiles/opencode-update/model"
import * as HandoffMark from "@dotfiles/opencode-update/process/mark"
import * as Service from "@dotfiles/opencode-update/process/service"
import { buildsLock, files, HANDOFF_SETTINGS, type Settings, SettingsJson, shareDir, stepEnv } from "@dotfiles/opencode-update/settings"
import { configPaths, treeOptions } from "@dotfiles/opencode-update/process/install"
import { argv } from "bun"
import { Array as Arr, Clock, Config, Effect, Layer, Option } from "effect"

/** Every implementation the handoff runs on. */
export const live = (settings: Settings, env: Readonly<globalThis.Record<string, string>>, registration: string, home: string) =>
  Layer.mergeAll(
    Service.layer(settings, env, registration),
    Builder.layer(settings, env),
    Builds.layer(Builds.optionsOf(shareDir(home), buildsLock(home), process.platform)),
    Source.layer({ root: settings.checkout, env, bin: Source.binScript(process.platform) }),
    Stage.treesLayer(treeOptions(settings, env, home, process.pid)),
    Records.layer(settings, process.pid),
    Rejections.layer(files(settings).rejected),
    HandoffMark.layer(files(settings).mark, process.pid),
    Configs.layer(configPaths(settings, home)),
    Notice.layer(settings.notice),
    Log.layer(files(settings).log, settings.host),
  )

/**
 * The handoff, a process of its own that outlives the service it restarts (`process/handoff.ts`
 * starts it detached): restart, health check, recovery (`model.ts` `handoff`). Its settings come in
 * `DOTFILES_UPDATE_SETTINGS`, its reason as its argument. It answers its exit code: 0 only for a
 * proven build (`EXIT_CODES`), 1 when its settings do not read.
 */
export const main = Effect.gen(function* () {
  const reason = argv.slice(2).join(" ")
  const outcome = yield* handoff(reason)
  yield* noteInstall(outcome, reason)
  return EXIT_CODES[outcome]
})

/** The install's outcome as one digest line, on this host's digest log; a line not written changes no outcome. */
const noteInstall = (outcome: Outcome, reason: string) =>
  Effect.gen(function* () {
    const settings = yield* Config.schema(SettingsJson, HANDOFF_SETTINGS)
    const t = yield* Clock.currentTimeMillis
    const repo = Option.getOrElse(Arr.last(settings.checkout.replace(/\/+$/, "").split("/")), () => settings.checkout)
    const log = yield* DigestLog
    yield* log.append(installOf(settings.host, outcome, reason, repo, t))
  }).pipe(Effect.ignoreCause)

/** The implementations, from the settings in the environment. */
export const Live = Layer.unwrap(
  Effect.gen(function* () {
    const settings = yield* Config.schema(SettingsJson, HANDOFF_SETTINGS)
    const path = yield* Config.String("PATH").pipe(Config.withDefault(""))
    const state = yield* Config.String("XDG_STATE_HOME").pipe(Config.option)
    const home = yield* Config.String("HOME").pipe(Config.withDefault(""))
    // The digest's log, written straight to its file: the handoff outlives the server whose digest plugin owns it.
    const digest = DigestFile.writer(`${Option.getOrElse(Option.filter(state, (dir) => dir !== ""), () => `${home}/.local/state`)}/opencode-digest`)
    return Layer.merge(live(settings, stepEnv(settings, path), Service.registrationFile(state, home), home), digest)
  }),
)

/** The exit code of the whole run: the outcome's, or 1 for settings that do not read. */
export const run = main.pipe(
  Effect.provide(Live),
  Effect.catch((error) => Effect.logError(`the handoff's settings do not read: ${error.message}`).pipe(Effect.as(EXIT_CODES["gave-up"]))),
)

if (import.meta.main)
  Effect.runFork(
    run.pipe(
      Effect.tap((code) =>
        Effect.sync(() => {
          process.exitCode = code
        }),
      ),
    ),
  )
