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
import { Clock, type Context, Duration, Effect, Option, Schedule, Schema, type Scope } from "effect"
import { accept, authenticate, type Keyed, type Pairs, SKEW_MS } from "../pairing.ts"
import { isWildcard, ListAsk, PairAsk, Parcel, ROUTES, urlOf, type Arrival } from "../peer.ts"
import type { SessionCard } from "../directory.ts"
import { PairStore } from "../service.ts"

/** How long an instance waits before it tries the port again. */
export const RETRY = Duration.seconds(30)

export interface Listen {
  readonly hostname: string
  readonly port: number
}

/** What the listener answers with: this server's sessions, and a parcel taken in. */
export interface Handlers {
  readonly cards: (scope: { readonly children: boolean }) => Effect.Effect<ReadonlyArray<SessionCard>, { readonly message: string }>
  readonly receive: (peer: string, parcel: Parcel) => Effect.Effect<Arrival>
}

const json = (body: unknown, status = 200) => Response.json(body, { status })

/** The fetch handler on its own, for a test to drive without a port. */
export const handler = (handlers: Handlers, keyed: Keyed, secret: () => string, context: Context.Context<PairStore>) => {
  const seen = new Map<string, number>()
  const run = <A>(effect: Effect.Effect<A, never, PairStore>) => Effect.runPromiseWith(context)(effect)
  const refuse = (route: string, from: string, reason: string, status: number) =>
    run(Effect.logWarning(`mail listener: refused ${route} from ${from}: ${reason}`)).then(() => json({ reason }, status))

  return async (request: Request, address?: string): Promise<Response> => {
    const path = new URL(request.url).pathname
    const from = address ?? "an unknown address"
    if (request.method !== "POST") return json({ reason: "POST only" }, 405)
    const body = await request.text()
    const now = await run(Clock.currentTimeMillis)

    if (path === ROUTES.pair) {
      const ask = Schema.decodeUnknownOption(Schema.fromJsonString(PairAsk))(body)
      if (Option.isNone(ask)) return refuse(path, from, "not a pairing request", 400)
      const outcome = await run(
        Effect.gen(function* () {
          const store = yield* PairStore
          return yield* store.update((pairs): readonly [ReturnType<typeof accept>, Pairs] => {
            const accepted = accept(pairs, ask.value, secret(), now, keyed)
            return [accepted, accepted.ok ? accepted.pairs : pairs]
          })
        }).pipe(Effect.catch((failure) => Effect.succeed({ ok: false as const, reason: `the pairing could not be kept: ${failure.message}` }))),
      )
      if (!outcome.ok) return refuse(path, from, outcome.reason, 403)
      await run(Effect.logInfo(`mail listener: paired with ${ask.value.name} at ${ask.value.url}`))
      return json(outcome.answer)
    }

    for (const [nonce, until] of seen) if (until <= now) seen.delete(nonce)
    const pairs = await run(
      Effect.gen(function* () {
        return yield* (yield* PairStore).read
      }),
    )
    const auth = authenticate(pairs, { method: request.method, path, body, header: (name) => request.headers.get(name) ?? undefined }, now, (nonce) => seen.has(nonce), keyed)
    if (!auth.ok) return refuse(path, from, auth.reason, 401)
    seen.set(auth.nonce, now + 2 * SKEW_MS)

    if (path === ROUTES.list) {
      const ask = Schema.decodeUnknownOption(Schema.fromJsonString(ListAsk))(body)
      if (Option.isNone(ask)) return refuse(path, auth.peer, "not a listing request", 400)
      const cards = await run(handlers.cards(ask.value).pipe(Effect.result))
      return cards._tag === "Success" ? json(cards.success) : json({ reason: cards.failure.message }, 503)
    }
    if (path === ROUTES.receive) {
      const parcel = Schema.decodeUnknownOption(Schema.fromJsonString(Parcel))(body)
      if (Option.isNone(parcel)) return refuse(path, auth.peer, "not a parcel", 400)
      return json(await run(handlers.receive(auth.peer, parcel.value)))
    }
    return json({ reason: `no route ${path}` }, 404)
  }
}

/**
 * Listen on `listen` until the scope closes, binding as soon as the port is
 * free, and record the address in the pairing state. A wildcard address is
 * refused and logged: nothing listens.
 */
export const serve = (listen: Listen, handlers: Handlers, keyed: Keyed, secret: () => string): Effect.Effect<void, never, PairStore | Scope.Scope> =>
  Effect.gen(function* () {
    if (isWildcard(listen.hostname))
      return yield* Effect.logError(`mail listener: refusing to listen on ${JSON.stringify(listen.hostname)}, every interface; give one address (the host's Tailscale address)`)
    const context = yield* Effect.context<PairStore>()
    const answer = handler(handlers, keyed, secret, context)
    const bind = Effect.try({
      try: () =>
        Bun.serve({
          hostname: listen.hostname,
          port: listen.port,
          fetch: (request, server) => answer(request, server.requestIP(request)?.address),
        }),
      catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
    })
    const server = yield* Effect.acquireRelease(
      bind.pipe(
        Effect.tapError((message) => Effect.logDebug(`mail listener: ${urlOf(listen.hostname, listen.port)} not bound (${message}); trying again`)),
        Effect.retry(Schedule.spaced(RETRY)),
        Effect.orDie,
      ),
      (bound) => Effect.sync(() => void bound.stop(true)),
      // Other locations may own this port indefinitely. A reload must be able
      // to cancel the retry wait before this instance acquires a listener.
      { interruptible: true },
    )
    const url = urlOf(listen.hostname, server.port ?? listen.port)
    const store = yield* PairStore
    yield* store.update((pairs) => [undefined, { ...pairs, url }]).pipe(Effect.ignore)
    yield* Effect.logInfo(`mail listener: listening on ${url}`)
  })
