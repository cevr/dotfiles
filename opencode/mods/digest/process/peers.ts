// The peers' live edge: one GET of a peer's page, cut off at PEER_TIMEOUT, whose interruption aborts the request so no
// socket outlives the read. Where each peer is comes from the plugin's own status reads and device store (peers.ts
// `locateIn`).
import { Effect } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import type { Got } from "../http/peers.ts"
import { PEER_TIMEOUT } from "../peers.ts"

/** One GET of `url`: no redirect followed, no credential sent. */
export const get = (url: string): Effect.Effect<Got, unknown> =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap((client) => client.get(url)),
    Effect.flatMap((response) => Effect.map(response.text, (body): Got => ({ status: response.status, body }))),
    Effect.timeout(PEER_TIMEOUT),
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual", credentials: "omit" }),
  )
