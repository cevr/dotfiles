import * as Configs from "@dotfiles/opencode-update/filestore/configs"
import * as Log from "@dotfiles/opencode-update/filestore/log"
import * as Notice from "@dotfiles/opencode-update/filestore/notice"
import * as Records from "@dotfiles/opencode-update/filestore/records"
import * as Source from "@dotfiles/opencode-update/git/source"
import { handoff } from "@dotfiles/opencode-update/model"
import * as Service from "@dotfiles/opencode-update/process/service"
import { files, HANDOFF_SETTINGS, type Settings, SettingsJson, stepEnv } from "@dotfiles/opencode-update/settings"
import { argv } from "bun"
import { Config, Effect, Layer } from "effect"

/** Every implementation the handoff runs on. */
export const live = (settings: Settings, env: Readonly<globalThis.Record<string, string>>) =>
  Layer.mergeAll(
    Service.layer(settings, env),
    Source.layer({ root: settings.checkout, mode: settings.mode, bun: settings.bun, fork: settings.fork, env }),
    Records.layer(settings.record),
    Configs.layer({ config: settings.config, kept: files(settings).kept }),
    Notice.layer(settings.notice),
    Log.layer(files(settings).log, settings.host),
  )

/**
 * The handoff, a process of its own that outlives the service it restarts (`process/handoff.ts`
 * starts it detached): restart, health check, recovery (`model.ts` `handoff`). Its settings come in
 * `DOTFILES_UPDATE_SETTINGS`, its reason as its argument.
 */
export const main = handoff(argv.slice(2).join(" "))

/** The implementations, from the settings in the environment. */
export const Live = Layer.unwrap(
  Effect.gen(function* () {
    const settings = yield* Config.schema(SettingsJson, HANDOFF_SETTINGS)
    const path = yield* Config.String("PATH").pipe(Config.withDefault(""))
    return live(settings, stepEnv(settings, path))
  }),
)

if (import.meta.main) Effect.runFork(main.pipe(Effect.provide(Live)))
