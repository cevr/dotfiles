// What an OS job does when it fires: reach the OpenCode service, starting it
// when none answers, and ask the entry's server to fire it (the wakes' `due`
// RPC). The server stays the one that delivers: it holds the entry and its
// recorded fire, so a job that fires while the server's own timer did (or
// after the entry went) delivers nothing twice, and the server removes the job
// once the entry fired or went. The job runs with a bare environment, so its
// descriptor carries the `opencode` launcher by path and the variables that
// say where OpenCode keeps its state and config.
//
// Why the RPC, not `opencode run --session`: `run` would add a user prompt of
// its own, under an id the entry never recorded, so a fire the server's timer
// also sent would arrive twice, and the entry would never learn it fired.
//
// Where each fact comes from, in the fork:
// - the service file: `${XDG_STATE_HOME ?? ~/.local/state}/opencode/service.json`,
//   `{ url, pid, password }` (packages/client/src/service-probe.ts `fallback`).
// - the probe: `GET {url}/api/info` with Basic auth `opencode:<password>`
//   (service-probe.ts `probeResult`).
// - the call: `POST {url}/api/rpc/<id>/<method>?location[directory]=<dir>` with
//   body `{ input }`, answered `{ output }` (packages/client/src/promise/generated/client.ts:2258-2270, 2787-2800).
// - starting: `opencode service start` registers and starts the background
//   service. It runs only when nothing answers: with a version check it could
//   replace a service already running.
import path from "node:path"
import { Duration, Effect, Option, Schema } from "effect"
import type { Descriptor } from "../backstop.ts"
import { Due, WAKES } from "../wake.ts"

/** The job could not reach a server to fire through; `message` says how far it got. */
export class BackstopUnreached extends Schema.TaggedError<BackstopUnreached>()("BackstopUnreached", { message: Schema.String }) {}

/** An HTTP answer: its status and parsed body (undefined when it was not JSON). */
export interface Answer {
  readonly status: number
  readonly body: unknown
}

/** The outside world as a job sees it. Each never fails: a file that cannot be read is undefined, a request that got no answer is undefined. */
export interface Reach {
  readonly readText: (file: string) => Effect.Effect<string | undefined>
  readonly request: (url: string, init: { readonly method: "GET" | "POST"; readonly headers: Record<string, string>; readonly body?: string }) => Effect.Effect<Answer | undefined>
  readonly exec: (argv: ReadonlyArray<string>, env: Record<string, string>) => Effect.Effect<{ readonly exitCode: number; readonly output: string }>
}

/** How the job went: whether it had to start OpenCode, where it reached it, and what the server said. */
export interface Report {
  readonly started: boolean
  readonly url: string
  readonly outcome: Due["outcome"]
}

export interface Timing {
  /** How long a started service has to answer. */
  readonly startMs: number
  /** How long the server has to answer the call, while its directory's instance boots. */
  readonly callMs: number
  readonly pollMs: number
}

export const TIMING: Timing = { startMs: 60_000, callMs: 60_000, pollMs: 500 }

const Service = Schema.Struct({ url: Schema.String, password: Schema.optional(Schema.String) })
type Service = typeof Service.Type
const decodeService = Schema.decodeUnknownOption(Schema.fromJsonString(Service))
const decodeOutput = Schema.decodeUnknownOption(Schema.Struct({ output: Due }))

/** The service file the descriptor's environment names. */
export const serviceFile = (env: Readonly<Record<string, string>>): string =>
  path.join(env.XDG_STATE_HOME ?? path.join(env.HOME ?? "", ".local", "state"), "opencode", "service.json")

/** The environment `opencode service start` runs in: the descriptor's, and a PATH that finds the launcher and bun. */
export const environmentOf = (descriptor: Descriptor): Record<string, string> => ({
  PATH: [path.dirname(descriptor.opencode), ...(descriptor.env.HOME === undefined ? [] : [path.join(descriptor.env.HOME, ".bun", "bin")]), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
  ...descriptor.env,
})

const headersOf = (service: Service): Record<string, string> => ({
  "content-type": "application/json",
  ...(service.password === undefined ? {} : { authorization: `Basic ${btoa(`opencode:${service.password}`)}` }),
})

/** The registered service when it answers. */
const find = (reach: Reach, file: string) =>
  Effect.gen(function* () {
    const text = yield* reach.readText(file)
    const service = text === undefined ? Option.none<Service>() : decodeService(text)
    if (Option.isNone(service)) return undefined
    const answer = yield* reach.request(new URL("/api/info", service.value.url).toString(), { method: "GET", headers: headersOf(service.value) })
    return answer?.status === 200 ? service.value : undefined
  })

/** `body` until it gives something, every `pollMs` for `ms`. */
const poll = <A,>(body: Effect.Effect<A | undefined>, ms: number, pollMs: number): Effect.Effect<A | undefined> =>
  Effect.gen(function* () {
    const tries = Math.max(1, Math.ceil(ms / pollMs))
    for (let attempt = 0; attempt < tries; attempt += 1) {
      const found = yield* body
      if (found !== undefined) return found
      yield* Effect.sleep(Duration.millis(pollMs))
    }
    return undefined
  })

export const fire = (descriptor: Descriptor, reach: Reach, timing: Timing = TIMING) =>
  Effect.gen(function* () {
    const file = serviceFile(descriptor.env)
    let service = yield* find(reach, file)
    let started = false
    if (service === undefined) {
      const ran = yield* reach.exec([descriptor.opencode, "service", "start"], environmentOf(descriptor))
      started = true
      service = yield* poll(find(reach, file), timing.startMs, timing.pollMs)
      if (service === undefined)
        return yield* new BackstopUnreached({ message: `no OpenCode service answered, and \`${descriptor.opencode} service start\` exited ${ran.exitCode}: ${ran.output.trim()}` })
    }
    const reached = service
    const query = new URLSearchParams({ "location[directory]": descriptor.directory })
    const url = `${reached.url.replace(/\/$/, "")}/api/rpc/${encodeURIComponent(WAKES.id)}/due?${query.toString()}`
    const call = reach.request(url, { method: "POST", headers: headersOf(reached), body: JSON.stringify({ input: { id: descriptor.id } }) }).pipe(
      Effect.map((answer) => (answer?.status === 200 ? Option.getOrUndefined(decodeOutput(answer.body)) : undefined)),
    )
    const answered = yield* poll(call, timing.callMs, timing.pollMs)
    if (answered === undefined) return yield* new BackstopUnreached({ message: `the service at ${reached.url} did not answer the wakes' due call for ${descriptor.id}` })
    return { started, url: reached.url, outcome: answered.output.outcome } satisfies Report
  })

/** The real world: files, fetch, and child processes. */
export const live: Reach = {
  readText: (file) =>
    Effect.tryPromise(() => Bun.file(file).text()).pipe(Effect.orElseSucceed(() => undefined)),
  request: (url, init) =>
    Effect.tryPromise(async () => {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) })
      const text = await response.text()
      const body = (() => {
        try {
          return JSON.parse(text) as unknown
        } catch {
          return undefined
        }
      })()
      return { status: response.status, body }
    }).pipe(Effect.orElseSucceed(() => undefined)),
  exec: (argv, env) =>
    Effect.tryPromise(async () => {
      const child = Bun.spawn([...argv], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      return { exitCode, output: `${stdout}${stderr}` }
    }).pipe(Effect.orElseSucceed(() => ({ exitCode: 127, output: `${argv[0] ?? ""} did not start` }))),
}
