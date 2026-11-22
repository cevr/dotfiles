// The peers' live edges: where each named peer is on the tailnet now (Tailscale's own status, never DNS), and one
// GET of a peer's page, cut off at PEER_TIMEOUT by the fetch itself so no socket outlives the read.
import { Duration, Effect, Option } from "effect"
import type { Got } from "../http/peers.ts"
import { type NamedPeer, PEER_TIMEOUT, type Target, targetOf } from "../peers.ts"
import { peerHosts } from "./tailnet.ts"

/** The named peers Tailscale lists now, by name, at `port`. */
export const locate = (named: ReadonlyArray<NamedPeer>, port: number): Effect.Effect<ReadonlyMap<string, Target>> =>
  Effect.map(peerHosts, (hosts) => new Map(named.flatMap((each) => Option.toArray(targetOf(each, hosts, port)).map((target): readonly [string, Target] => [each.name, target]))))

/** One GET of `url`: no redirect followed, no credential sent. */
export const get = (url: string): Effect.Effect<Got, unknown> =>
  Effect.tryPromise(() =>
    fetch(url, { redirect: "manual", credentials: "omit", signal: AbortSignal.timeout(Duration.toMillis(PEER_TIMEOUT)) }).then((response) =>
      response.text().then((body) => ({ status: response.status, body })),
    ),
  )
