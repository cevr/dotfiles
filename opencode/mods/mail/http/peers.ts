// The paired hosts over HTTP: each request goes to the peer's mail listener at
// the address it gave at pairing, signed with the secret both hold (pairing.ts
// `sign`). A peer that does not answer in time, refuses the request or answers
// something that is not mail's is unreachable.
import { Clock, Effect, Layer, Option, Schema } from "effect"
import { type Keyed, sign } from "../pairing.ts"
import { Arrival, Cards, ROUTES } from "../peer.ts"
import { PairStore, Peers, PeerUnreachable } from "../service.ts"

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

export const layer = (keyed: Keyed, nonce: () => string, timeoutMs = TIMEOUT_MS) =>
  Layer.effect(
    Peers,
    Effect.gen(function* () {
      const store = yield* PairStore

      const call = <A>(peer: string, route: string, input: unknown, decode: (text: string) => Option.Option<A>) =>
        Effect.gen(function* () {
          const pairs = yield* store.read
          const entry = Object.hasOwn(pairs.peers, peer) ? pairs.peers[peer] : undefined
          if (entry === undefined || pairs.name === undefined) return yield* new PeerUnreachable({ peer, message: "not paired with this host" })
          const body = JSON.stringify(input)
          const headers = sign(pairs.name, entry.secret, { method: "POST", path: route, body }, yield* Clock.currentTimeMillis, nonce(), keyed)
          const reply = yield* Effect.tryPromise({
            try: async () => {
              const response = await fetch(new URL(route, entry.url), {
                method: "POST",
                headers: { ...headers, "content-type": "application/json" },
                body,
                signal: AbortSignal.timeout(timeoutMs),
              })
              return { status: response.status, text: await response.text() }
            },
            catch: (cause) => new PeerUnreachable({ peer, message: `${entry.url} did not answer: ${cause instanceof Error ? cause.message : String(cause)}` }),
          })
          if (reply.status !== 200) return yield* new PeerUnreachable({ peer, message: `it answered ${reply.status}: ${reasonOf(reply.text)}` })
          const decoded = decode(reply.text)
          if (Option.isNone(decoded)) return yield* new PeerUnreachable({ peer, message: "its answer is not mail's" })
          return decoded.value
        }).pipe(Effect.withSpan("Peers.call", { attributes: { peer, route } }))

      return Peers.of({
        names: store.read.pipe(Effect.map((pairs) => Object.keys(pairs.peers).toSorted())),
        sessions: (peer, scope) => call(peer, ROUTES.list, scope, decodeCards),
        deliver: (peer, parcel) => call(peer, ROUTES.receive, parcel, decodeArrival),
      })
    }),
  )
