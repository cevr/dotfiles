import { file, spawn } from "bun"
import { Effect, Layer, Schema } from "effect"
import { Handoff, UpdateFailed } from "../service.ts"
import { files, HANDOFF_SETTINGS, type Settings, SettingsJson } from "../settings.ts"
import { environment } from "./run.ts"

const encodeSettings = Schema.encodeSync(SettingsJson)

/** The handoff's command: its program from the checkout, the reason to log. */
export const handoffCommand = (settings: Settings, reason: string): ReadonlyArray<string> => [settings.bun, `${settings.checkout}/opencode/cmd/update/handoff.ts`, reason]

/**
 * The Handoff as a detached process: a session of its own (`detached`), so neither the service's
 * exit nor its process group's takes it down, its output in the handoff log, and nothing of it
 * held by the service.
 */
export const layer = (settings: Settings, env: Readonly<globalThis.Record<string, string>>) =>
  Layer.succeed(
    Handoff,
    Handoff.of({
      start: (reason) =>
        Effect.try({
          try: () => {
            const log = file(files(settings).handoff)
            const child = spawn([...handoffCommand(settings, reason)], {
              cwd: settings.checkout,
              env: environment({ ...env, [HANDOFF_SETTINGS]: encodeSettings(settings) }),
              stdin: "ignore",
              stdout: log,
              stderr: log,
              detached: true,
            })
            child.unref()
          },
          catch: (cause) => new UpdateFailed({ step: "start the handoff", message: String(cause) }),
        }),
    }),
  )
