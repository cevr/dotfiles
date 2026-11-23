// The peers' live edge: one GET of a peer's page, cut off at PEER_TIMEOUT by the fetch itself so no socket outlives
// the read. Where each peer is comes from the plugin's own status reads and device store (peers.ts `locateIn`).
import { Duration, Effect } from "effect"
import type { Got } from "../http/peers.ts"
import { PEER_TIMEOUT } from "../peers.ts"

/** One GET of `url`: no redirect followed, no credential sent. */
export const get = (url: string): Effect.Effect<Got, unknown> =>
  Effect.tryPromise(() =>
    fetch(url, { redirect: "manual", credentials: "omit", signal: AbortSignal.timeout(Duration.toMillis(PEER_TIMEOUT)) }).then((response) =>
      response.text().then((body) => ({ status: response.status, body })),
    ),
  )
