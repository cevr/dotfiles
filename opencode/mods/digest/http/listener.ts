// The digest page's listeners: small HTTP servers of the digest plugin's own, one on 127.0.0.1 and one on each of the
// host's tailnet addresses (bind.ts: never a wildcard, never another address, refused in code), serving the page's
// built files (page/dist, committed) and the view as JSON, and taking the owner's marks and answers.
//
// - Plain HTTP on the tailnet: Tailscale's WireGuard encrypts it between his devices. The token never goes in a URL.
// - What each request may do is policy.ts's one decision, by listener, route, source, paired, origin and Host. The
//   source is the socket's peer address (`socketPeer`), looked up among his devices (members.ts); a header such as
//   X-Forwarded-For is never read.
// - GET `/health`: the health line (health.ts); on the tailnet, unpaired, `ok` alone; on loopback with the write
//   switch in force and his devices' count.
//
// - GET `/` and `/assets/<name>`: the built files, by exact name inside `dist`; no other path reads the disk.
// - GET `/view.json`: the view (view.ts), fresh from the log and the marks at each request.
// - GET `/peer/view.json`: this host's own view in the wire envelope its named peers read (peers.ts); a read like
//   `/view.json`, with the same policy: a tailnet member reads it where `tailnetRead` is `member`.
// - POST `/api/mark` {id, mark: read | unread}, `/api/later` {id}, `/api/name` {project, name}, `/api/since` {}:
//   one marks line each (marks.ts). A write is a POST of JSON whose Origin is the page's own and which carries
//   PAGE_HEADER; anything else is refused and writes nothing. No GET changes state.
// - GET `/paired.json`: `{paired, answers}`: whether the request's TOKEN_HEADER is a paired browser's token, and
//   whether it may answer now (paired, or from a device `digest.tailnetWrite` opens). It tells no more than an answer
//   sent from there would, and no other site's page can read it (no CORS, CORP same-origin).
// - POST `/api/pair` {code}: a one-use code from `bun cmd/digest/pair.ts`, for a token in the body (pairing.ts),
//   which the page keeps in its origin's localStorage. No cookie is set or read: a cookie would reach every other
//   server on 127.0.0.1. Past RATE_FAILURES failed tries in a minute every try is refused (429), nothing compared.
// - Every answer, an error too, carries SECURITY (a CSP with script-src 'self' and no inline script).
// - POST `/api/answer` {id, option | text}: the owner's answer to an open question or needs-you item (answers.ts):
//   200 when it went, 409 with the first answer when another closed it, 4xx when refused. Only from a paired browser.
// - Every request must name one of its listener's own hosts (`Host`), so a name rebound to its address reads nothing.
//   On the tailnet that is its bound address alone: under its MagicDNS or short name, `GET /` is sent on to the
//   address (308) and every other route is refused (421), token or not (policy.ts says why).
// - CORS, the tailnet listener at its address only, for a named peer's page alone (policy.ts isPeerWrite,
//   preflightOf): a mark or an answer whose Origin is exactly one of `peerOrigins` (the keyed peer's Tailscale
//   address origins) gets Access-Control-Allow-Origin with that origin (its refusal too, so the page can say why),
//   and its preflight is answered for POST with PEER_HEADERS, never the token's. Every answer carries
//   `Vary: Origin`. The shell's CSP lets the page connect to its peers' pages (`peerPages`). CORS is the browser's
//   guard; the source rule, by the socket's address, is the network's.
//
// OpenCode serves a plugin once per directory it serves, and only one instance can bind a port on an address (the
// socket is never made with SO_REUSEPORT, so Linux refuses a second one as macOS does): the others try again every
// RETRY, so one listens on each address while any instance runs, and a restart hands each over.
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { Duration, Effect, Exit, Match, Option, Ref, Schedule, Schema, Scope } from "effect"
import { type AnswerOutcome, PageAnswer } from "../answers.ts"
import { bindable, BindRefused, hostOf, hostsOf, hostWithPort, noTailnet, type Tailnet } from "../bind.ts"
import { BRIEF, isWell, localPart, type TailnetState } from "../health.ts"
import { type MarkLine, markOf, nameOf, sinceOf } from "../marks.ts"
import { type Pairing, TOKEN_HEADER } from "../pairing.ts"
import { current, type Members, sourceOf, writesWord } from "../members.ts"
import { authorityOf, Decision, decide, isPeerWrite, type Listener, mayAnswer, PEER_HEADERS, type Policy, preflightOf, type RouteKind, type Source, type TailnetRead } from "../policy.ts"
import { nextMorning } from "../zone.ts"

/** The loopback listener's address. */
export const HOSTNAME = "127.0.0.1"
/** The loopback listener's names. */
export const LOOPBACK_NAMES: ReadonlyArray<string> = [HOSTNAME, "localhost"]
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
  /** This host's own view in the peers' wire envelope (peers.ts), never its peers': what `/peer/view.json` answers. */
  readonly peerView: Effect.Effect<string, { readonly message: string }>
  /** Keep one marks line. */
  readonly write: (line: MarkLine) => Effect.Effect<void, { readonly message: string }>
  readonly now: Effect.Effect<number>
  /** `digest.timezone`: Later's morning is in it. */
  readonly zone: string
  /** Send the owner's answer through the plugin that owns its message. */
  readonly answer: (input: PageAnswer) => Effect.Effect<AnswerOutcome>
  readonly pairing: Pairing
  /** The health line, whole (health.ts). */
  readonly health: Effect.Effect<string>
  /** `digest.tailnetRead`: who reads the page on the tailnet. */
  readonly tailnetRead: TailnetRead
  /** His devices now, and `digest.tailnetWrite` in force (members.ts), read again at each tailnet recheck. */
  readonly members: Effect.Effect<Members>
  /** The named peers' pages' origins this host lets write here now (peers.ts peerOriginsOf, policy.ts isPeerWrite). */
  readonly peerOrigins: Effect.Effect<ReadonlyArray<string>>
  /** The peers' pages this page writes to, by origin (where it read them): all its CSP lets it connect to beside itself. */
  readonly peerPages: Effect.Effect<ReadonlyArray<string>>
}

/**
 * A listener as a request reaches it: which one, the hosts it serves under, the names that only send `GET /` on to
 * its address, and that address's page (`home`, the redirect's Location, from the bound address alone).
 */
export interface Site {
  readonly listener: Listener
  readonly hosts: ReadonlyArray<string>
  readonly names: ReadonlyArray<string>
  readonly home: string
}

/** The loopback site on `port`. */
export const loopbackSite = (port: number): Site => ({ listener: "loopback", hosts: hostsOf(port, LOOPBACK_NAMES), names: [], home: `http://${HOSTNAME}:${port}/` })

/** An answer: status, headers, body. */
interface Answer {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: string | Blob
}

/** An origin as a peer's page has one: http, a lower case name or a bracketed IPv6 address, a port. */
const PLAIN_ORIGIN = /^http:\/\/([a-z0-9.-]+|\[[0-9a-f:]+\]):[0-9]{1,5}$/

/** The page's CSP, connecting to its own origin and to `peers` (each an exact origin; anything else is left out). */
const cspOf = (peers: ReadonlyArray<string>) =>
  `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src ${["'self'", ...peers.filter((each) => PLAIN_ORIGIN.test(each))].join(" ")}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`

const SECURITY = {
  "content-security-policy": cspOf([]),
  // Every answer may differ by Origin (a peer's page gets Access-Control-Allow-Origin): no cache may mix them.
  vary: "Origin",
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

/** A marks route's answer: the line kept (204), or why not. */
const mark = (handlers: Handlers, path: string, body: string) =>
  Effect.gen(function* () {
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

const PairInput = Schema.Struct({ code: Schema.String.check(Schema.isMaxLength(64)) })
const decodePair = Schema.decodeUnknownOption(Schema.fromJsonString(PairInput))
const decodeAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(PageAnswer))

const encodePairedBody = Schema.encodeSync(Schema.fromJsonString(Schema.Struct({ id: Schema.String, token: Schema.String })))

/**
 * `/api/pair`: a code for a token, in the body (200), never in a header the browser keeps by itself. The pairing
 * counts a failed try, and past the minute's failures it refuses before comparing (429).
 */
const pair = (handlers: Handlers, body: string, label: string, source: string) =>
  Effect.gen(function* () {
    const now = yield* handlers.now
    const input = decodePair(body)
    if (Option.isNone(input)) return reason(400, "not a /api/pair request")
    return yield* handlers.pairing.exchange(input.value.code, now, label, source).pipe(
      Effect.map((paired) => answer(200, encodePairedBody(paired), { "content-type": "application/json", "cache-control": "no-store" })),
      Effect.catchTags({
        PairRefused: (refused) =>
          Effect.succeed(
            Match.value(refused.reason).pipe(
              Match.when("expired", () => reason(410, "that code is out of time: make another with bun cmd/digest/pair.ts on the host")),
              Match.when("limited", () => reason(429, "too many pairing tries from here: wait a minute, then make a new code")),
              Match.orElse(() => reason(403, "that code is not one, or was used already")),
            ),
          ),
        PairingUnavailable: (failure) => Effect.succeed(reason(500, failure.message)),
      }),
    )
  })

/** What `/api/answer` answers, an absent field left out. */
const AnswerBody = Schema.Struct({
  answered: Schema.Boolean,
  replaced: Schema.OptionFromOptionalKey(Schema.String),
  answer: Schema.OptionFromOptionalKey(Schema.String),
  via: Schema.OptionFromOptionalKey(Schema.String),
  at: Schema.OptionFromOptionalKey(Schema.Number),
  reason: Schema.OptionFromOptionalKey(Schema.String),
})
const encodeAnswerBody = Schema.encodeSync(Schema.fromJsonString(AnswerBody))

const none = { replaced: Option.none(), answer: Option.none(), via: Option.none(), at: Option.none(), reason: Option.none() }

const jsonAnswer = (status: number, body: typeof AnswerBody.Type): Answer => answer(status, encodeAnswerBody(body), { "content-type": "application/json", "cache-control": "no-store" })

/** An answer's outcome as the page reads it: 200 sent, 409 closed by another (that answer, where, when), else why not. */
const outcomeAnswer = (outcome: AnswerOutcome): Answer =>
  Match.valueTags(outcome, {
    Answered: ({ replaced }) => jsonAnswer(200, { ...none, answered: true, replaced }),
    AlreadyClosed: ({ answer: first, via, at }) => jsonAnswer(409, { ...none, answered: false, answer: first, via, at, reason: Option.some("already answered") }),
    Refused: ({ status, reason: why }) => jsonAnswer(status, { ...none, answered: false, reason: Option.some(why) }),
  })

/** `/api/answer`: the owner's answer, sent through the plugin that owns its message. */
const answerRoute = (handlers: Handlers, body: string) =>
  Option.match(decodeAnswer(body), {
    onNone: () => Effect.succeed(reason(400, "not a /api/answer request")),
    onSome: (input) => Effect.map(handlers.answer(input), outcomeAnswer),
  })

/** Whether the request carries a paired browser's token in TOKEN_HEADER: the only credential read, never a cookie. */
const isPaired = (handlers: Handlers, request: Request): Effect.Effect<boolean> =>
  Option.match(Option.fromNullishOr(request.headers.get(TOKEN_HEADER)), {
    onNone: () => Effect.succeed(false),
    onSome: (token) => Effect.map(handlers.pairing.verify(token), Option.isSome),
  })

const encodePaired = Schema.encodeSync(Schema.fromJsonString(Schema.Struct({ paired: Schema.Boolean, answers: Schema.Boolean })))

const NO_STORE = { "cache-control": "no-store" }
const text = (status: number, body: string): Answer => answer(status, body, { "content-type": "text/plain; charset=utf-8", ...NO_STORE })

/** One request as the routes after the decision read it. */
interface Asked {
  readonly path: string
  readonly listener: Listener
  readonly source: Source
  readonly policy: Policy
  readonly members: Members
  readonly paired: boolean
}

/** The health line whole: on loopback with the write switch and his devices' count, elsewhere without them. */
const wholeHealth = (handlers: Handlers, asked: Asked) =>
  Effect.map(handlers.health, (line) =>
    Option.getOrElse(
      Option.map(Option.liftPredicate(line, (each) => asked.listener === "loopback" && isWell(each)), (each) => `${each} ${localPart(writesWord(asked.members), asked.members.devices, asked.members.writers, asked.members.excluded)}`),
      () => line,
    ),
  )

/** A GET route's answer, once the policy served it; `brief`, the health line's `ok` alone. */
const read = (handlers: Handlers, dist: string, asked: Asked, brief: boolean) =>
  Match.value(asked.path).pipe(
    // The page may connect to its peers' pages too: it sends their items' writes there.
    Match.when("/", () =>
      Effect.flatMap(handlers.peerPages, (pages) => Effect.map(builtFile(dist, ".", "index.html", "no-store"), (shell) => ({ ...shell, headers: { ...shell.headers, "content-security-policy": cspOf(pages) } }))),
    ),
    Match.when("/health", () => Effect.map(Option.match(Option.liftPredicate(brief, Boolean), { onSome: () => Effect.succeed(BRIEF), onNone: () => wholeHealth(handlers, asked) }), (line) => text(200, line))),
    Match.when("/view.json", () =>
      handlers.view.pipe(
        Effect.map((json) => answer(200, json, { "content-type": "application/json", ...NO_STORE })),
        Effect.catch((failure) => Effect.succeed(reason(500, failure.message))),
      ),
    ),
    Match.when("/peer/view.json", () =>
      handlers.peerView.pipe(
        Effect.map((json) => answer(200, json, { "content-type": "application/json", ...NO_STORE })),
        Effect.catch((failure) => Effect.succeed(reason(500, failure.message))),
      ),
    ),
    Match.when("/paired.json", () =>
      Effect.succeed(answer(200, encodePaired({ paired: asked.paired, answers: mayAnswer(asked.listener, asked.policy, asked.source, asked.paired) }), { "content-type": "application/json", ...NO_STORE })),
    ),
    Match.when(
      (each) => each.startsWith("/api/"),
      () => Effect.succeed(reason(405, "a write is a POST")),
    ),
    Match.when(
      (each) => each.startsWith("/assets/"),
      (each) => builtFile(dist, "assets", each.slice("/assets/".length), "public, max-age=31536000, immutable"),
    ),
    Match.orElse(() => Effect.succeed(reason(404, "no such page"))),
  )

/** The kind of route a request is (policy.ts's RouteKind); none for a method no route takes. */
export const kindOf = (method: string, path: string): Option.Option<RouteKind> =>
  Match.value({ method, path }).pipe(
    Match.when({ method: "POST", path: "/api/answer" }, () => Option.some<RouteKind>("answer")),
    Match.when({ method: "POST", path: "/api/pair" }, () => Option.some<RouteKind>("pair")),
    Match.when({ method: "POST" }, () => Option.some<RouteKind>("mark")),
    Match.when({ method: (each) => each !== "GET" && each !== "HEAD" }, () => Option.none<RouteKind>()),
    Match.when({ path: (each) => each === "/" || each.startsWith("/assets/") }, () => Option.some<RouteKind>("shell")),
    Match.when({ path: "/paired.json" }, () => Option.some<RouteKind>("status")),
    Match.when({ path: "/health" }, () => Option.some<RouteKind>("health")),
    Match.orElse(() => Option.some<RouteKind>("read")),
  )

/**
 * The listener's answer to one request on `site`, from the socket peer address `address` (never a header); a defect
 * is a 500 with the same headers, never a bare one.
 */
export const answerOf = (handlers: Handlers, dist: string, request: Request, site: Site, address = "unknown"): Effect.Effect<Answer> =>
  Effect.suspend(() => routed(handlers, dist, request, site, address)).pipe(
    Effect.catchCause((cause) => Effect.as(Effect.logWarning("digest page: a request failed", { cause }), reason(500, "the digest failed this request"))),
  )

/** One request as the order reads it: its method, URL and headers, its token's verdict and its source. */
export interface Asking {
  readonly method: string
  /** The URL as Bun built it (from the `Host`); it may not parse. */
  readonly url: string
  /** The `Host` it named, as sent; none when the header is absent (never a truthiness test: "" is one sent). */
  readonly host: Option.Option<string>
  /** Its `Origin`, as sent; none when the header is absent. "", " ", `null` and two joined by Bun are each sent. */
  readonly origin: Option.Option<string>
  readonly pageHeader: boolean
  readonly json: boolean
  readonly paired: boolean
  readonly source: Source
}

/** What the order comes to: the decision, and for a request it got that far, its route; the path. */
export interface Screened {
  readonly decision: Decision
  readonly kind: Option.Option<RouteKind>
  readonly path: string
}

/** Main's answer to a URL Bun could not build, kept on loopback as it was: the defect's 500. */
const UNPARSED = "the digest failed this request"

/**
 * The order every request takes before any route runs, in one place:
 * 1. On the tailnet, its authority, whatever its method, path or target (policy.ts `authorityOf`): a Host that is
 *    not the listener's address is refused (421), a GET or HEAD of `/` under one of its names sent on (308).
 * 2. A URL that does not parse (Bun builds it from the Host): on loopback the 500 main gave, on the tailnet 421.
 * 3. A method no route takes: 405 (a peer's preflight is looked at only after this, in `routed`).
 * 4. The policy's decision (`decide`): loopback's Host, the source, the origin and headers, what the route needs;
 *    `peerOrigins` (none by default) lets a named peer's page send a mark or an answer at the address.
 * Loopback's steps 2 to 4 are main's (4afe1fda), unchanged.
 */
export const screen = (site: Site, policy: Policy, asking: Asking, peerOrigins: ReadonlyArray<string> = []): Screened => {
  const url = Option.fromNullishOr(URL.parse(asking.url))
  const path = Option.match(url, { onNone: () => "", onSome: (each) => each.pathname })
  const stopped = (decision: Decision): Screened => ({ decision, kind: Option.none(), path })
  const rootRead = (asking.method === "GET" || asking.method === "HEAD") && path === "/"
  const first = authorityOf({ listener: site.listener, host: asking.host, hosts: site.hosts, names: site.names, rootRead })
  if (Option.isSome(first)) return stopped(first.value)
  if (Option.isNone(url)) return stopped(Decision.Refuse(Match.value(site.listener).pipe(Match.when("loopback", () => ({ status: 500, reason: UNPARSED })), Match.orElse(() => ({ status: 421, reason: "this page reads no such target" })))))
  return Option.match(kindOf(asking.method, path), {
    onNone: () => stopped(Decision.Refuse({ status: 405, reason: "GET or POST only" })),
    onSome: (kind) => ({
      decision: decide({ listener: site.listener, kind, source: asking.source, host: asking.host, hosts: site.hosts, names: site.names, root: path === "/", origin: asking.origin, pageHeader: asking.pageHeader, json: asking.json, paired: asking.paired }, policy, peerOrigins),
      kind: Option.some(kind),
      path,
    }),
  })
}

/** A request header, "" when absent. */
const headerOf = (request: Request, name: string): string => Option.getOrElse(Option.fromNullishOr(request.headers.get(name)), () => "")

/**
 * A CORS preflight that the order (`screen`) got as far as its method (405): allowed (204, the origin echoed from
 * the allowed list it equals, POST and the page's headers alone) only for a named peer's page announcing a mark or
 * an answer at this listener's address (policy.ts preflightOf); else the order's own 405, no Access-Control header
 * at all, so the browser sends nothing. Every earlier refusal (a name's 421) stands as the order gave it.
 */
const preflight = (request: Request, site: Site, source: Source, path: string, peerOrigins: ReadonlyArray<string>): Option.Option<Answer> => {
  const method = headerOf(request, "access-control-request-method")
  const origin = Option.fromNullishOr(request.headers.get("origin"))
  const headers = headerOf(request, "access-control-request-headers")
    .split(",")
    .map((each) => each.trim().toLowerCase())
    .filter((each) => each !== "")
  const kind = Option.getOrElse(Option.filter(kindOf(method, path), () => method === "POST"), (): RouteKind | "none" => "none")
  const asked = { listener: site.listener, kind, source, host: Option.fromNullishOr(request.headers.get("host")), hosts: site.hosts, origin, method, headers }
  return Option.map(
    Option.filter(origin, () => preflightOf(asked, peerOrigins)),
    (peer) => answer(204, "", { "access-control-allow-origin": peer, "access-control-allow-methods": "POST", "access-control-allow-headers": PEER_HEADERS.join(", "), "access-control-max-age": "600" }),
  )
}

const routed = (handlers: Handlers, dist: string, request: Request, site: Site, address: string): Effect.Effect<Answer> =>
  Effect.gen(function* () {
    const body = Effect.promise(() => request.text())
    const paired = yield* isPaired(handlers, request)
    const members = current(yield* handlers.members, yield* handlers.now)
    const source = Match.value(site.listener).pipe(
      Match.when("loopback", (): Source => "local"),
      Match.orElse(() => sourceOf(address, members)),
    )
    const policy: Policy = { tailnetRead: handlers.tailnetRead, tailnetWrite: members.write }
    const peerOrigins = yield* handlers.peerOrigins
    const asking: Asking = {
      method: request.method,
      url: request.url,
      // Presence by the header's absence alone (`get` answers null only then), never by its value.
      host: Option.fromNullishOr(request.headers.get("host")),
      origin: Option.fromNullishOr(request.headers.get("origin")),
      pageHeader: request.headers.get(PAGE_HEADER) === "1",
      json: String(request.headers.get("content-type")).startsWith("application/json"),
      paired,
      source,
    }
    const screened = screen(site, policy, asking, peerOrigins)
    const path = screened.path
    const asked: Asked = { path, listener: site.listener, source, policy, members, paired }
    // A peer's preflight, once the order reached the method (its 405): allowed or that 405, nothing else changed.
    const reachedMethod = Option.isNone(screened.kind) && Match.valueTags(screened.decision, { Refuse: ({ status }) => status === 405, Brief: () => false, Redirect: () => false, Serve: () => false })
    if (request.method === "OPTIONS" && reachedMethod) return yield* Effect.succeed(Option.getOrElse(preflight(request, site, source, path, peerOrigins), () => reason(405, "GET or POST only")))
    // A peer's page may read the answer to its write, a refusal too (so it can say why): nothing else, nowhere else.
    const peerWrite = Option.exists(screened.kind, (kind) => isPeerWrite({ listener: site.listener, kind, host: asking.host, hosts: site.hosts, origin: asking.origin }, peerOrigins))
    const corsFor = (each: Answer): Answer =>
      Option.match(Option.filter(asking.origin, () => peerWrite), { onNone: () => each, onSome: (peer) => ({ ...each, headers: { ...each.headers, "access-control-allow-origin": peer } }) })
    const decided = yield* Match.valueTags(screened.decision, {
      Refuse: ({ status, reason: why }) => Effect.succeed(reason(status, why)),
      Brief: () => read(handlers, dist, asked, true),
      // To the page at the listener's own address; nothing of the request goes into the Location.
      Redirect: () => Effect.succeed(answer(308, "", { location: site.home, ...NO_STORE })),
      Serve: () =>
        Match.value(Option.getOrElse(screened.kind, (): RouteKind => "read")).pipe(
          Match.when("pair", () => Effect.flatMap(body, (given) => pair(handlers, given, String(request.headers.get("user-agent")), address))),
          Match.when("answer", () => Effect.flatMap(body, (given) => answerRoute(handlers, given))),
          Match.when("mark", () => Effect.flatMap(body, (given) => mark(handlers, path, given))),
          Match.orElse(() => read(handlers, dist, asked, false)),
        ),
    })
    return corsFor(decided)
  })

/** The port could not be bound (another instance holds it, or the address is gone). */
export class NotBound extends Schema.TaggedError<NotBound>()("NotBound", { message: Schema.String }) {}

/** Where one listener listens: its address (loopback, or a tailnet one), its port (0 for any free one), its site. */
export interface Place {
  readonly address: string
  readonly port: number
  readonly listener: Listener
  /** The tailnet's MagicDNS name and short name, which only send `GET /` on to the address; loopback's are LOOPBACK_NAMES. */
  readonly names: ReadonlyArray<string>
}

/**
 * The site a place serves once bound on `port`. The tailnet listener serves under its bound address alone, as a
 * browser writes it; its names only send `GET /` on to that address (policy.ts).
 */
export const siteOf = (place: Place, port: number): Site =>
  Match.value(place.listener).pipe(
    Match.when("loopback", () => loopbackSite(port)),
    Match.orElse((): Site => {
      const address = hostWithPort(place.address, port)
      return { listener: place.listener, hosts: [address], names: place.names.map((name) => hostWithPort(name, port)), home: `http://${address}/` }
    }),
  )

/** Where a request came from: its socket's peer address, as the server saw it; never a header. */
export type PeerOf = (request: Request, server: Bun.Server<unknown>) => string

/** The socket's peer address (Bun's `requestIP`); `unknown` when it has none, which no rule admits. */
export const socketPeer: PeerOf = (request, server) => Option.getOrElse(Option.map(Option.fromNullishOr(server.requestIP(request)), (each) => each.address), () => "unknown")

/**
 * Listen at `place` until the scope closes; the address and port bound. An address that is not loopback or the
 * tailnet's is refused before any socket is made (bind.ts), whatever asked for it. `peerOf` is the socket's peer
 * address; a test, which binds loopback only, stands a tailnet address in for it here.
 */
export const listen = (place: Place, handlers: Handlers, dist: string, peerOf: PeerOf = socketPeer): Effect.Effect<{ readonly hostname: string; readonly port: number }, NotBound | BindRefused, Scope.Scope> =>
  Effect.gen(function* () {
    const refused = bindable(place.address)
    if (Option.isSome(refused)) return yield* refused.value
    const context = yield* Effect.context<never>()
    const sites = { current: siteOf(place, place.port) }
    const respond = (request: Request, server: Bun.Server<unknown>) =>
      Effect.runPromiseWith(context)(
        Effect.map(answerOf(handlers, dist, request, sites.current, peerOf(request, server)), (each) => new Response(each.body, { status: each.status, headers: each.headers })),
      )
    const server = yield* Effect.acquireRelease(
      Effect.try({
        // Never SO_REUSEPORT: a second instance must fail to bind and wait, on Linux as on macOS.
        try: () => Bun.serve({ hostname: place.address, port: place.port, reusePort: false, fetch: respond }),
        catch: (cause) => new NotBound({ message: String(cause) }),
      }),
      (bound) => Effect.sync(() => void bound.stop(true)),
    )
    sites.current = siteOf(place, Number(server.port))
    return { hostname: String(server.hostname), port: Number(server.port) }
  })

/** Listen on 127.0.0.1:`port` until the scope closes, binding as soon as the port is free. */
export const serve = (port: number, handlers: Handlers, dist: string): Effect.Effect<void, never, Scope.Scope> =>
  listen({ address: HOSTNAME, port, listener: "loopback", names: [] }, handlers, dist).pipe(
    Effect.tapError((failure) => Effect.logDebug(`digest page: ${HOSTNAME}:${port} not bound (${failure.message}); trying again`)),
    Effect.retry({ schedule: Schedule.spaced(RETRY), times: WAIT_TRIES, while: (failure) => failure._tag === "NotBound" }),
    Effect.flatMap((bound) => Effect.logInfo(`digest page: listening on http://${bound.hostname}:${bound.port}`)),
    Effect.catch((failure) => Effect.logError(`digest page: ${HOSTNAME}:${port} never came free (${failure.message}); this instance serves no page`)),
  )

/** How often the tailnet is read again: Tailscale down or up, an address that moved. */
export const RECHECK = Duration.seconds(30)

/** One tailnet listener this instance holds: its place, and the scope that closes it. */
interface Held {
  readonly place: Place
  readonly scope: Scope.Closeable
}

/** A place's key: the same address and names is the same listener. */
const keyOf = (place: Place) => `${place.address} ${place.names.join(",")}`

/**
 * The tailnet's listeners, kept to what `probe` finds, read again every `every`. For each tailnet address it finds,
 * it listens on `port` (another instance holding it: tried again next time). A listener whose address is gone, or
 * whose names changed, is closed. No address (Tailscale absent or down) is loopback only, and `state` says `no:<why>`.
 * A probe that fails is no tailnet. `state` is what health reports: `yes` when it holds every address found,
 * `partial` when some, `held` when none (another instance holds them).
 */
export const serveTailnet = (
  port: number,
  handlers: Handlers,
  dist: string,
  probe: Effect.Effect<Tailnet>,
  state: Ref.Ref<TailnetState>,
  every: Duration.Duration = RECHECK,
  peerOf: PeerOf = socketPeer,
): Effect.Effect<never, never, Scope.Scope> =>
  Effect.gen(function* () {
    const held = new Map<string, Held>()
    const close = (key: string, each: Held) =>
      Effect.andThen(Scope.close(each.scope, Exit.void), Effect.sync(() => void held.delete(key))).pipe(
        Effect.andThen(Effect.logInfo(`digest page: stopped listening on ${each.place.address}:${port}`)),
      )
    yield* Effect.addFinalizer(() => Effect.forEach([...held.entries()], ([key, each]) => close(key, each), { discard: true }))
    const round = Effect.gen(function* () {
      const tailnet = yield* probe.pipe(Effect.orElseSucceed(() => noTailnet("probe-failed")))
      const wanted = new Map(tailnet.addresses.map((address): readonly [string, Place] => {
        const place: Place = { address, port, listener: "tailnet", names: tailnet.names }
        return [keyOf(place), place]
      }))
      yield* Effect.forEach([...held.entries()].filter(([key]) => !wanted.has(key)), ([key, each]) => close(key, each), { discard: true })
      yield* Effect.forEach(
        [...wanted.entries()].filter(([key]) => !held.has(key)),
        ([key, place]) =>
          Effect.gen(function* () {
            const scope = yield* Scope.make()
            const exit = yield* Effect.exit(Scope.provide(scope)(listen(place, handlers, dist, peerOf)))
            if (Exit.isSuccess(exit)) {
              held.set(key, { place, scope })
              return yield* Effect.logInfo(`digest page: listening on http://${hostOf(place.address)}:${port}`)
            }
            yield* Scope.close(scope, Exit.void)
            yield* Effect.logDebug(`digest page: ${place.address}:${port} not bound; trying again`, { cause: exit.cause })
          }),
        { discard: true },
      )
      const mine = [...wanted.keys()].filter((key) => held.has(key)).length
      const served = Match.value({ found: wanted.size, mine }).pipe(
        Match.when({ found: 0 }, (): TailnetState => `no:${tailnet.why}`),
        Match.when({ mine: 0 }, (): TailnetState => "held"),
        Match.when(({ found }) => mine === found, (): TailnetState => "yes"),
        Match.orElse((): TailnetState => "partial"),
      )
      yield* Ref.set(state, served)
    })
    return yield* Effect.forever(Effect.andThen(round, Effect.sleep(every)))
  })
