// `ready(file, label)`: the fork's background service a test started, once it
// can serve.
//
// The service writes its file (`service-local.json` for a build from source)
// as soon as it listens, before it boots: until then every route but
// `/api/info` answers 503 `service_starting` with `retry-after`, and
// `/api/info` answers 503 too (500 once the boot failed). A test that calls
// the service on the file alone races the boot.
import { readFileSync } from "node:fs"

export interface Service {
  readonly url: string
  readonly password: string
}

const readService = (file: string): Service | undefined => {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<Service>
    return typeof value.url === "string" && typeof value.password === "string" ? { url: value.url, password: value.password } : undefined
  } catch {
    return undefined
  }
}

/**
 * A loopback port free now, for a scratch service's `service set port`.
 *
 * A service with no port set binds its channel's fixed default
 * (`service-config.ts` `defaultPort`: 0xC0DF, 49375, for a build from
 * source), whatever its HOME. Two scratch services in test files that run in
 * parallel then share one port: the second `service start` waits 15 s for the
 * port and exits 1 ("Managed service port … is already in use").
 */
export const freePort = (): number => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = server.port
  server.stop(true)
  if (port === undefined) throw new Error("no free loopback port")
  return port
}

/** What `/api/info` says of the boot, as the fork's own client reads it (packages/client/src/service-probe.ts `probeResult`). */
const probe = async (service: Service): Promise<"ready" | "waiting" | { failed: number }> => {
  const response = await fetch(new URL("/api/info", service.url), {
    headers: { authorization: `Basic ${btoa(`opencode:${service.password}`)}` },
    signal: AbortSignal.timeout(5_000),
  }).catch(() => undefined)
  if (response === undefined) return "waiting"
  await response.body?.cancel()
  if (response.ok) return "ready"
  return response.status === 500 ? { failed: response.status } : "waiting"
}

/**
 * The service in `file`, once its file is written and its `/api/info`
 * answers 200; a failed boot (500) throws at once. `label` names it in the
 * error, with the last thing seen at the deadline.
 */
export const ready = async (file: string, label: () => string, ms = 60_000): Promise<Service> => {
  const deadline = Date.now() + ms
  let seen = `no service file at ${file}`
  for (;;) {
    const service = readService(file)
    if (service !== undefined) {
      const state = await probe(service)
      if (state === "ready") return service
      if (state !== "waiting") throw new Error(`${label()}: the service failed to start (/api/info answered ${state.failed})`)
      seen = `${service.url} still starting`
    }
    if (Date.now() > deadline) throw new Error(`${label()}: ${seen}`)
    await Bun.sleep(250)
  }
}
