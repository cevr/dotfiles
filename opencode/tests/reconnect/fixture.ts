// What every reconnect-session*.test.ts file shares: a TUI attached to the
// background service keeps its session across a service restart. The owner's
// TUIs are `opencode -s <id>` on the service `daily` restarts on every
// install; the TUI reconnects by itself and must come back to the session it
// showed, not OpenCode's home page.
//
// The fork runs from source in a scratch HOME on a scripted model: the service
// starts and restarts through the CLI as daily does (`service start`, `service
// restart`), the TUI runs on a real pty (gamut's terminal host), and the test
// reads its screen. Each file builds its own world (`reconnectTest`): its own
// scratch HOME, service, scripted model and proxy, so the files run side by
// side. One file is one case group:
// - reconnect-session-<case>.test.ts: a restart under a root, a subagent, a root
//   whose turn the restart cuts, a service still booting, a draft in a TUI
//   opened while it boots, a service that refuses everything, and a worker
//   whose Rift is gone. After the restart the TUI shows the same session and
//   follows a turn sent on the new service.
// - reconnect-session-open.test.ts: a TUI opened while the service is down or
//   booting waits for it, says so, and opens its session.
// - reconnect-session.test.ts: the frame guard, and a TUI opened on a stopped or
//   restarting background service opens its session.
// - reconnect-session-select-<cache>.test.ts: a session selected from home while
//   the service boots, and a prompt submitted then, arrive.
//
// The booting case is the owner's report (a TUI back on the home page after an
// install's restart): a proxy in front of the service answers 503 for the
// session's GET for a few seconds after the restart, as a service still loading
// its plugins does. Before the fork's 0693cb3cd8 the TUI's reload failed once
// and it went home for good; now it keeps the session and tries again. Every
// terminal write is captured, not just the recovered screen: a short-lived
// fetch/503 toast is a failure too.
//
// The proxy can also go down (nothing listens on its port, so connections are
// refused, as in a restart's gap). A TUI opened with -s or --continue while the
// service is down or booting says it waits ("Waiting for the OpenCode server")
// and opens its session, where it used to exit with Bun's "Unable to connect.
// Is the computer able to access the url?" (the owner's 2026-11-11 report).
//
// What touches the platform (Bun, the process, files, the network) is in
// ./host.ts; this module is Effect over it.
import { expect } from "bun:test"
import { Cause, Clock, Data, Effect, Fiber, Option, Schedule, Schema, type Scope } from "effect"
import { Base64 } from "effect/encoding"
import { ROOT } from "../../scripts/reach.ts"
import { forkLaunch } from "../../testbeds/gamut/gamut.ts"
import { hostCall, serve } from "../../testbeds/gamut/pty-host.ts"
import type { Kept } from "../scratch.ts"
import { freePort, ready, type Service } from "../service.ts"
import { ENV, endsQuietly, files, importClient, listen, run, runCase, send, type Ran } from "./host.ts"

/** The describe every file's cases sit in, so the test names stay what the one file reported. */
export const SUITE = "a TUI on the background service across a service restart"
/** A case's own timeout: one restart, or one open, on a loaded host. */
export const TIMEOUT_MS = 180_000
/** What a case that runs out of time keeps of TIMEOUT_MS to stop its world (the service, the hosts). */
const CLOSE_MS = 15_000
/** The fork the files run, "" when OPENCODE_DEV is not set and they skip. */
export const FORK = ENV.fork
export { skipNotice } from "./host.ts"

const TUI_PLUGINS = ["prime", "status", "git", "cache", "questions", "btw", "skills", "recover", "orchestrate", "escape"]
const SERVER_PLUGINS = ["orchestrate", "guard", "kernel", "status", "queue", "git", "idle-compact", "questions", "skills", "rift", "tool-names", "cache", "web", "memory"]
/** How long the TUI has, after the restarted service can serve, to show its session again. */
const BACK_WITHIN_MS = 20_000
/** How long the booting case refuses the session after the restarted service can serve. */
const BOOTING_MS = 8_000
/**
 * How long a TUI has to start and draw: from source on a host the batch's
 * acceptance run fills, it took over 8 s. A window the TUI must see (a service
 * down or booting) opens once the TUI is up, never on the clock before it starts.
 */
const START_MS = 60_000
/**
 * How long a restarted service has to answer a prompt for a session: it answers once the
 * session's location has booted, and a location boots the server plugins again after a restart,
 * which took 20 s at a load of 45-115 (select-down's trace, 2026-11-12). The bound a test gives
 * a service to come up (tests/service.ts `ready`).
 */
const ANSWER_MS = 60_000
/**
 * How long a TUI opened on a ready service has to show its session, and one opened
 * on a down or booting service once the service serves: that service stays down or
 * booting until the TUI says it waits, then BOOTING_MS / 2 more.
 */
const SHOWS_WITHIN = { ready: START_MS, down: BACK_WITHIN_MS, booting: BACK_WITHIN_MS } as const
const WAITING = /Waiting for the OpenCode server/
/** OpenCode's home page: its prompt suggestions. */
const HOME = /Fix a TODO in the codebase|What is the tech stack of this project\?|Fix broken tests/
/** What a TUI that gives up on an unreachable or booting service shows. */
const GAVE_UP = /Could not reach|Unable to connect|did not provide|UnexpectedStatus|cli process failed/
/** How often a wait looks again. */
const LOOK_MS = 250
const LOOK = Schedule.spaced(`${LOOK_MS} millis`)

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/**
 * A transient error toast in a frame's rows, or none. ToastSurface lives at
 * top=1/right=2, at most 60 columns wide, with SplitBorder's vertical edges and an
 * `x` close affordance. Match that UI, not words in the transcript (a user can
 * legitimately discuss fetch errors).
 */
export const errorToast = (rows: ReadonlyArray<string>): Option.Option<string> => {
  const corner = rows
    .slice(1, 13)
    .map((row) => row.slice(56))
    .join("\n")
  return Option.liftPredicate(corner, (text) => /[┃│▏▕]/u.test(text) && /\bx\s*[┃│▏▕]/u.test(text) && /fetch|failed|error|service_starting|unavailable|503|retrying/i.test(text))
}

/** A wait whose condition never came, named with what was seen last. */
class TimedOut extends Data.TaggedError("TimedOut")<{ readonly message: string }> {}

/** A read that did not hold yet: what it saw. */
class NotYet<A> extends Data.TaggedError("NotYet")<{ readonly last: A }> {}

/**
 * The waits this file's case finished, each with what it took and the first line of the message
 * it would have failed with: what a case that runs out of its time names (`reconnectTest`).
 */
const trail: Array<string> = []

/** `effect`, its time kept in the trail under `label`. */
const timed = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const start = yield* Clock.currentTimeMillis
    const value = yield* effect
    const end = yield* Clock.currentTimeMillis
    trail.push(`${((end - start) / 1000).toFixed(1)} s: ${label}`)
    return value
  })

/** Reads `read` until `done` holds, every 250 ms for `ms`; past it, fails with `label` of the last read. */
const until = <A>(read: Effect.Effect<A>, done: (value: A) => boolean, label: (last: A) => string, ms: number) =>
  Effect.gen(function* () {
    const start = yield* Clock.currentTimeMillis
    const last = yield* read.pipe(
      Effect.filterOrFail(done, (seen) => new NotYet({ last: seen })),
      Effect.retry({ schedule: LOOK.pipe(Schedule.upTo({ duration: `${ms} millis` })), times: Math.ceil(ms / LOOK_MS) + 1 }),
      Effect.mapError((error) => new TimedOut({ message: label(error.last) })),
    )
    const end = yield* Clock.currentTimeMillis
    trail.push(`${((end - start) / 1000).toFixed(1)} s of ${ms / 1000} s: ${label(last).split("\n")[0]}`)
    return last
  })

/** Waits until the clock reaches `at`, at most `ms`. */
const reach = (at: number, label: string, ms: number) => until(Clock.currentTimeMillis, (now) => now >= at, () => label, ms)

/** Runs `check` every 250 ms for `ms`: a state that must hold all along, not just at the end. */
const holds = <E>(check: Effect.Effect<void, E>, ms: number) => check.pipe(Effect.repeat(LOOK.pipe(Schedule.upTo({ duration: `${ms} millis` }))), Effect.asVoid)

/** As much of the fork's client as the files use; the fork is found at run time, so it is typed here. */
interface Client {
  readonly session: {
    readonly create: (input: { location?: { directory: string }; parentID?: string; title?: string }) => Promise<{ readonly id: string }>
    readonly prompt: (input: { sessionID: string; text: string }) => Promise<object>
    readonly interrupt: (input: { sessionID: string }) => Promise<object>
  }
  readonly experimental: { readonly session: { readonly wait: (input: { sessionID: string }) => Promise<void> } }
}
interface ClientModule {
  readonly OpenCode: { readonly make: (options: { baseUrl: string; headers: { readonly authorization: string } }) => Client }
}

/** A message's content as the scripted model reads it: its text, or its parts' texts. */
const decodeText = Schema.decodeUnknownOption(Schema.String)
const decodeParts = Schema.decodeUnknownOption(Schema.Array(Schema.Struct({ text: Schema.optionalKey(Schema.String) })))
const ChatBody = Schema.Struct({ messages: Schema.optionalKey(Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.optionalKey(Schema.Unknown) }))) })
type Message = NonNullable<(typeof ChatBody.Type)["messages"]>[number]
const decodeBody = Schema.decodeUnknownOption(ChatBody)

const textOf = (message: Message) =>
  Option.getOrElse(
    Option.orElse(decodeText(message.content), () => Option.map(decodeParts(message.content), (parts) => parts.flatMap((part) => Option.toArray(Option.fromUndefinedOr(part.text))).join(""))),
    () => "",
  )

/** The scripted model: a title request gets a title, `say <word>` answers `<word>`. */
const answer = (messages: ReadonlyArray<Message>) => {
  const system = messages
    .values()
    .filter((message) => message.role === "system")
    .map(textOf)
    .toArray()
    .join("\n")
  if (system.includes("You name conversations")) return "Reconnect"
  const last = messages.slice(-1).map(textOf).join("")
  return Option.getOrElse(Option.flatMap(Option.fromNullishOr(/say (\S+)/.exec(last)), (match) => Option.fromNullishOr(match[1])), () => "ok")
}

const EVENT_STREAM = { "content-type": "text/event-stream", "cache-control": "no-cache" }
/** What a chunk adds to the answer. */
interface Delta {
  readonly role?: string
  readonly content?: string
}
/** A chunk of the answer; the last one says it stopped. */
const chunk = (delta: Delta, finish: Option.Option<"stop">) => ({ id: "sim", object: "chat.completion.chunk", created: 0, model: "sim", choices: [{ index: 0, delta, finish_reason: Option.getOrNull(finish) }] })
const USAGE = { id: "sim", object: "chat.completion.chunk", created: 0, model: "sim", choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }
const event = (value: ReturnType<typeof chunk> | typeof USAGE) => `data: ${toJson(value)}\n\n`

/** The scripted model's answer to one request; `prompts` gets the request's last message. */
const respond = (prompts: Array<string>, body: Option.Option<typeof ChatBody.Type>) => {
  const messages = Option.getOrElse(Option.flatMap(body, (decoded) => Option.fromUndefinedOr(decoded.messages)), () => [])
  const last = messages.slice(-1).map(textOf).join("")
  prompts.push(last)
  // `hold` keeps the turn running: the answer starts and never ends, so the restart cuts a working session.
  if (last.includes("hold")) {
    const head = new TextEncoder().encode(event(chunk({ role: "assistant", content: "holding" }, Option.none())))
    return new Response(new ReadableStream({ start: (controller) => controller.enqueue(head) }), { headers: EVENT_STREAM })
  }
  const events = [event(chunk({ role: "assistant", content: "" }, Option.none())), event(chunk({ content: answer(messages) }, Option.none())), event(chunk({}, Option.some("stop"))), event(USAGE), "data: [DONE]\n\n"]
  return new Response(events.join(""), { headers: EVENT_STREAM })
}

/** The scripted model's server and the last message of every request it took. */
const simModel = Effect.acquireRelease(
  Effect.sync(() => {
    const prompts: Array<string> = []
    const server = listen(0, (request) => {
      if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/chat/completions")) return Effect.succeed(new Response("not found", { status: 404 }))
      return Effect.promise(() => request.json()).pipe(Effect.map((body) => respond(prompts, decodeBody(body))))
    })
    return { server, prompts }
  }),
  ({ server }) => Effect.sync(server.stop),
)

/** A prompt a client sent through the proxy: its path and body. */
interface Submission {
  readonly path: string
  readonly body: string
}

/** The JSON body of a GET of `url`. */
const json = (url: URL, headers: Headers | { readonly authorization: string }) => send(url, { headers }).pipe(Effect.flatMap((response) => Effect.tryPromise(() => response.json())))

/** The service's info, as the proxy passes it on. */
const Fields = Schema.Record(Schema.String, Schema.Unknown)

const unavailable = () => Response.json({ code: "service_starting" }, { status: 503, headers: { "retry-after": "1" } })

/** The service the service file names now, once it can serve. */
const serviceIn = (file: string, label: string) => timed(`the service file names a service that serves (${label.split(" (")[0]})`, Effect.promise(() => ready(file, () => label)))

const authorization = (service: Service) => ({ authorization: `Basic ${Base64.encode(`opencode:${service.password}`)}` })

/** A prompt's path and body, when the request is one. */
const promptOf = (request: Request, url: URL) =>
  Effect.gen(function* () {
    if (request.method !== "POST" || !url.pathname.includes("/prompt")) return Option.none<Submission>()
    return Option.some({ path: url.pathname, body: yield* Effect.promise(() => request.clone().text()) })
  })

/**
 * A stand-in for a service still booting, in front of the service the service file
 * names now: it passes every request through, except, while it boots, every request
 * (`booting`) or a GET of a refused session (`refuse`), which it answers 503
 * `service_starting`; and `down` leaves nothing listening on its port until `up`. It
 * keeps the prompts clients sent (`submissions`) and those the service accepted
 * (`accepted`: answered 2xx).
 */
const bootingProxy = (serviceFile: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const refused = new Map<string, number>()
      const refusedRequests: Array<string> = []
      const submissions: Array<Submission> = []
      const accepted: Array<Submission> = []
      const state = { unavailableUntil: 0, fromFirstRequest: false, listening: true }
      /** The service's own answer while it boots: its info (version, pid and the starting code), or 503 for every other route. */
      const refuse = (request: Request, url: URL) =>
        Effect.gen(function* () {
          refusedRequests.push(`${request.method} ${url.pathname}`)
          if (request.method !== "GET" || url.pathname !== "/api/info") return unavailable()
          const service = yield* serviceIn(serviceFile, "the service")
          const info = yield* json(new URL("/api/info", service.url), request.headers).pipe(Effect.map(Schema.decodeUnknownSync(Fields)))
          return Response.json({ ...info, code: "service_starting" }, { status: 503, headers: { "retry-after": "1" } })
        }).pipe(Effect.orElseSucceed(unavailable))
      const pass = (request: Request, url: URL) =>
        Effect.gen(function* () {
          const prompt = yield* promptOf(request, url)
          submissions.push(...Option.toArray(prompt))
          const target = yield* serviceIn(serviceFile, "the service behind the proxy")
          const headers = new Headers(request.headers)
          headers.delete("host")
          const upstream = yield* send(new URL(url.pathname + url.search, target.url), { method: request.method, headers, body: request.body, signal: request.signal, redirect: "manual" })
          if (upstream.ok) accepted.push(...Option.toArray(prompt))
          // fetch hands back the body decoded; its encoding headers no longer describe it.
          const back = new Headers(upstream.headers)
          back.delete("content-encoding")
          back.delete("content-length")
          return new Response(endsQuietly(upstream), { status: upstream.status, headers: back })
        }).pipe(Effect.orElseSucceed(unavailable))
      const handle = (request: Request) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          if (state.fromFirstRequest) {
            state.fromFirstRequest = false
            state.unavailableUntil = now + BOOTING_MS
          }
          const url = new URL(request.url)
          const session = Option.fromNullishOr(/^\/api\/session\/([^/]+)$/.exec(url.pathname)).pipe(Option.flatMap((match) => Option.fromNullishOr(match[1])))
          const sessionRefused = request.method === "GET" && Option.exists(session, (id) => now < Option.getOrElse(Option.fromUndefinedOr(refused.get(id)), () => 0))
          if (now < state.unavailableUntil || sessionRefused) return yield* refuse(request, url)
          return yield* pass(request, url)
        })
      const first = listen(0, handle)
      const { port } = first
      const servers = [first]
      return {
        url: `http://127.0.0.1:${port}`,
        refusedRequests,
        submissions,
        accepted,
        /** Refuses the session's GET until `until`. */
        refuse: (sessionID: string, until: number) => refused.set(sessionID, until),
        /** Refuses every request until `until` (0: serves again). */
        bootingUntil: (until: number) => {
          state.unavailableUntil = until
        },
        /** Opens the booting window at the next request: a TUI opened while the service boots. */
        bootingFromFirstRequest: () => {
          state.fromFirstRequest = true
        },
        /** Nothing listens on the proxy's port until `up`: a client's connection is refused, as in a restart's gap. */
        down: () => {
          state.listening = false
          for (const server of servers.splice(0)) server.stop()
        },
        up: () => {
          if (state.listening) return
          servers.push(listen(port, handle))
          state.listening = true
        },
        stop: () => {
          for (const server of servers.splice(0)) server.stop()
        },
      }
    }),
    (proxy) => Effect.sync(proxy.stop),
  )
type Proxy = Effect.Success<ReturnType<typeof bootingProxy>>

/** A terminal host on a pty, stopped with the case's scope; `onFrame` sees every write's screen. */
const hosted = (socket: string, cwd: string, command: ReadonlyArray<string>, env: { readonly [name: string]: string }, onFrame: (rows: ReadonlyArray<string>) => void) =>
  Effect.gen(function* () {
    const [program = "", ...args] = command
    const host = yield* Effect.acquireRelease(
      Effect.sync(() => serve({ socket, cwd, command: [program, ...args], env, cols: 120, rows: 40 }, onFrame)),
      (served) => Effect.promise(() => served.stop()),
    )
    yield* until(
      Effect.sync(() => files.exists(socket)),
      Boolean,
      () => `${socket}: the terminal host`,
      10_000,
    )
    return host
  })

/** The screen of the host on `socket`, as one string. */
const screenOf = (socket: string) => Effect.promise(() => hostCall(socket, { op: "read", scope: "screen" })).pipe(Effect.map((screen) => screen.rows.join("\n")))

/** The frames a host wrote and the first error toast among them. */
const recorder = () => {
  const frames: Array<string> = []
  const toasts: Array<string> = []
  const record = (rows: ReadonlyArray<string>) => {
    const frame = rows.join("\n")
    if (frames.at(-1) !== frame) frames.push(frame)
    if (toasts.length === 0) toasts.push(...Option.toArray(errorToast(rows)))
  }
  return { frames, toasts, record }
}

/** One file's world: its scratch HOME, its service, its scripted model, its proxy and two sessions. */
export interface Fixture {
  readonly root: string
  readonly home: string
  /** The sessions' folder, its links resolved: the directory a TUI started there reports, so the session and the TUI share one location. */
  readonly work: string
  readonly serviceFile: string
  /** The TUI's command: the fork from source, or an installed old binary (OPENCODE_RECONNECT_TUI_BINARY). */
  readonly tui: ReadonlyArray<string>
  /** The TUI's environment (an old binary gets no BUN_OPTIONS of the fork's). */
  readonly tuiEnv: { readonly [name: string]: string }
  readonly opencode: (...args: ReadonlyArray<string>) => Effect.Effect<Ran>
  readonly client: Client
  readonly OpenCode: ClientModule["OpenCode"]
  readonly service: Effect.Effect<Service>
  readonly proxy: Proxy
  readonly prompts: ReadonlyArray<string>
  /** A root session with `parent-transcript-marker` in its transcript. */
  readonly parent: string
  /** A subagent of the parent with `child-transcript-marker` in its transcript. */
  readonly child: string
}

/** A session of its own with `marker` in its transcript, so no other case's turns scroll it away. */
export const transcript = (fixture: Fixture, title: string, marker: string, directory = fixture.work) =>
  Effect.gen(function* () {
    if (!files.exists(directory)) files.makeDir(directory)
    const made = yield* Effect.promise(() => fixture.client.session.create({ location: { directory }, title }))
    yield* Effect.promise(() => fixture.client.session.prompt({ sessionID: made.id, text: `say ${marker}` }))
    yield* Effect.promise(() => fixture.client.experimental.session.wait({ sessionID: made.id }))
    return made.id
  })

/** The scratch HOME's config: the scripted model and the owner's server and TUI plugins. */
const configure = (home: string, simPort: number) => {
  for (const dir of [home, `${home}/.config`, `${home}/.config/opencode`]) files.makeDir(dir)
  files.write(
    `${home}/.config/opencode/opencode.json`,
    toJson({
      model: "sim/sim-model",
      providers: {
        sim: {
          name: "Sim",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: `http://127.0.0.1:${simPort}/v1`, apiKey: "sim-key" },
          models: { "sim-model": { name: "Sim", capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 128_000, output: 16_000 } } },
        },
      },
      // The owner's server plugins that need no login, network listener or OS job.
      plugins: SERVER_PLUGINS.map((name) => [ROOT, "cmd", name].join("/")),
    }),
  )
  // The owner's TUI plugins, as daily writes them (herdr left out: it reports to a herdr socket).
  files.write(`${home}/.config/opencode/cli.json`, toJson({ plugins: [...TUI_PLUGINS.map((name) => [ROOT, "cmd", name].join("/")), "-opencode.btw"], session: { sidebar: "hide" }, theme: { name: "prime" } }))
}

/** Builds a file's world in `root`; its scope stops the service, the hosts, the model and the proxy. */
const fixture = (root: string) =>
  Effect.gen(function* () {
    const home = `${root}/home`
    files.makeDir(`${root}/work`)
    const work = files.real(`${root}/work`)
    const launch = forkLaunch(ENV.fork, ENV.bun)
    const scratchBinary = `${root}/opencode-old`
    if (ENV.binary !== "") files.copy(ENV.binary, scratchBinary)
    const tui = Option.match(Option.liftPredicate(ENV.binary, (each) => each !== ""), { onNone: () => launch.base, onSome: () => [scratchBinary] })
    const env = {
      PATH: ENV.path,
      HOME: home,
      TERM: "xterm-256color",
      // The owner's TUIs run in herdr panes, where OpenCode turns session tabs off.
      HERDR_ENV: "1",
      XDG_CONFIG_HOME: `${home}/.config`,
      XDG_DATA_HOME: `${home}/.local/share`,
      XDG_STATE_HOME: `${home}/.local/state`,
      XDG_CACHE_HOME: `${home}/.cache`,
      OPENCODE_DB: `${root}/opencode.db`,
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      ...launch.env,
    }
    const tuiEnv = { ...env, ...Object.fromEntries([["BUN_OPTIONS", ""]].filter(() => ENV.binary !== "")) }
    const serviceFile = `${home}/.local/state/opencode/service-local.json`
    /** The fork's CLI in the scratch HOME, run to its end. */
    const opencode = (...args: ReadonlyArray<string>) => timed(`opencode ${args.join(" ")}`, run([...launch.base, ...args], work, env))
    const sim = yield* simModel
    configure(home, sim.server.port)
    // A port of its own: the other test files' scratch services would share the channel's fixed one (tests/service.ts).
    expect(yield* opencode("service", "set", "port", String(freePort()))).toMatchObject({ code: 0 })
    const started = yield* Effect.acquireRelease(opencode("service", "start"), () => Effect.asVoid(Effect.when(opencode("service", "stop"), Effect.sync(() => files.exists(serviceFile)))))
    expect(started).toMatchObject({ code: 0 })
    const service = yield* serviceIn(serviceFile, `the service (${started.err.slice(-500)})`)
    const module = yield* importClient<ClientModule>(ENV.fork)
    const client = module.OpenCode.make({ baseUrl: service.url, headers: authorization(service) })
    const proxy = yield* bootingProxy(serviceFile)
    const base = { root, home, work, serviceFile, tui, tuiEnv, opencode, client, OpenCode: module.OpenCode, service: serviceIn(serviceFile, "the service"), proxy, prompts: sim.prompts }
    const parent = yield* transcript({ ...base, parent: "", child: "" }, "Reconnect parent", "parent-transcript-marker")
    const child = yield* Effect.promise(() => client.session.create({ parentID: parent, title: "Reconnect child" }))
    yield* Effect.promise(() => client.session.prompt({ sessionID: child.id, text: "say child-transcript-marker" }))
    yield* Effect.promise(() => client.experimental.session.wait({ sessionID: child.id }))
    return { ...base, parent, child: child.id } satisfies Fixture
  })

/**
 * A test body that builds the file's world in a fresh folder of `kept` and runs `body` in it;
 * the world is stopped when the body ends, passed or failed.
 */
export const reconnectTest = <E>(kept: Kept, body: (fixture: Fixture) => Effect.Effect<void, E, Scope.Scope>) =>
  // A short folder name: the terminal hosts' sockets live in it, and a socket path has at most 104 bytes on macOS.
  kept.test(() =>
    runCase(
      Effect.flatMap(fixture(kept.dir("w")), body).pipe(
        // Before bun's own timeout, so the message names how far the case got, and its world still stops.
        Effect.timeoutOrElse({
          duration: `${TIMEOUT_MS - CLOSE_MS} millis`,
          orElse: () => Effect.fail(new TimedOut({ message: `the case ran out of its ${(TIMEOUT_MS - CLOSE_MS) / 1000} s; the waits it finished, each with its time and its failure message:\n${trail.join("\n")}` })),
        }),
      ),
    ),
  )

/** How a restart case sets up its TUI and its service. */
export interface RestartCase {
  /** A turn runs when the service restarts. */
  readonly busy?: boolean
  /** A folder removed before the restart: the session's worktree is gone. */
  readonly gone?: string
  /** The restarted service refuses the session's GET for BOOTING_MS. */
  readonly booting?: boolean
  /** The restarted service refuses every request for BOOTING_MS. */
  readonly bootingAll?: boolean
  /** Text typed in the composer and not sent: the restart must not take it. */
  readonly draft?: boolean
  /** The TUI opens while the service still boots (an install restarted it a moment before). */
  readonly starting?: boolean
}

/** What a restart case does to its TUI before the restart: a turn left running, its folder removed, a draft typed. */
const beforeRestart = (
  fixture: Fixture,
  tui: { readonly name: string; readonly sessionID: string; readonly socket: string; readonly screen: Effect.Effect<string>; readonly draftText: string },
  options: { readonly busy: boolean; readonly gone: string; readonly draft: boolean },
) =>
  Effect.gen(function* () {
    const { name, sessionID, socket, screen, draftText } = tui
    if (options.busy) {
      yield* Effect.promise(() => fixture.client.session.prompt({ sessionID, text: "hold" }))
      yield* until(screen, (text) => text.includes("holding"), (last) => `${name}: the turn never started:\n${last}`, 30_000)
    }
    if (options.gone !== "") files.remove(options.gone)
    if (options.draft) {
      yield* Effect.promise(() => hostCall(socket, { op: "type", text: draftText }))
      yield* until(screen, (text) => text.includes(draftText), (last) => `${name}: the draft never showed:\n${last}`, 10_000)
    }
  })

/** The folder of the gone case's worker: its Rift, removed before the restart. */
export const riftOf = (fixture: Fixture) => `${fixture.root}/rift`

/** `--server` through the proxy, when the case reaches the service through it. */
const viaProxy = (explicit: boolean, proxy: Proxy) => [["--server", proxy.url]].filter(() => explicit).flat()

/**
 * A TUI on `session` shows `marker`; the service restarts (`opencode service restart`);
 * the TUI shows the session again within BACK_WITHIN_MS of the service serving, follows a
 * turn sent on the new service, never shows home, and never an error toast.
 */
export const restart = (fixture: Fixture, name: string, session: Effect.Effect<string>, marker: string, options: RestartCase = {}) =>
  Effect.gen(function* () {
    const { busy = false, gone = "", booting = false, bootingAll = false, draft = false, starting = false } = options
    const { proxy } = fixture
    proxy.bootingUntil(0)
    const sessionID = yield* session
    const socket = `${fixture.root}/${name}.sock`
    // A herdr pane's directory need not be the session's: the TUI starts in the HOME.
    // A booting service is the proxy in front of it: the TUI reaches the service through it.
    const explicit = booting || bootingAll || starting || ENV.binary !== ""
    const service = yield* fixture.service
    const password = Object.fromEntries([["OPENCODE_PASSWORD", service.password]].filter(() => explicit))
    const seen = recorder()
    const recording = { on: false }
    // Opened while the service still boots: the TUI waits for it.
    if (starting) proxy.bootingFromFirstRequest()
    yield* hosted(socket, fixture.home, [...fixture.tui, ...viaProxy(explicit, proxy), "-s", sessionID], { ...fixture.tuiEnv, ...password }, (rows) => {
      if (recording.on) seen.record(rows)
    })
    const screen = screenOf(socket).pipe(Effect.tap(() => Effect.sync(() => expect(seen.toasts, `${name}: error toast during restart`).toEqual([]))))
    const showing = (text: string) => text.includes(marker)
    yield* until(screen, showing, (last) => `${name}: the TUI never showed ${marker}:\n${last}`, START_MS)
    const draftText = `${name}-unsent-draft-marker`
    yield* beforeRestart(fixture, { name, sessionID, socket, screen, draftText }, { busy, gone, draft })

    const before = yield* pid(service)
    recording.on = true
    if (booting) proxy.refuse(sessionID, Number.POSITIVE_INFINITY)
    if (bootingAll) proxy.bootingUntil(Number.POSITIVE_INFINITY)
    const restarted = yield* fixture.opencode("service", "restart")
    expect(restarted).toMatchObject({ code: 0 })
    // The new service still refuses the session for a while, as one still loading its plugins does,
    // or every request, its event stream and info too, as the service does until its routes are built.
    const servesAt = (yield* Clock.currentTimeMillis) + BOOTING_MS * Number(booting || bootingAll)
    if (booting) proxy.refuse(sessionID, servesAt)
    if (bootingAll) proxy.bootingUntil(servesAt)
    const after = yield* serviceIn(fixture.serviceFile, `the restarted service (${restarted.err.slice(-500)})`)
    // A new service process, not the old one answering.
    expect((yield* pid(after)).pid).not.toBe(before.pid)
    // Every deadline after this runs from when the TUI can be served again.
    yield* reach(servesAt, `${name}: the booting window`, BOOTING_MS + 1_000)
    yield* until(screen, showing, (last) => `${name}: ${BACK_WITHIN_MS / 1000}s after the restart the TUI does not show ${marker}:\n${last}`, BACK_WITHIN_MS)
    if (draft) yield* until(screen, (text) => text.includes(draftText) && showing(text), (last) => `${name}: the draft is gone after the restart:\n${last}`, BACK_WITHIN_MS)
    if (gone !== "") {
      // Nothing can run there now; the session stays on screen, and stays.
      yield* holds(
        screen.pipe(Effect.map((text) => expect(showing(text), `${name}: the session left the screen:\n${text}`).toBe(true))),
        5_000,
      )
      expect(seen.toasts, `${name}: error toast during restart`).toEqual([])
      return
    }
    // And it is live on the new service: a turn sent there shows up, so the screen is not a stale frame.
    const live = fixture.OpenCode.make({ baseUrl: after.url, headers: authorization(after) })
    if (busy) yield* Effect.ignore(Effect.tryPromise(() => live.session.interrupt({ sessionID })))
    yield* Effect.promise(() => live.session.prompt({ sessionID, text: `say ${name}-after-restart` }))
    yield* until(screen, (text) => text.includes(`${name}-after-restart`) && showing(text), (last) => `${name}: the TUI does not follow the session on the new service:\n${last}`, BACK_WITHIN_MS)
    expect(seen.frames.length, `${name}: captured restart frames`).toBeGreaterThan(0)
    expect(
      seen.frames.filter((frame) => HOME.test(frame)),
      `${name}: went home during restart`,
    ).toEqual([])
    expect(seen.toasts, `${name}: error toast during restart`).toEqual([])
  })

const Info = Schema.Struct({ pid: Schema.optionalKey(Schema.Number) })
/** The service's process id, as its `/api/info` says. */
const pid = (service: Service) => json(new URL("/api/info", service.url), authorization(service)).pipe(Effect.map(Schema.decodeUnknownSync(Info)), Effect.orDie)

/** How a TUI is opened while the service cannot serve: down (nothing listens), booting (503 to every request) or ready. */
interface Open {
  readonly name: string
  readonly args: ReadonlyArray<string>
  readonly mode: "down" | "booting" | "ready"
  readonly cwd: string
  readonly shows: RegExp
}

/**
 * Each case opens a TUI through a proxy of its own (so the cases run side by side): one
 * opened while the service is down or booting says it waits, keeps waiting while the
 * service cannot serve, and opens its session once it serves; one opened on a directory
 * with nothing to continue shows home. Every case runs, so one red names all that fail.
 */
export const openWhileDown = (fixture: Fixture) =>
  Effect.gen(function* () {
    // fixture.work is the directory the TUI's process sees (macOS's /var is /private/var), so --continue finds it there.
    const opened = fixture.work
    const target = yield* transcript(fixture, "Reconnect opened", "opened-transcript-marker", opened)
    // A directory with no session: --continue has none to open there.
    const empty = `${fixture.root}/empty`
    files.makeDir(empty)
    const shows = /opened-transcript-marker/
    const cases: ReadonlyArray<Open> = [
      { name: "open-down", args: ["-s", target], mode: "down", cwd: opened, shows },
      { name: "continue-down", args: ["--continue"], mode: "down", cwd: opened, shows },
      { name: "open-booting", args: ["-s", target], mode: "booting", cwd: opened, shows },
      { name: "continue-booting", args: ["--continue"], mode: "booting", cwd: opened, shows },
      // Nothing to continue: home, not a blank session screen.
      { name: "continue-empty", args: ["--continue"], mode: "ready", cwd: empty, shows: HOME },
    ]
    const service = yield* fixture.service
    const open = ({ name, args, mode, cwd, shows: expected }: Open) =>
      Effect.scoped(
        Effect.gen(function* () {
          const proxy = yield* bootingProxy(fixture.serviceFile)
          if (mode === "down") proxy.down()
          if (mode === "booting") proxy.bootingUntil(Number.POSITIVE_INFINITY)
          const socket = `${fixture.root}/${name}.sock`
          const seen = recorder()
          yield* hosted(socket, cwd, [...fixture.tui, "--server", proxy.url, ...args], { ...fixture.tuiEnv, OPENCODE_PASSWORD: service.password }, seen.record)
          const screen = screenOf(socket)
          // While the service cannot serve, the terminal says the TUI waits for it, and goes on waiting; a TUI that gives up says so at once.
          if (mode !== "ready") {
            const said = yield* until(screen, (text) => WAITING.test(text) || GAVE_UP.test(text), (last) => `${name}: no waiting line while the service cannot serve:\n${last}`, START_MS)
            expect(said, `${name}: no waiting line while the service cannot serve`).toMatch(WAITING)
            yield* holds(
              screen.pipe(Effect.map((text) => expect(text, `${name}: gave up while the service could not serve`).not.toMatch(GAVE_UP))),
              BOOTING_MS / 2,
            )
            proxy.up()
            proxy.bootingUntil(0)
          }
          yield* until(screen, (text) => expected.test(text), (last) => `${name}: the TUI never showed ${expected}:\n${last}`, SHOWS_WITHIN[mode])
          expect(
            seen.frames.filter((frame) => GAVE_UP.test(frame)),
            `${name}: a failure in any frame`,
          ).toEqual([])
          expect(seen.toasts, `${name}: error toast while the service could not serve`).toEqual([])
        }),
      ).pipe(
        Effect.matchCause({
          onSuccess: () => [],
          onFailure: (cause) => [Cause.pretty(cause).replace(/\n\s*\n+/g, "\n").slice(0, 1_500)],
        }),
      )
    const failures = yield* Effect.forEach(cases, open, { concurrency: cases.length })
    expect(failures.flat()).toEqual([])
  })

/**
 * No --server: a TUI finds the service the way the owner's panes do, by its registration.
 * Stopped, the TUI starts the service and says so; opened while `service restart` stops the
 * service and starts the next one, it opens its session as well.
 */
export const openManaged = (fixture: Fixture) =>
  Effect.gen(function* () {
    const target = yield* transcript(fixture, "Reconnect managed", "managed-transcript-marker")
    const open = (name: string, meanwhile: Effect.Effect<void>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const pending = yield* Effect.forkScoped(meanwhile)
          const socket = `${fixture.root}/${name}.sock`
          const seen = recorder()
          yield* hosted(socket, fixture.home, [...fixture.tui, "-s", target], fixture.tuiEnv, seen.record)
          yield* until(screenOf(socket), (text) => text.includes("managed-transcript-marker"), (last) => `${name}: the TUI never opened its session:\n${last}`, 60_000)
          yield* Fiber.join(pending)
          expect(
            seen.frames.filter((frame) => GAVE_UP.test(frame)),
            `${name}: a failure in any frame`,
          ).toEqual([])
          expect(seen.toasts, `${name}: error toast while the service could not serve`).toEqual([])
          return seen.frames
        }),
      )
    expect(yield* fixture.opencode("service", "stop")).toMatchObject({ code: 0 })
    const stopped = yield* open("managed-stopped", Effect.void)
    expect(
      stopped.some((frame) => /Starting background server|Waiting for the OpenCode server/.test(frame)),
      "managed-stopped: no line while the service started",
    ).toBe(true)
    yield* serviceIn(fixture.serviceFile, "the service the TUI started")
    yield* open(
      "managed-restarting",
      fixture.opencode("service", "restart").pipe(Effect.map((ran) => expect(ran).toMatchObject({ code: 0 }))),
    )
    yield* serviceIn(fixture.serviceFile, "the restarted service")
  })

/** The leader, then `key`, until `opened` shows; a leader the TUI dropped (the key typed as text) is erased and sent again, at most three times. */
const chord = (socket: string, screen: Effect.Effect<string>, key: string, opened: RegExp, label: string) => {
  const typed = new RegExp(`┃ ${key}\\s*$`, "m")
  const attempt = (count: number): Effect.Effect<void, TimedOut> =>
    Effect.gen(function* () {
      yield* Effect.promise(() => hostCall(socket, { op: "keys", names: ["ctrl+x"] }))
      yield* Effect.promise(() => hostCall(socket, { op: "type", text: key }))
      const seen = yield* until(screen, (text) => opened.test(text) || typed.test(text), (last) => `${label} did not open:\n${last}`, 20_000)
      if (opened.test(seen)) return
      expect(count, `${label}: the TUI took the chord's ${key} as text ${count} times:\n${seen}`).toBeLessThan(3)
      yield* Effect.promise(() => hostCall(socket, { op: "keys", names: ["backspace"] }))
      yield* attempt(count + 1)
    })
  return attempt(1)
}

/** Whether `prompts` holds the prompt to `sessionID` that says `marker`. */
const holdsPrompt = (prompts: ReadonlyArray<Submission>, sessionID: string, marker: string) =>
  prompts.some((prompt) => prompt.path === `/api/session/${sessionID}/prompt` && prompt.body.includes(marker))

/**
 * The prompt a pane submitted during the boot arrives: the proxy passes it to the service, the
 * service accepts it (it answers once the session's location has booted, ANSWER_MS), and the
 * model gets it.
 */
const promptArrives = (fixture: Fixture, marker: string) =>
  Effect.gen(function* () {
    const { proxy, parent } = fixture
    yield* until(
      Effect.sync(() => proxy.submissions),
      (sent) => holdsPrompt(sent, parent, marker),
      (last) => `the boot-time prompt never reached ${parent}:\n${toJson(last)}`,
      BACK_WITHIN_MS,
    )
    yield* until(
      Effect.sync(() => proxy.accepted),
      (taken) => holdsPrompt(taken, parent, marker),
      () => `the service never accepted the boot-time prompt to ${parent} in ${ANSWER_MS / 1000}s`,
      ANSWER_MS,
    )
    yield* until(
      Effect.sync(() => fixture.prompts),
      (prompts) => prompts.some((prompt) => prompt.includes(marker)),
      () => "the session never sent the boot-time prompt to its model",
      BACK_WITHIN_MS,
    )
  })

/**
 * A pane at home selects the parent from its session picker while the service boots (503 to every
 * request), and a prompt is submitted: `cached`, the pane visited the session first, so its composer
 * takes the prompt during the boot; `uncached`, it waits for the session, then submits; `down`,
 * nothing listens when the selection is made, then the service comes back still booting. The prompt
 * reaches the session and its model, and no frame shows an error toast.
 */
export const selectWhileBooting = (fixture: Fixture, cache: "cached" | "uncached" | "down") =>
  Effect.gen(function* () {
    const { proxy } = fixture
    const service = yield* fixture.service
    const socket = `${fixture.root}/open-booting-${cache}.sock`
    const seen = recorder()
    const visit = [["-s", fixture.parent]].filter(() => cache !== "uncached").flat()
    yield* hosted(socket, fixture.work, [...fixture.tui, "--server", proxy.url, ...visit], { ...fixture.tuiEnv, OPENCODE_PASSWORD: service.password }, seen.record)
    const screen = screenOf(socket).pipe(Effect.tap(() => Effect.sync(() => expect(seen.toasts, "error toast opening/submitting during boot").toEqual([]))))
    // Visit first so a returning home pane has cached session metadata and
    // its composer can accept input before the boot-time reload completes.
    if (cache !== "uncached") {
      yield* until(screen, (text) => text.includes("Reconnect parent") && text.includes("sim-model"), (last) => `session did not load before going home:\n${last}`, START_MS)
      yield* chord(socket, screen, "n", HOME, "home")
    }
    yield* until(screen, (text) => HOME.test(text), (last) => `home did not load:\n${last}`, 20_000)
    yield* chord(socket, screen, "l", /\bSessions\b/, "session picker")
    if (/all projects\s+ctrl\+a/.test(yield* screen)) yield* Effect.promise(() => hostCall(socket, { op: "keys", names: ["ctrl+a"] }))
    yield* until(screen, (text) => text.includes("Reconnect parent"), (last) => `session picker has no parent row:\n${last}`, 20_000)
    yield* Effect.promise(() => hostCall(socket, { op: "type", text: "Reconnect parent" }))
    yield* until(screen, (text) => text.split("Reconnect parent").length >= 3, (last) => `filtered session picker has no parent row:\n${last}`, 20_000)
    // The service boots (503 to every request) until the TUI has made its selection, and submitted from the cached composer.
    proxy.bootingUntil(Number.POSITIVE_INFINITY)
    expect(yield* fixture.opencode("service", "restart")).toMatchObject({ code: 0 })
    yield* serviceIn(fixture.serviceFile, "service behind booting proxy")
    const beforeRefusals = proxy.refusedRequests.length
    // Down: nothing listens when the selection is made; the service comes back after a while, still booting.
    if (cache === "down") proxy.down()
    yield* Effect.promise(() => hostCall(socket, { op: "keys", names: ["enter"] }))
    yield* until(screen, (text) => /Connection lost|Reconnecting to the server/.test(text) || (!/\bSessions\b/.test(text) && /sim-model/.test(text)), (last) => `selection did not leave the picker or wait for reconnection:\n${last}`, BACK_WITHIN_MS)
    const marker = `opened-during-boot-${cache}-marker`
    const submit = Effect.promise(() => hostCall(socket, { op: "type", text: `say ${marker}` })).pipe(Effect.andThen(Effect.promise(() => hostCall(socket, { op: "keys", names: ["enter"] }))))
    if (cache !== "uncached") yield* submit
    const servesAt = (yield* Clock.currentTimeMillis) + BOOTING_MS
    proxy.bootingUntil(servesAt)
    // Half the booting window in, the proxy listens again.
    yield* Effect.forkScoped(reach(servesAt - BOOTING_MS / 2, "half the booting window", BOOTING_MS).pipe(Effect.andThen(Effect.sync(proxy.up))))
    yield* reach(servesAt, "the booting window", BOOTING_MS + 1_000)
    if (cache === "uncached") {
      yield* until(screen, (text) => text.includes("Reconnect parent") && text.includes("sim-model") && !/\bSessions\b|Connection lost|Reconnecting to the server/.test(text), (last) => `uncached selection did not wait for its session:\n${last}`, BACK_WITHIN_MS)
      yield* submit
    }
    // Earlier transcript text can scroll off screen as turns accumulate.
    // The stable header and the session-specific admission prove identity.
    yield* until(screen, (text) => text.includes(marker) && text.includes("Reconnect parent"), (last) => `opening/submitting during boot did not recover:\n${last}`, BACK_WITHIN_MS)
    yield* promptArrives(fixture, marker)
    expect(proxy.refusedRequests.slice(beforeRefusals).length, "selection really crossed the 503 window").toBeGreaterThan(0)
    expect(seen.toasts, "error toast opening/submitting during boot").toEqual([])
  })
