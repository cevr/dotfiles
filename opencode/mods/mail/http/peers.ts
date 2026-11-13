// The paired hosts over HTTP: each request goes to the peer's mail listener at
// the address it gave at pairing, signed with the secret both hold (pairing.ts
// `sign`). A peer that does not answer in time, refuses the request or answers
// something that is not mail's is unreachable.
//
// The network is the `Net` service: `liveNet` is the real one (Bun's server,
// fetch), a memory one (memory/net.ts) the simulated hosts'.
import { Clock, Effect, Layer, Option, Schema } from "effect"
import { type Keyed, sign } from "../pairing.ts"
import { Arrival, Cards, ROUTES } from "../peer.ts"
import { Net, NetFailed, PairStore, Peers, PeerUnreachable, Tokens, type Wire } from "../service.ts"
import { bunListen } from "./listener.ts"

/** How long a peer has to answer. */
export const TIMEOUT_MS = 10_000

const reasonOf = (text: string): string => {
  try {
    const body: unknown = JSON.parse(text)
    if (typeof body === "object" && body !== null && "reason" in body && typeof body.reason === "string") return body.reason
  } catch {}
  return text.trim().slice(0, 200)
}

const decodeCards = Schema.decodeUnknownOption(Schema.fromJsonString(Cards))
const decodeArrival = Schema.decodeUnknownOption(Schema.fromJsonString(Arrival))

/** The real network's POST: fetch, given up after `timeoutMs`. */
export const fetchPost = (url: string, request: { readonly headers: Readonly<Record<string, string>>; readonly body: string }, timeoutMs: number) =>
  Effect.tryPromise({
    try: async (): Promise<Wire> => {
      const response = await fetch(url, {
        method: "POST",
        headers: { ...request.headers, "content-type": "application/json" },
        body: request.body,
        signal: AbortSignal.timeout(timeoutMs),
      })
      return { status: response.status, body: await response.text() }
    },
    catch: (cause) => new NetFailed({ message: cause instanceof Error ? cause.message : String(cause) }),
  })

/** The real network: Bun's server for a listener, fetch for a request. */
export const realNet = Net.of({ listen: bunListen, post: fetchPost })
export const liveNet = Layer.succeed(Net, realNet)

export const layer = (keyed: Keyed, timeoutMs = TIMEOUT_MS) =>
  Layer.effect(
    Peers,
    Effect.gen(function* () {
      const store = yield* PairStore
      const net = yield* Net
      const tokens = yield* Tokens

      const call = Effect.fn("Peers.call")(function* <A>(peer: string, route: string, input: unknown, decode: (text: string) => Option.Option<A>) {
        yield* Effect.annotateCurrentSpan({ peer, route })
        const pairs = yield* store.read
        const entry = Object.hasOwn(pairs.peers, peer) ? pairs.peers[peer] : undefined
        if (entry === undefined || pairs.name === undefined) return yield* new PeerUnreachable({ peer, message: "not paired with this host" })
        const body = JSON.stringify(input)
        const headers = sign(pairs.name, entry.secret, { method: "POST", path: route, body }, yield* Clock.currentTimeMillis, yield* tokens.token(16), keyed)
        const reply = yield* net
          .post(new URL(route, entry.url).href, { headers, body }, timeoutMs)
          .pipe(Effect.mapError((failure) => new PeerUnreachable({ peer, message: `${entry.url} did not answer: ${failure.message}` })))
        if (reply.status !== 200) return yield* new PeerUnreachable({ peer, message: `it answered ${reply.status}: ${reasonOf(reply.body)}` })
        const decoded = decode(reply.body)
        if (Option.isNone(decoded)) return yield* new PeerUnreachable({ peer, message: "its answer is not mail's" })
        return decoded.value
      })

      return Peers.of({
        names: store.read.pipe(Effect.map((pairs) => Object.keys(pairs.peers).toSorted())),
        sessions: (peer, scope) => call(peer, ROUTES.list, scope, decodeCards),
        deliver: (peer, parcel) => call(peer, ROUTES.receive, parcel, decodeArrival),
      })
    }),
  )
