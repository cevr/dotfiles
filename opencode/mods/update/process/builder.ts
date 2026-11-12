import { Effect, Layer } from "effect"
import { writeText } from "../filestore/files.ts"
import { Builder, UpdateFailed } from "../service.ts"
import { files, type Settings } from "../settings.ts"
import { said, spawned } from "./run.ts"

/** The stage's command: daily from the advanced checkout, building the target's fork commit, restarting nothing. */
export const stageCommand = (settings: Settings, fork: string): ReadonlyArray<string> => [settings.bun, "scripts/daily.ts", "--stage", "--fork-target", fork]

/** The Builder over daily: its whole output goes to the stage log, its tail into a failure. */
export const layer = (settings: Settings, env: Readonly<globalThis.Record<string, string>>) =>
  Layer.succeed(
    Builder,
    Builder.of({
      stage: (target) =>
        Effect.gen(function* () {
          const ran = yield* spawned("stage the build", stageCommand(settings, target.fork), { cwd: `${settings.checkout}/opencode`, env })
          yield* writeText("write the stage log", files(settings).stage, `${ran.stdout}${ran.stderr}`)
          if (ran.code !== 0) return yield* new UpdateFailed({ step: "stage the build", message: said(ran) })
        }),
    }),
  )
