import * as Builds from "@dotfiles/opencode-update/filestore/builds"
import * as Configs from "@dotfiles/opencode-update/filestore/configs"
import * as Log from "@dotfiles/opencode-update/filestore/log"
import * as Notice from "@dotfiles/opencode-update/filestore/notice"
import * as Records from "@dotfiles/opencode-update/filestore/records"
import * as Rejections from "@dotfiles/opencode-update/filestore/rejections"
import * as Source from "@dotfiles/opencode-update/git/source"
import { EXIT_CODES, handoff } from "@dotfiles/opencode-update/model"
import * as HandoffMark from "@dotfiles/opencode-update/process/mark"
import * as Service from "@dotfiles/opencode-update/process/service"
import { files, HANDOFF_SETTINGS, type Settings, SettingsJson, shareDir, stepEnv } from "@dotfiles/opencode-update/settings"
import { argv } from "bun"
import { Config, Effect, Layer } from "effect"

/** Every implementation the handoff runs on. */
export const live = (settings: Settings, env: Readonly<globalThis.Record<string, string>>, registration: string, share: string) =>
  Layer.mergeAll(
    Service.layer(settings, env, registration),
    Builds.layer(Builds.optionsOf(share, process.platform)),
    Source.layer({ root: settings.checkout, mode: settings.mode, bun: settings.bun, fork: settings.fork, env }),
    Records.layer(settings.record),
    Rejections.layer(files(settings).rejected),
    HandoffMark.layer(files(settings).mark, process.pid),
    Configs.layer({ config: settings.config, kept: files(settings).kept }),
    Notice.layer(settings.notice),
    Log.layer(files(settings).log, settings.host),
  )

/**
 * The handoff, a process of its own that outlives the service it restarts (`process/handoff.ts`
 * starts it detached): restart, health check, recovery (`model.ts` `handoff`). Its settings come in
 * `DOTFILES_UPDATE_SETTINGS`, its reason as its argument. It answers its exit code: 0 only for a
 * proven build (`EXIT_CODES`), 1 when its settings do not read.
 */
export const main = handoff(argv.slice(2).join(" ")).pipe(Effect.map((outcome) => EXIT_CODES[outcome]))

/** The implementations, from the settings in the environment. */
export const Live = Layer.unwrap(
  Effect.gen(function* () {
    const settings = yield* Config.schema(SettingsJson, HANDOFF_SETTINGS)
    const path = yield* Config.String("PATH").pipe(Config.withDefault(""))
    const state = yield* Config.String("XDG_STATE_HOME").pipe(Config.option)
    const home = yield* Config.String("HOME").pipe(Config.withDefault(""))
    return live(settings, stepEnv(settings, path), Service.registrationFile(state, home), shareDir(home))
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
