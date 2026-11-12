import { Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Resident } from "../service.ts"
import { asker, BOOT } from "./service.ts"

/**
 * The resident location as the registered service answers it: `GET /api/location` in it loads it,
 * and is a no-op once it runs; the same ask the launcher makes after `service start`. It goes over
 * HTTP to the address and password the service registers (`registration`, the health check's
 * reader), never through `opencode api`, whose `Service.ensure` stops a service that misses three
 * 2 s probes: under load the watchdog would kill the service it watches.
 */
export const layer = (resident: string, registration: string) =>
  Layer.effect(
    Resident,
    Effect.gen(function* () {
      const { answered } = asker(yield* HttpClient.HttpClient, registration, resident)
      return Resident.of({ load: answered(BOOT).pipe(Effect.asVoid) })
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer))
