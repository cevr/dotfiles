// The mail listener: a small HTTP server of the mail plugin's own, bound to one
// address (the host's Tailscale address in use, never a wildcard), that its
// paired hosts reach. It answers three routes (peer.ts `ROUTES`): `pair`
// takes an invite's code and pairs (pairing.ts `accept`); `list` and
// `receive`, for signed requests only (pairing.ts `authenticate`), list this
// server's sessions and take a parcel for one. Every refusal is logged.
//
// OpenCode's own server stays on loopback with its password: a peer reaches
// only these routes, never the rest of OpenCode's API.
//
// OpenCode serves a plugin once per directory it serves, and only one of them
// can bind the port: the others try again every `RETRY`, so one listens while
// any instance runs. The one that binds records its address in the pairing
// state, where the pair command reads it.
//
// The network is the `Net` service: `bunListen` here is its real listener
// (Bun's server), a memory one (memory/net.ts) the simulated hosts'.
import { Clock, Duration, Effect, Option, Schedule, Schema, type Scope } from "effect"
import { accept, authenticate, HEADERS, type Keyed, type Pairs, SKEW_MS } from "../pairing.ts"
import { isWildcard, ListAsk, PairAsk, Parcel, ROUTES, urlOf, type Arrival } from "../peer.ts"
import type { SessionCard } from "../directory.ts"
import { type Address, Net, NetFailed, PairStore, type Received, Tokens, type Wire } from "../service.ts"

/** How long an instance waits before it tries the port again. */
export const RETRY = Duration.seconds(30)

export type Listen = Address

/** What the listener answers with: this server's sessions, and a parcel taken in. */
export interface Handlers {
  readonly cards: (scope: { readonly children: boolean }) => Effect.Effect<ReadonlyArray<SessionCard>, { readonly message: string }>
  readonly receive: (peer: string, parcel: Parcel) => Effect.Effect<Arrival>
}

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

const json = <A>(body: A, status = 200): Wire => ({ status, body: encodeJson(body) })

/**
 * The listener's answer to one request, on the pairing store and tokens it is given: a test drives it without a
 * network. It remembers the nonces it saw for twice `SKEW_MS`.
 */
export const answerer = (handlers: Handlers, keyed: Keyed) =>
  Effect.gen(function* () {
    const store = yield* PairStore
    const tokens = yield* Tokens
    const seen = new Map<string, number>()
    const started = yield* Clock.currentTimeMillis
    const refuse = (route: string, from: string, reason: string, status: number) =>
      Effect.logWarning(`mail listener: refused ${route} from ${from}: ${reason}`).pipe(Effect.as(json({ reason }, status)))

    const pair = Effect.fn("Listener.pair")(function* (request: Received, now: number) {
      const ask = Schema.decodeUnknownOption(Schema.fromJsonString(PairAsk))(request.body)
      if (Option.isNone(ask)) return yield* refuse(request.path, request.address, "not a pairing request", 400)
      const secret = yield* tokens.token(32)
      const outcome = yield* store
        .update((pairs): readonly [ReturnType<typeof accept>, Pairs] => {
          const accepted = accept(pairs, ask.value, secret, now, keyed)
          if (accepted.ok) return [accepted, accepted.pairs]
          return [accepted, pairs]
        })
        .pipe(Effect.catch((failure) => Effect.succeed({ ok: false as const, reason: `the pairing could not be kept: ${failure.message}` })))
      if (!outcome.ok) return yield* refuse(request.path, request.address, outcome.reason, 403)
      yield* Effect.logInfo(`mail listener: paired with ${ask.value.name} at ${ask.value.url}`)
      return json(outcome.answer)
    })

    const signed = Effect.fn("Listener.signed")(function* (request: Received, now: number) {
      for (const [nonce, until] of seen) if (until <= now) seen.delete(nonce)
      const auth = authenticate(yield* store.read, request, now, (nonce) => seen.has(nonce), keyed)
      if (!auth.ok) return yield* refuse(request.path, request.address, auth.reason, 401)
      // The nonces seen are this listener's alone: one signed before it started could be a replay it cannot tell.
      if (Number(request.header(HEADERS.time)) < started) return yield* refuse(request.path, auth.peer, "the request was signed before this listener started", 401)
      seen.set(auth.nonce, now + 2 * SKEW_MS)
      if (request.path === ROUTES.list) {
        const ask = Schema.decodeUnknownOption(Schema.fromJsonString(ListAsk))(request.body)
        if (Option.isNone(ask)) return yield* refuse(request.path, auth.peer, "not a listing request", 400)
        return yield* handlers.cards(ask.value).pipe(
          Effect.match({ onSuccess: (cards) => json(cards), onFailure: (failure) => json({ reason: failure.message }, 503) }),
        )
      }
      if (request.path === ROUTES.receive) {
        const parcel = Schema.decodeUnknownOption(Schema.fromJsonString(Parcel))(request.body)
        if (Option.isNone(parcel)) return yield* refuse(request.path, auth.peer, "not a parcel", 400)
        return json(yield* handlers.receive(auth.peer, parcel.value))
      }
      return json({ reason: `no route ${request.path}` }, 404)
    })

    return (request: Received): Effect.Effect<Wire> =>
      Effect.gen(function* () {
        if (request.method !== "POST") return json({ reason: "POST only" }, 405)
        const now = yield* Clock.currentTimeMillis
        if (request.path === ROUTES.pair) return yield* pair(request, now)
        return yield* signed(request, now)
      })
  })

/** A request as Bun's server has it, read whole, with the address it came from. */
const receivedOf = (request: Request, address: string) =>
  Effect.promise(() => request.text()).pipe(
    Effect.map(
      (body): Received => ({
        method: request.method,
        path: new URL(request.url).pathname,
        body,
        header: (name) => Option.getOrUndefined(Option.fromNullishOr(request.headers.get(name))),
        address,
      }),
    ),
  )

/** The real network's listener: Bun's server on `address`, each request answered on the listening fiber's services, until the scope closes. */
export const bunListen = (address: Address, answer: (request: Received) => Effect.Effect<Wire>): Effect.Effect<number, NetFailed, Scope.Scope> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<never>()
    const respond = (request: Request, from: string) =>
      Effect.runPromiseWith(context)(
        receivedOf(request, from).pipe(
          Effect.flatMap(answer),
          Effect.map((wire) => new Response(wire.body, { status: wire.status, headers: { "content-type": "application/json" } })),
        ),
      )
    const server = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          Bun.serve({
            hostname: address.hostname,
            port: address.port,
            fetch: (request, bound) => respond(request, Option.getOrElse(Option.fromNullishOr(bound.requestIP(request)?.address), () => "an unknown address")),
          }),
        catch: (cause) => new NetFailed({ message: String(cause) }),
      }),
      (bound) => Effect.sync(() => void bound.stop(true)),
    )
    return Option.getOrElse(Option.fromNullishOr(server.port), () => address.port)
  })

/**
 * Listen on `listen` until the scope closes, binding as soon as the port is
 * free, and record the address in the pairing state. A wildcard address is
 * refused and logged: nothing listens.
 */
export const serve = (listen: Listen, handlers: Handlers, keyed: Keyed): Effect.Effect<void, never, PairStore | Net | Tokens | Scope.Scope> =>
  Effect.gen(function* () {
    if (isWildcard(listen.hostname))
      return yield* Effect.logError(`mail listener: refusing to listen on ${JSON.stringify(listen.hostname)}, every interface; give one address (the host's Tailscale address)`)
    const net = yield* Net
    const answer = yield* answerer(handlers, keyed)
    // Other locations may own this port indefinitely; a reload interrupts the wait between tries.
    const port = yield* net.listen(listen, answer).pipe(
      Effect.tapError((failure) => Effect.logDebug(`mail listener: ${urlOf(listen.hostname, listen.port)} not bound (${failure.message}); trying again`)),
      Effect.retry(Schedule.spaced(RETRY)),
      Effect.orDie,
    )
    const url = urlOf(listen.hostname, port)
    const store = yield* PairStore
    yield* store.update((pairs) => [undefined, { ...pairs, url }]).pipe(Effect.ignore)
    yield* Effect.logInfo(`mail listener: listening on ${url}`)
  })
