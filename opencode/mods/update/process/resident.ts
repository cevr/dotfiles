import { Duration, Effect, Layer } from "effect"
import { Resident, UpdateFailed } from "../service.ts"
import type { Settings } from "../settings.ts"
import { run } from "./run.ts"

/** How long the ask may take: a service that does not answer by then is asked again at the next watch. */
export const RESIDENT_TIMEOUT = Duration.minutes(1)

/** The header that names the resident location to the service. */
export const residentHeader = (resident: string): string => `x-opencode-directory:${encodeURIComponent(resident)}`

/**
 * The resident location as the launcher reaches it: `api GET /api/location` in it loads it, and is
 * a no-op once it runs. The same ask the launcher makes after `service start`.
 */
export const layer = (settings: Settings, env: Readonly<globalThis.Record<string, string>>) =>
  Layer.succeed(
    Resident,
    Resident.of({
      load: run("load the resident location", [settings.launcher, "api", "GET", "/api/location", "-H", residentHeader(settings.resident)], { cwd: settings.checkout, env }).pipe(
        Effect.timeoutOrElse({
          duration: RESIDENT_TIMEOUT,
          orElse: () => Effect.fail(new UpdateFailed({ step: "load the resident location", message: `no answer in ${Duration.format(RESIDENT_TIMEOUT)}` })),
        }),
        Effect.asVoid,
      ),
    }),
  )
