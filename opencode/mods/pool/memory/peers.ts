// The fleet's peers held in memory: each peer's report, or why it cannot be
// read, by name. The plugin's seam tests change an answer between polls. A
// claim forwarded to a peer goes to `claims` (a two-host test hands it to the
// other host's pool); a peer with none cannot be reached for it.
import { Effect, Layer } from "effect"
import type { ClaimAnswer } from "../quota.ts"
import type { ForwardedClaim } from "../resets.ts"
import { Peers, PeerUnreachable } from "../service.ts"
import type { Report } from "../status.ts"

/** A peer's answer: its report, or the message it cannot be read with. */
export type Answer = Report | { readonly down: string }

/** What a peer does with a claim forwarded to it. */
export type Claims = (peer: string, claim: ForwardedClaim) => Effect.Effect<ClaimAnswer, PeerUnreachable>

export const layer = (answers: ReadonlyMap<string, Answer>, claims?: Claims) =>
  Layer.succeed(Peers, {
    names: [...answers.keys()],
    report: (peer: string) =>
      Effect.suspend(() => {
        const answer = answers.get(peer)
        if (answer === undefined) return Effect.fail(new PeerUnreachable({ peer, message: "not a peer" }))
        return "down" in answer ? Effect.fail(new PeerUnreachable({ peer, message: answer.down })) : Effect.succeed(answer)
      }),
    claim: (peer: string, claim: ForwardedClaim) =>
      Effect.suspend(() =>
        claims === undefined || !answers.has(peer) ? Effect.fail(new PeerUnreachable({ peer, message: "takes no claims" })) : claims(peer, claim),
      ),
  })
