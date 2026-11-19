import { Effect, Layer } from "effect"
import { writeText } from "../filestore/files.ts"
import { Builder, UpdateFailed } from "../service.ts"
import { files, type Settings } from "../settings.ts"
import { said, spawned } from "./run.ts"

/**
 * The stage's command: daily from the checkout as it stands, building the target's fork commit and
 * naming the target's dotfiles commit in the record, writing no config and restarting nothing.
 */
export const stageCommand = (settings: Settings, fork: string, dotfiles: string): ReadonlyArray<string> => [settings.bun, "scripts/daily.ts", "--stage", "--fork-target", fork, "--dotfiles-target", dotfiles]

/** The configure command: daily from the moved checkout, writing its configs and nothing else. */
export const configureCommand = (settings: Settings): ReadonlyArray<string> => [settings.bun, "scripts/daily.ts", "--configure"]

/** The Builder over daily: each step's whole output goes to the stage log, its tail into a failure. */
export const layer = (settings: Settings, env: Readonly<globalThis.Record<string, string>>) => {
  const daily = (step: string, command: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const ran = yield* spawned(step, command, { cwd: `${settings.checkout}/opencode`, env })
      yield* writeText("write the stage log", files(settings).stage, `${ran.stdout}${ran.stderr}`)
      if (ran.code !== 0) return yield* new UpdateFailed({ step, message: said(ran) })
    })
  return Layer.succeed(
    Builder,
    Builder.of({
      stage: (target) => daily("stage the build", stageCommand(settings, target.fork, target.dotfiles)),
      configure: daily("write the configs", configureCommand(settings)),
    }),
  )
}
