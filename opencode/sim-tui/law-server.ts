// The client laws (client-laws.ts) over HTTP: a `LawServer` on any fetch that
// reaches an OpenCode server, its events read from the server's own stream
// (`GET /api/event`), and `real`, which boots the fork's embedded host (as its
// SDK does, keeping the host's fetch) and runs every law on it.
// tests/client-laws/real.ts calls `real` in a scratch home; it lives here, in
// sim-tui, because sim-tui resolves the fork's Effect, the one the host's
// Effects run on and the laws are written against.
import { Data, Effect, Option, Predicate, Schedule, Schema, Stream } from "effect"
import { type Answer, type Call, LAWS, type LawServer, LawServerError, type Sent } from "./client-laws.ts"
import type { ModelRef } from "./server.ts"

/** The origin the host's fetch answers on: any, as it serves no socket. */
const ORIGIN = "http://opencode.local"
/** A server has settled once it sent nothing for this long. */
const QUIET_MS = 1_500
/** The longest a settle waits for a server that keeps sending. */
const SETTLE_TIMES = 20

const Json = Schema.fromJsonString(Schema.Unknown)
const toJson = Schema.encodeSync(Json)
const Created = Schema.Struct({ data: Schema.Struct({ id: Schema.String }) })
const Event = Schema.fromJsonString(Schema.Struct({ type: Schema.String, data: Schema.Unknown }))
const SSE_DATA = "data:"

export interface HttpOptions {
  /** A fetch that reaches the server. */
  readonly fetch: (request: Request) => Promise<Response>
  /** Where the laws' sessions are made. */
  readonly directory: string
  /** The model a new session runs on. */
  readonly model: ModelRef
}

const requestOf = ({ method, path, body }: Call) =>
  new Request(
    `${ORIGIN}${path}`,
    Option.match(body, {
      onNone: () => ({ method }),
      onSome: (value) => ({ method, body: toJson(value), headers: { "content-type": "application/json" } }),
    }),
  )

/** A law server on `options.fetch`, reading the server's events until the scope closes. */
export const overHttp = (options: HttpOptions) =>
  Effect.gen(function* () {
    const sent: Array<Sent> = []
    const reach = (request: Request) =>
      Effect.tryPromise({
        try: () => options.fetch(request),
        catch: (cause) => new LawServerError({ message: `${request.method} ${new URL(request.url).pathname} did not answer`, cause }),
      })
    const call = (made: Call) =>
      Effect.gen(function* () {
        const response = yield* reach(requestOf(made))
        const text = yield* Effect.promise(() => response.text())
        const answer: Answer = { status: response.status, body: Option.flatMap(Option.liftPredicate(text, (value) => value !== ""), Schema.decodeUnknownOption(Json)) }
        return answer
      })

    const stream = yield* reach(new Request(`${ORIGIN}/api/event`, { headers: { accept: "text/event-stream" } }))
    const body = yield* Option.match(Option.fromNullishOr(stream.body), {
      onNone: () => Effect.fail(new LawServerError({ message: `the event stream answered ${stream.status} with no body` })),
      onSome: Effect.succeed,
    })
    yield* Stream.fromReadableStream({ evaluate: () => body, onError: (cause) => new LawServerError({ message: "the event stream broke", cause }) }).pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line.startsWith(SSE_DATA)),
      Stream.runForEach((line) =>
        Effect.sync(() => Option.map(Schema.decodeUnknownOption(Event)(line.slice(SSE_DATA.length).trim()), (event) => sent.push(event))),
      ),
      Effect.forkScoped,
    )

    const session = Effect.gen(function* () {
      const created = yield* call({ method: "POST", path: "/api/session", body: Option.some({ location: { directory: options.directory } }) })
      return yield* Option.match(Option.flatMap(created.body, Schema.decodeUnknownOption(Created)), {
        onNone: () => Effect.fail(new LawServerError({ message: `session.create answered ${created.status}: ${toJson(Option.getOrElse(created.body, () => ""))}` })),
        onSome: (found) => Effect.succeed(found.data.id),
      })
    })

    /** Waits until a quiet stretch passes with no event sent. */
    const settle = Effect.suspend(() => {
      const before = sent.length
      return Effect.sleep(QUIET_MS).pipe(
        Effect.flatMap(() => {
          if (sent.length === before) return Effect.void
          return Effect.fail(new Unsettled())
        }),
      )
    }).pipe(Effect.retry({ schedule: Schedule.recurs(SETTLE_TIMES) }), Effect.ignore)

    const server: LawServer = { session, call, sent: Effect.sync(() => sent), settle, model: options.model }
    return server
  })

/** A server still sending at the end of a quiet stretch. */
class Unsettled extends Data.TaggedError("Unsettled")<{}> {}

/** A law's outcome: its name and its failures, empty when it holds. */
export interface Outcome {
  readonly name: string
  readonly failures: ReadonlyArray<string>
}

/** Every law on `server`, in order; a law that could not run fails with what stopped it. */
export const runLaws = (server: LawServer) =>
  Effect.forEach(LAWS, (law) =>
    law.run(server).pipe(
      Effect.map((failures): Outcome => ({ name: law.name, failures })),
      Effect.catch((error) => Effect.succeed({ name: law.name, failures: [`the law did not run: ${error.message}`] })),
    ),
  )

/** As much of the fork's embedded host as `real` uses; the fork is found at run time, so it is typed here. */
interface Host {
  readonly fetch: (request: Request) => Promise<Response>
  readonly close: () => Promise<void>
}
interface HostModule {
  readonly EmbeddedHost: { readonly create: (options: RealOptions["create"]) => Effect.Effect<Host, unknown> }
}
const isHostModule = (value: Partial<HostModule>): value is HostModule => Predicate.isFunction(value.EmbeddedHost?.create)
const loadHost = (file: string): Promise<Partial<HostModule>> => import(file)

export interface RealOptions {
  /** The fork's checkout. */
  readonly fork: string
  /** The host's options, as the SDK's `OpenCode.create` takes them. */
  readonly create: {
    readonly events: { readonly persist: boolean }
    readonly config: { readonly directory: string; readonly project: boolean; readonly content: string }
  }
  readonly directory: string
  readonly model: ModelRef
}

/** Boots the fork's embedded host, runs every law on it and closes it. */
export const real = (options: RealOptions): Promise<ReadonlyArray<Outcome>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const module = yield* Effect.tryPromise({
        try: () => loadHost(`${options.fork}/packages/sdk/src/internal/host.ts`),
        catch: (cause) => new LawServerError({ message: "the fork's embedded host did not load", cause }),
      })
      if (!isHostModule(module)) return yield* new LawServerError({ message: "the fork's embedded host has no create" })
      const host = yield* Effect.acquireRelease(
        module.EmbeddedHost.create(options.create).pipe(Effect.mapError((cause) => new LawServerError({ message: "OpenCode did not start", cause }))),
        (started) => Effect.promise(() => started.close()),
      )
      const server = yield* overHttp({ fetch: host.fetch, directory: options.directory, model: options.model })
      return yield* runLaws(server)
    }).pipe(Effect.scoped),
  )
