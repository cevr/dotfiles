// The digest page's listener: a small HTTP server of the digest plugin's own on 127.0.0.1 (loopback only in this
// unit; the tailnet address and its pairing are later units), serving the page's built files (page/dist, committed)
// and the view as JSON, and taking the owner's marks.
//
// - GET `/` and `/assets/<name>`: the built files, by exact name inside `dist`; no other path reads the disk.
// - GET `/view.json`: the view (view.ts), fresh from the log and the marks at each request.
// - POST `/api/mark` {id, mark: read | unread}, `/api/later` {id}, `/api/name` {project, name}, `/api/since` {}:
//   one marks line each (marks.ts). A write is a POST of JSON whose Origin is the page's own and which carries
//   PAGE_HEADER; anything else is refused and writes nothing. No GET changes state.
// - Every request must name a loopback host (`Host`), so a name rebound to 127.0.0.1 reads nothing.
//
// OpenCode serves a plugin once per directory it serves, and only one instance can bind the port: the others try
// again every RETRY (`serve`), so one listens while any instance runs, and a restart hands the port over.
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { Duration, Effect, Match, Option, Schedule, Schema, type Scope } from "effect"
import { type MarkLine, markOf, nameOf, sinceOf } from "../marks.ts"
import { nextMorning } from "../zone.ts"

/** The only address this unit binds. */
export const HOSTNAME = "127.0.0.1"
/** The page's port on every host. */
export const PORT = 8240
/** How long an instance waits before it tries the port again. */
export const RETRY = Duration.seconds(30)
/** How many times it tries before it gives up and logs it: a week of tries, longer than any server lives. */
export const WAIT_TRIES = 20_160
/** The header the page sends on every write; a form or a link from another site cannot. */
export const PAGE_HEADER = "x-digest-page"
/** A project name's most characters. */
export const NAME_MAX = 80

/** What the listener answers with. */
export interface Handlers {
  /** The view, as JSON; a failure is shown to the page as its message. */
  readonly view: Effect.Effect<string, { readonly message: string }>
  /** Keep one marks line. */
  readonly write: (line: MarkLine) => Effect.Effect<void, { readonly message: string }>
  readonly now: Effect.Effect<number>
  /** `digest.timezone`: Later's morning is in it. */
  readonly zone: string
}

/** An answer: status, headers, body. */
interface Answer {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: string | Blob
}

const SECURITY = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
}

const TYPES: ReadonlyArray<readonly [string, string]> = [
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
]

const answer = (status: number, body: string | Blob, headers: Readonly<Record<string, string>> = {}): Answer => ({ status, body, headers: { ...SECURITY, ...headers } })

const encodeReason = Schema.encodeSync(Schema.fromJsonString(Schema.Struct({ reason: Schema.String })))

const reason = (status: number, text: string): Answer => answer(status, encodeReason({ reason: text }), { "content-type": "application/json", "cache-control": "no-store" })

/** A built file's name: letters, digits, dots, dashes and underscores, not starting with a dot. */
const SAFE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/

/** The built file `name` of `folder` in `dist`, with its type; 404 for any name that is not one plainly. */
const builtFile = (dist: string, folder: string, name: string, cache: string) =>
  Option.match(
    Option.flatMap(Option.liftPredicate(name, (each) => SAFE_NAME.test(each)), (safe) => Option.map(Option.fromUndefinedOr(TYPES.find(([ext]) => safe.endsWith(ext))), ([, type]) => ({ safe, type }))),
    {
      onNone: () => Effect.succeed(reason(404, "no such file")),
      onSome: ({ safe, type }) =>
        Effect.tryPromise(() => readFile(join(dist, folder, safe))).pipe(
          Effect.map((bytes) => answer(200, new Blob([bytes]), { "content-type": type, "cache-control": cache })),
          Effect.orElseSucceed(() => reason(404, "no such file")),
        ),
    },
  )

/** A loopback host as a `Host` header names it, with or without a port. */
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost)(:\d{1,5})?$/

const MarkInput = Schema.Struct({ id: Schema.NonEmptyString, mark: Schema.Literals(["read", "unread"]) })
const LaterInput = Schema.Struct({ id: Schema.NonEmptyString })
const NameInput = Schema.Struct({ project: Schema.NonEmptyString, name: Schema.String.check(Schema.isMaxLength(NAME_MAX)) })
const SinceInput = Schema.Struct({})

const decodeMark = Schema.decodeUnknownOption(Schema.fromJsonString(MarkInput))
const decodeLater = Schema.decodeUnknownOption(Schema.fromJsonString(LaterInput))
const decodeName = Schema.decodeUnknownOption(Schema.fromJsonString(NameInput))
const decodeSince = Schema.decodeUnknownOption(Schema.fromJsonString(SinceInput))

/** The marks line a write route makes of its body at `now`; none for a malformed body or no such route. */
const lineOf = (path: string, body: string, now: number, zone: string): Option.Option<Option.Option<MarkLine>> =>
  Match.value(path).pipe(
    Match.when("/api/mark", () => Option.some(Option.map(decodeMark(body), (input) => markOf(input.id, now, input.mark)))),
    Match.when("/api/later", () => Option.some(Option.map(decodeLater(body), (input) => markOf(input.id, now, "later", Option.some(nextMorning(now, zone)))))),
    Match.when("/api/name", () => Option.some(Option.map(decodeName(body), (input) => nameOf(input.project, input.name.trim(), now)))),
    Match.when("/api/since", () => Option.some(Option.map(decodeSince(body), () => sinceOf(now)))),
    Match.orElse(() => Option.none()),
  )

/** Why a write is refused, if it is: another origin, no page header, not JSON. */
const writeRefusal = (request: Request, host: string): Option.Option<Answer> => {
  const origin = request.headers.get("origin")
  if (origin !== `http://${host}`) return Option.some(reason(403, "a write must come from the page's own origin"))
  if (request.headers.get(PAGE_HEADER) !== "1") return Option.some(reason(403, `a write must carry ${PAGE_HEADER}`))
  if (!String(request.headers.get("content-type")).startsWith("application/json")) return Option.some(reason(415, "a write is JSON"))
  return Option.none()
}

/** A write route's answer: the line kept (204), or why not. */
const write = (handlers: Handlers, request: Request, path: string, host: string) =>
  Effect.gen(function* () {
    const refused = writeRefusal(request, host)
    if (Option.isSome(refused)) return refused.value
    const body = yield* Effect.promise(() => request.text())
    const now = yield* handlers.now
    return yield* Option.match(lineOf(path, body, now, handlers.zone), {
      onNone: () => Effect.succeed(reason(404, `no route ${path}`)),
      onSome: (line) =>
        Option.match(line, {
          onNone: () => Effect.succeed(reason(400, `not a ${path} request`)),
          onSome: (kept) =>
            handlers.write(kept).pipe(
              Effect.as(answer(204, "")),
              Effect.catch((failure) => Effect.succeed(reason(500, failure.message))),
            ),
        }),
    })
  })

/** A read route's answer. */
const read = (handlers: Handlers, dist: string, path: string) =>
  Match.value(path).pipe(
    Match.when("/", () => builtFile(dist, ".", "index.html", "no-store")),
    Match.when("/view.json", () =>
      handlers.view.pipe(
        Effect.map((json) => answer(200, json, { "content-type": "application/json", "cache-control": "no-store" })),
        Effect.catch((failure) => Effect.succeed(reason(500, failure.message))),
      ),
    ),
    Match.when(
      (each) => each.startsWith("/assets/"),
      (each) => builtFile(dist, "assets", each.slice("/assets/".length), "public, max-age=31536000, immutable"),
    ),
    Match.orElse(() => Effect.succeed(reason(404, "no such page"))),
  )

/** The listener's answer to one request. */
export const answerOf = (handlers: Handlers, dist: string, request: Request): Effect.Effect<Answer> => {
  const host = String(request.headers.get("host"))
  if (!LOOPBACK_HOST.test(host)) return Effect.succeed(reason(421, "this page answers on its loopback name only"))
  const path = new URL(request.url).pathname
  if (request.method === "POST") return write(handlers, request, path, host)
  if (request.method === "GET" || request.method === "HEAD") {
    if (path.startsWith("/api/")) return Effect.succeed(reason(405, "a write is a POST"))
    return read(handlers, dist, path)
  }
  return Effect.succeed(reason(405, "GET or POST only"))
}

/** The port could not be bound (another instance holds it). */
export class NotBound extends Schema.TaggedError<NotBound>()("NotBound", { message: Schema.String }) {}

/** Listen on 127.0.0.1:`port` (0 for any free one) until the scope closes; the address bound. */
export const listen = (port: number, handlers: Handlers, dist: string): Effect.Effect<{ readonly hostname: string; readonly port: number }, NotBound, Scope.Scope> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<never>()
    const respond = (request: Request) =>
      Effect.runPromiseWith(context)(Effect.map(answerOf(handlers, dist, request), (each) => new Response(each.body, { status: each.status, headers: each.headers })))
    const server = yield* Effect.acquireRelease(
      Effect.try({
        try: () => Bun.serve({ hostname: HOSTNAME, port, fetch: respond }),
        catch: (cause) => new NotBound({ message: String(cause) }),
      }),
      (bound) => Effect.sync(() => void bound.stop(true)),
    )
    return { hostname: String(server.hostname), port: Number(server.port) }
  })

/** Listen on 127.0.0.1:`port` until the scope closes, binding as soon as the port is free. */
export const serve = (port: number, handlers: Handlers, dist: string): Effect.Effect<void, never, Scope.Scope> =>
  listen(port, handlers, dist).pipe(
    Effect.tapError((failure) => Effect.logDebug(`digest page: ${HOSTNAME}:${port} not bound (${failure.message}); trying again`)),
    Effect.retry({ schedule: Schedule.spaced(RETRY), times: WAIT_TRIES }),
    Effect.flatMap((bound) => Effect.logInfo(`digest page: listening on http://${bound.hostname}:${bound.port}`)),
    Effect.catch((failure) => Effect.logError(`digest page: ${HOSTNAME}:${port} never came free (${failure.message}); this instance serves no page`)),
  )
